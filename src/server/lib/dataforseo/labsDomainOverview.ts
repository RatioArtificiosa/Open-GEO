import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
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

/** `yyyy-mm-dd`, the only date format these endpoints accept. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole months spanned by a historical window, for the per-domain-month estimate.
 *
 * Defaults to the vendor's six months when a bound is absent (the documented
 * default window). Pure over its inputs — the estimator that prices a call
 * must not read a clock, or identical requests would quote differently.
 */
export function historicalMonthsSpanned(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): number {
  // The vendor defaults an absent bound to six months back / today; the
  // estimate uses the same six rather than reading a clock for "today".
  if (dateFrom === undefined || dateTo === undefined) return 6;
  const fromKey =
    Number(dateFrom.slice(0, 4)) * 12 + Number(dateFrom.slice(5, 7));
  const toKey = Number(dateTo.slice(0, 4)) * 12 + Number(dateTo.slice(5, 7));
  if (!Number.isFinite(fromKey) || !Number.isFinite(toKey) || toKey < fromKey) {
    return 6;
  }
  return Math.max(toKey - fromKey + 1, 1);
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
  if (!DATE_PATTERN.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} must be in yyyy-mm-dd format, got "${value}" (${endpoint})`,
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
