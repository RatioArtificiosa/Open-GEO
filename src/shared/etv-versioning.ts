/**
 * ETV formula versioning.
 *
 * DataForSEO is replacing the Estimated Traffic Volume model in Labs with one
 * that accounts for SERP features (AI Overviews, featured snippets, paid, local
 * packs, images, video), varies by search intent, and normalises search volume
 * with clickstream data. It becomes the **default on 2026-11-01**.
 *
 * Two facts from the vendor's announcement (verified 2026-09-28) shape this
 * module:
 *
 * 1. **Historical endpoints are excluded.** The new ETV is available "in all
 *    relevant endpoints where the `etv` field is present, *except for the ones
 *    returning historical metrics*." A historical series therefore stays on the
 *    legacy formula and cannot be restated.
 * 2. **The opt-in flag is `use_new_etv`.** The name `use_improved_etv` circulates
 *    in support-chat summaries and appears in no documentation page; sending it
 *    is a silent no-op, not an error.
 *
 * The rule this module exists to enforce: **never compute a trend across the
 * boundary without labelling it.** A step in a traffic line is usually a formula
 * change, not a change in traffic, and most tools will not tell you which.
 */

/** Which ETV model produced a value. */
export type EtvFormulaVersion = "legacy" | "new";

/**
 * The date DataForSEO flips the new formula on for everyone.
 * Stored as a constant (not computed from a clock) so a chart, a test and a
 * support answer all agree on the boundary.
 */
export const ETV_CUTOVER_DATE = "2026-11-01";

/**
 * Accounts registered on or after this date already default to the new formula
 * and never get a transition window: every value they receive is `new`, so
 * there is no legacy baseline to compare against.
 */
export const ETV_NEW_DEFAULT_REGISTRATION_DATE = "2026-09-01";

/** Endpoints that return historical metrics, and so stay on the legacy model.
 *  Kept as a plain list and consumed via `isHistoricalLabsEndpoint`, so callers
 *  pass a string and the check stays total. */
export const HISTORICAL_LABS_ENDPOINTS = [
  "historical_rank_overview",
  "historical_bulk_traffic_estimation",
  "bulk_traffic_estimation_history",
] as const;

/** True when the vendor excludes this endpoint from the new model. */
export function isHistoricalLabsEndpoint(endpoint: string): boolean {
  return (HISTORICAL_LABS_ENDPOINTS as readonly string[]).includes(endpoint);
}

/** The Labs endpoints that carry an `etv` field and therefore need versioning. */
export const ETV_BEARING_LABS_ENDPOINTS = [
  "ranked_keywords",
  "domain_rank_overview",
  "relevant_pages",
  "serp_competitors",
  "competitors_domain",
  "domain_intersection",
  "subdomains",
  "page_intersection",
] as const;

export type EtvBearingLabsEndpoint =
  (typeof ETV_BEARING_LABS_ENDPOINTS)[number];

/**
 * How an ETV-bearing call was parameterised, carried on the response so the
 * caller can persist it beside the value. A stored ETV without its formula
 * version becomes unreadable after the cutover.
 */
export type EtvProvenance = {
  /** Which model produced the numbers in this response. */
  formulaVersion: EtvFormulaVersion;
  /** The flag actually sent, so the request is reproducible. */
  useNewEtv: boolean;
  /** When the request was made, for the audit trail. */
  requestedAt: string;
};

type EtvModeInput = {
  /**
   * The Labs endpoint, used to detect the historical exclusion. Omit only when
   * the caller genuinely does not know it — the safe default is then `legacy`.
   */
  endpoint?: string;
  /**
   * Whether the account predates 2026-09-01. A pre-cutover account can still be
   * pinned to the legacy formula via the flag; a post-cutover one cannot.
   */
  accountRegisteredBeforeCutover?: boolean;
  /** What the request asked for, when a flag was sent. */
  useNewEtv?: boolean;
  /** The date the request is being made. Defaults to now. */
  now?: Date;
};

/**
 * Decide which ETV formula a request will actually run under, and stamp it.
 *
 * Returns the version **and** the flag to send, because the two must agree:
 * stamping `legacy` while sending `true` would record a lie.
 *
 * The defaults are deliberately conservative. An unknown endpoint, a missing
 * registration date, or a request after the cutover on a pre-cutover account
 * without an explicit flag all resolve to `legacy` + an explicit `false`, so the
 * stored value is comparable with the historical series we already hold.
 */
export function resolveEtvMode(input: EtvModeInput = {}): {
  version: EtvFormulaVersion;
  useNewEtv: boolean;
  /** Why this was chosen, for the support trail. */
  reason: string;
} {
  const { endpoint, accountRegisteredBeforeCutover, useNewEtv, now } = input;
  const at = now ?? new Date();

  // 1. Historical endpoints are never on the new model, whatever else is true.
  if (endpoint && isHistoricalLabsEndpoint(endpoint)) {
    return {
      version: "legacy",
      useNewEtv: false,
      reason: `${endpoint} is excluded from the new ETV model by the vendor`,
    };
  }

  // 2. An explicit flag is authoritative, and we pin it either way so the
  //    request is reproducible regardless of the vendor's default.
  if (useNewEtv === true) {
    return {
      version: "new",
      useNewEtv: true,
      reason: "caller opted in",
    };
  }
  if (useNewEtv === false) {
    return {
      version: "legacy",
      useNewEtv: false,
      reason: "caller opted out",
    };
  }

  // 3. Accounts registered from 2026-09-01 already default to the new model.
  if (accountRegisteredBeforeCutover === false) {
    return {
      version: "new",
      useNewEtv: true,
      reason:
        "account registered on or after the new-default date, so the new formula is already the default",
    };
  }

  // 4. A pre-cutover account before the cutover: the legacy default still holds.
  if (at < new Date(`${ETV_CUTOVER_DATE}T00:00:00Z`)) {
    return {
      version: "legacy",
      useNewEtv: false,
      reason:
        "before the cutover date, so the legacy formula is still the default",
    };
  }

  // 5. After the cutover on a pre-cutover account we do not know the
  //    registration date for. The vendor default is now `new`, so a request
  //    with no flag would be non-reproducible a month later. Pin it.
  return {
    version: "new",
    useNewEtv: true,
    reason:
      "after the cutover date; pinning the flag explicitly because the account registration date is unknown",
  };
}

/** True when a series spans the cutover, so a trend across it is unsound. */
export function seriesSpansCutover(
  requestedAtIso: string[],
  cutover = ETV_CUTOVER_DATE,
): boolean {
  const boundary = new Date(`${cutover}T00:00:00Z`).getTime();
  return (
    requestedAtIso.some((iso) => new Date(iso).getTime() < boundary) &&
    requestedAtIso.some((iso) => new Date(iso).getTime() >= boundary)
  );
}

/**
 * What a chart must say when a series crosses the boundary.
 *
 * Returns `null` only when the series is internally consistent AND fully known.
 * An unstamped (`null`) value is never filtered away: we do not know which model
 * produced it, and assuming one is exactly the guess this feature exists to
 * avoid. A chart containing an unknown therefore always carries a caveat.
 */
export function trendCaveat(
  versions: Array<EtvFormulaVersion | null>,
  cutover = ETV_CUTOVER_DATE,
): string | null {
  const hasUnknown = versions.some((version) => version === null);
  const present = new Set(
    versions.filter((v): v is EtvFormulaVersion => v !== null),
  );

  if (hasUnknown) {
    return `Some values in this series have no recorded ETV formula version, so they cannot be compared like-for-like. DataForSEO changed the ETV model on ${cutover} — check the formula version before reading a step here as a change in traffic.`;
  }

  if (present.size <= 1) {
    if (present.has("legacy")) {
      return `All values use the legacy ETV formula, which is the vendor's behaviour for historical endpoints. The new formula became the default on ${cutover}.`;
    }
    return null;
  }
  return `This series mixes ETV formulas (${[...present].join(" and ")}). DataForSEO changed the ETV model on ${cutover}, and historical endpoints are excluded from the new one — so this step is a method change, not a change in traffic.`;
}
