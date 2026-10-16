import {
  type CalendarDate,
  monthKey,
  parseCalendarDate,
} from "@/server/lib/calendarDate";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { type EtvProvenance, resolveEtvMode } from "@/shared/etv-versioning";

/**
 * The three missing domain-overview endpoints (CL-401 remainder).
 *
 * `domain_rank_overview`, `ranked_keywords` and `relevant_pages` exist in
 * `labs.ts` with callers; these three had no client because their signatures
 * do not match the neighbour — and that mismatch is the trap this file
 * documents at each function. Verified against the endpoint references
 * 2026-10-16 (historical_rank_overview, subdomains) and the 2026-10-06
 * browser read recorded in CL-401 (competitors_domain); a live call is still
 * the only proof of acceptance, and none of these has had one.
 *
 * All three post live with retries disabled: a billed live call the vendor
 * accepts and then drops must never be replayed.
 */

/**
 * Whole months spanned by a historical window, for the per-domain-month estimate.
 *
 * Six when both bounds are absent (the vendor's documented default window).
 * With exactly one bound, the missing side resolves against `todayYmd`:
 * the vendor defaults a missing date_from to six months back and a missing
 * date_to to today, and quoting a flat six against a caller-supplied 2020
 * bound understated the call. `todayYmd` arrives as a string (callers pass
 * the request's injected clock) so the estimator never reads one: identical
 * inputs quote identically. Without it, or on unparseable bounds, the answer
 * is the documented six rather than a billed guess.
 */
export function historicalMonthsSpanned(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  todayYmd?: string,
): number {
  if (dateFrom === undefined && dateTo === undefined) return 6;
  const fromGiven = dateFrom === undefined ? null : parseCalendarDate(dateFrom);
  const toGiven = dateTo === undefined ? null : parseCalendarDate(dateTo);
  if (dateFrom !== undefined && fromGiven === null) return 6;
  if (dateTo !== undefined && toGiven === null) return 6;
  if (fromGiven !== null && toGiven !== null) {
    // Both bounds present: a pure span, no clock involved.
    const fromKey = monthKey(fromGiven);
    const toKey = monthKey(toGiven);
    if (toKey < fromKey) return 6;
    return Math.max(toKey - fromKey + 1, 1);
  }
  // Exactly one side given: resolve the missing side against the request
  // clock, or fall back to the documented window without one.
  const today = todayYmd === undefined ? null : parseCalendarDate(todayYmd);
  if (today === null) return 6;
  const from = fromGiven ?? shiftMonths(today, -6);
  const to = toGiven ?? today;
  const fromKey = monthKey(from);
  const toKey = monthKey(to);
  if (toKey < fromKey) return 6;
  return Math.max(toKey - fromKey + 1, 1);
}

/** Shift a calendar date by whole months; the day resets, spans count months. */
function shiftMonths(date: CalendarDate, delta: number): CalendarDate {
  const key = monthKey(date) - 1 + delta;
  return { year: Math.floor(key / 12), month: (key % 12) + 1, day: 1 };
}

/**
 * Standard-Labs per-item estimate with a fail-closed ceiling.
 *
 * Most Labs endpoints bill per request plus per returned item
 * (`DFS_LABS.standard.perUnit`). A stated limit quotes exactly that many
 * items; an omitted limit quotes the family maximum (1,000 items per
 * request, per the price book) rather than zero — an estimate that
 * understates the call lets the credit gate admit what the balance cannot
 * cover. Overquoting refuses early, which is the safe direction.
 */
const STANDARD_LABS_FAMILY_MAX_ITEMS = 1000;

export function standardLabsItemEstimate(limit?: number): number {
  const units =
    limit === undefined || !Number.isFinite(limit)
      ? STANDARD_LABS_FAMILY_MAX_ITEMS
      : Math.max(Math.floor(limit), 1);
  return DFS_LABS.standard.perRequest + DFS_LABS.standard.perUnit * units;
}

function requireTarget(target: string, endpoint: string): void {
  if (target.trim().length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${endpoint} needs a target domain; the vendor requires it and an empty request is a billed rejection`,
    );
  }
}

function requireOneOfPair(
  values: readonly (string | number | null | undefined)[],
  label: string,
  endpoint: string,
): void {
  const present = values.some(
    (value) =>
      value !== null && value !== undefined && String(value).trim().length > 0,
  );
  if (!present) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${endpoint} needs ${label}: one of the pair is required and an empty request is a billed rejection`,
    );
  }
}

function assertDate(
  label: string,
  value: string | undefined,
  endpoint: string,
): void {
  if (value === undefined) return;
  if (parseCalendarDate(value) === null) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} must be a real calendar date in yyyy-mm-dd format, got "${value}" (${endpoint})`,
    );
  }
}

/**
 * Reversed ranges are refused before the vendor sees them: a range that ends
 * before it starts bills a rejection the envelope reader cannot classify.
 */
function assertDateRange(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  endpoint: string,
): void {
  if (dateFrom === undefined || dateTo === undefined) return;
  const from = parseCalendarDate(dateFrom);
  const to = parseCalendarDate(dateTo);
  if (
    from !== null &&
    to !== null &&
    (to.year !== from.year
      ? to.year < from.year
      : to.month !== from.month
        ? to.month < from.month
        : to.day < from.day)
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `dateFrom ${dateFrom} is after dateTo ${dateTo} (${endpoint})`,
    );
  }
}

type MetricsBlock = {
  etv?: number | null;
  count?: number | null;
  [key: string]: unknown;
};

type HistoricalMonth = {
  year?: number | null;
  month?: number | null;
  metrics?: {
    organic?: MetricsBlock | null;
    paid?: MetricsBlock | null;
  } | null;
  [key: string]: unknown;
};

/**
 * Historical rank overview: monthly rank and traffic history for a domain.
 *
 * Signature mismatches, documented so the caller does not copy a sibling:
 * location and language are each an either/or pair (code or name — the
 * neighbours take codes only); `date_from` defaults to six months back and
 * `date_to` to today; `include_clickstream_data` is deliberately not exposed
 * because it doubles the price of the request. ETV here is legacy by vendor
 * definition (historical endpoints are excluded from the new model), stamped
 * via `resolveEtvMode` rather than asserted.
 */
export async function fetchHistoricalRankOverview(input: {
  target: string;
  locationCode?: number | null;
  locationName?: string | null;
  languageCode?: string | null;
  languageName?: string | null;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  now?: Date;
}): Promise<DataforseoApiResponse<HistoricalMonth[]> & { etv: EtvProvenance }> {
  const endpoint = "historical_rank_overview";
  requireTarget(input.target, endpoint);
  requireOneOfPair(
    [input.locationCode, input.locationName],
    "location_code or location_name",
    endpoint,
  );
  requireOneOfPair(
    [input.languageCode, input.languageName],
    "language_code or language_name",
    endpoint,
  );
  assertDate("dateFrom", input.dateFrom, endpoint);
  assertDate("dateTo", input.dateTo, endpoint);
  assertDateRange(input.dateFrom, input.dateTo, endpoint);

  const mode = resolveEtvMode({ endpoint, now: input.now });
  const response = await dataforseoPost<DataforseoItemsTask<HistoricalMonth>>(
    "/v3/dataforseo_labs/google/historical_rank_overview/live",
    [
      {
        target: input.target,
        location_code: input.locationCode,
        location_name: input.locationName,
        language_code: input.languageCode,
        language_name: input.languageName,
        date_from: input.dateFrom,
        date_to: input.dateTo,
        limit: input.limit,
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
    etv: {
      formulaVersion: mode.version,
      useNewEtv: mode.useNewEtv,
      requestedAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

type SubdomainItem = {
  subdomain?: string | null;
  metrics?: {
    organic?: MetricsBlock | null;
    paid?: MetricsBlock | null;
  } | null;
  [key: string]: unknown;
};

/**
 * Subdomains of a domain with ranking distribution.
 *
 * The permissive sibling: only `target` is required — location and language
 * are all-optional (omit for all locations/languages). A caller copying the
 * historical client's required-pair validation here would refuse valid calls,
 * which is why the difference is stated rather than left to discover.
 * Carries `etv` with no confirmed flag: `formulaVersion: null`, the honest
 * answer rather than a gap in the type.
 */
export async function fetchSubdomains(input: {
  target: string;
  locationCode?: number | null;
  locationName?: string | null;
  languageCode?: string | null;
  languageName?: string | null;
  limit?: number;
  offset?: number;
  now?: Date;
}): Promise<DataforseoApiResponse<SubdomainItem[]> & { etv: EtvProvenance }> {
  const endpoint = "subdomains";
  requireTarget(input.target, endpoint);

  const response = await dataforseoPost<DataforseoItemsTask<SubdomainItem>>(
    "/v3/dataforseo_labs/google/subdomains/live",
    [
      {
        target: input.target,
        location_code: input.locationCode,
        location_name: input.locationName,
        language_code: input.languageCode,
        language_name: input.languageName,
        limit: input.limit,
        offset: input.offset,
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
    etv: {
      formulaVersion: null,
      useNewEtv: false,
      requestedAt: (input.now ?? new Date()).toISOString(),
    },
  };
}

type CompetitorDomainItem = {
  domain?: string | null;
  metrics?: {
    organic?: MetricsBlock | null;
    paid?: MetricsBlock | null;
  } | null;
  [key: string]: unknown;
};

/**
 * Competitor domains for a target.
 *
 * Requires one of each pair (location code/name, language code/name) per the
 * 2026-10-06 reference read recorded in CL-401 — stricter than the subdomains
 * sibling one line above. If the vendor has relaxed this since, it names the
 * missing field rather than billing, and the strictness here fails closed
 * (refusing a valid call) rather than open (a billed rejection). Same null
 * provenance as its sibling: `etv` without a confirmed flag.
 */
export async function fetchCompetitorsDomain(input: {
  target: string;
  locationCode?: number | null;
  locationName?: string | null;
  languageCode?: string | null;
  languageName?: string | null;
  limit?: number;
  offset?: number;
  now?: Date;
}): Promise<
  DataforseoApiResponse<CompetitorDomainItem[]> & { etv: EtvProvenance }
> {
  const endpoint = "competitors_domain";
  requireTarget(input.target, endpoint);
  requireOneOfPair(
    [input.locationCode, input.locationName],
    "location_code or location_name",
    endpoint,
  );
  requireOneOfPair(
    [input.languageCode, input.languageName],
    "language_code or language_name",
    endpoint,
  );

  const response = await dataforseoPost<
    DataforseoItemsTask<CompetitorDomainItem>
  >(
    "/v3/dataforseo_labs/google/competitors_domain/live",
    [
      {
        target: input.target,
        location_code: input.locationCode,
        location_name: input.locationName,
        language_code: input.languageCode,
        language_name: input.languageName,
        limit: input.limit,
        offset: input.offset,
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
    etv: {
      formulaVersion: null,
      useNewEtv: false,
      requestedAt: (input.now ?? new Date()).toISOString(),
    },
  };
}
