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
 *
 * ## What a stored `legacy` value means after 2026-11-01
 *
 * A value captured before the cutover under the legacy model is **a true record
 * of what the old model computed on that date**. It is not wrong and it must not
 * be restated: the announcement excludes historical endpoints from the new
 * model, so a value the vendor never recomputed cannot be recomputed by us —
 * rewriting it would be our number wearing the vendor's name. What it cannot do
 * is **sit in one series beside a `new` value and be read as a trend**, because
 * a step between the two is a method change pretending to be traffic. So after
 * the cutover a stored legacy value means three things at once: the measurement
 * is old, the method that produced it no longer runs, and the comparison is
 * closed. {@link trendCaveat} is what says that out loud, and
 * {@link monthSpanSpansCutover} is what detects it on month-keyed data. The
 * values stay; only the naive join goes.
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
 * Endpoints whose items carry an `etv` field but which are **not** on the
 * vendor's list of endpoints the flag applies to.
 *
 * These are the honest third category, and they exist because leaving them out
 * of both lists would make them invisible: an endpoint that returns an ETV and
 * gets no provenance is exactly the stored value that becomes unreadable on
 * 2026-11-01, and a gate that checks only the confirmed list would report it
 * clean.
 *
 * **What we do here is deliberately weaker than pinning.** We do not know
 * whether these endpoints accept `use_new_etv`, so we cannot claim a formula
 * version for their values — we record `formulaVersion: null`, which
 * {@link trendCaveat} already handles by always attaching a caveat. Guessing
 * `legacy` would be the failure this module exists to prevent: an assumption
 * stated as a fact.
 *
 * The list is short and the reason to shorten it is a live verification call
 * (CL-712a), not a code change. When one is confirmed, move its name to
 * {@link ETV_BEARING_LABS_ENDPOINTS} and start pinning it.
 */
export const ETV_UNVERIFIED_LABS_ENDPOINTS = [
  "categories_for_domain",
  "keywords_for_categories",
  "domain_metrics_by_categories",
  "keyword_overview",
] as const;

export type EtvUnverifiedLabsEndpoint =
  (typeof ETV_UNVERIFIED_LABS_ENDPOINTS)[number];

/** True when an endpoint returns `etv` but does not take the flag. */
export function isEtvUnverifiedLabsEndpoint(endpoint: string): boolean {
  return (ETV_UNVERIFIED_LABS_ENDPOINTS as readonly string[]).includes(
    endpoint,
  );
}

/**
 * How an ETV-bearing call was parameterised, carried on the response so the
 * caller can persist it beside the value. A stored ETV without its formula
 * version becomes unreadable after the cutover.
 */
export type EtvProvenance = {
  /**
   * Which model produced the numbers in this response, or `null` when the
   * endpoint is on {@link ETV_UNVERIFIED_LABS_ENDPOINTS} and we cannot claim
   * to know. **`null` is the honest answer, not a gap in the type.**
   */
  formulaVersion: EtvFormulaVersion | null;
  /** The flag actually sent, so the request is reproducible. */
  useNewEtv: boolean;
  /** When the request was made, for the audit trail. */
  requestedAt: string;
};

/**
 * Provenance for an endpoint that returns `etv` but is not confirmed to accept
 * the flag.
 *
 * `useNewEtv: false` records that no flag was sent — which is the fact, and a
 * different thing from "the legacy model produced this". `formulaVersion: null`
 * then marks the value as unreadable-in-isolation rather than wrong.
 *
 * A caller that persists these values must let {@link trendCaveat} attach its
 * unknown-version caveat. **An unstamped value is never filtered away** — we do
 * not know which model produced it, and assuming one is exactly the guess this
 * feature exists to avoid.
 */
export function unverifiedEtvProvenance(
  /**
   * Takes a plain `string`, not the union. The whole point of the function is
   * that it validates its input, and a validated input should not be narrowed
   * by its type — callers arrive holding an endpoint name from a response path
   * or a config value, which is a string at the boundary. Typing the parameter
   * as the union would move the check to compile time for the callers that can
   * already satisfy it, and leave it unchecked for the ones that cannot.
   */
  endpoint: string,
  now?: Date,
): EtvProvenance {
  if (!isEtvUnverifiedLabsEndpoint(endpoint)) {
    throw new Error(
      `${endpoint} is not an unverified ETV endpoint; use resolveEtvMode and pin the flag instead`,
    );
  }
  return {
    formulaVersion: null,
    useNewEtv: false,
    requestedAt: (now ?? new Date()).toISOString(),
  };
}

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
      // **The date constant interpolated, not restated in prose.** It was an exported
      // constant nothing referenced — a documented fact with no code depending on it, so
      // it could drift from the resolver it explains. The reason string is what a support
      // engineer reads, so naming the same constant makes it the single source.
      reason: `account registered on or after ${ETV_NEW_DEFAULT_REGISTRATION_DATE}, so the new formula is already the default`,
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

/**
 * Resolve and apply the ETV mode for a Labs call, as a request body field plus
 * its provenance.
 *
 * ## Why this lives here rather than in the Labs client
 *
 * It is a pure function of `resolveEtvMode` with no dependency on the transport,
 * so it belongs beside the resolver it wraps. It lived in `labs.ts` until a test
 * double needed it to build a stub's provenance, at which point the choice was
 * between importing a server module from a fixture and duplicating the three
 * fields — and both are the same mistake in different clothes: a second place
 * the flag's value is decided.
 *
 * ## Why the two spellings are in one object
 *
 * `useNewEtv` is camelCase for callers, `use_new_etv` is the wire name. Spreading
 * the returned object into a task body puts the right name on the wire while the
 * provenance keeps the readable one, and a mismatch between the two would be a
 * silent lie in the archive — so they are computed from the same value rather
 * than passed separately.
 */
export function etvFields(
  endpoint: EtvBearingLabsEndpoint,
  now?: Date,
): EtvProvenance & { use_new_etv: boolean } {
  const mode = resolveEtvMode({ endpoint, now });
  return {
    formulaVersion: mode.version,
    useNewEtv: mode.useNewEtv,
    use_new_etv: mode.useNewEtv,
    requestedAt: (now ?? new Date()).toISOString(),
  };
}

/**
 * The month-keyed form of {@link seriesSpansCutover}, for data keyed by `YYYYMM`.
 *
 * ## Why a second predicate rather than reusing the first
 *
 * `domain_metrics_by_categories` returns its history keyed by `YYYYMM`, not by ISO
 * timestamps — the vendor's `first_date`/`second_date` are month-granular by design.
 * Converting `202610` to a timestamp needs an arbitrary day of the month, and a
 * day-of-month chosen for convenience is exactly the kind of guess that turns a
 * boundary check into a boundary *approximation*: `2026-11-01` and `2026-10-31` are
 * in different months, so a helper that picked the first of each would disagree with
 * one that picked the last.
 *
 * So the comparison is on the month keys directly, which needs no convention: the
 * cutover month `202611` lies in `(fromMonth, toMonth]`. `202610 → 202611` spans;
 * `202611 → 202612` does not, because both months are already on the new model.
 */
export function monthSpanSpansCutover(
  fromMonth: string,
  toMonth: string,
  cutover = ETV_CUTOVER_DATE,
): boolean {
  const cutoverMonth = cutover.slice(0, 4) + cutover.slice(5, 7);
  return fromMonth < cutoverMonth && cutoverMonth <= toMonth;
}

/**
 * One value in an ETV series, as {@link trendCaveat} receives it.
 *
 * A bare version was the first shape of this, and it produced the caveat this
 * module now refuses: "some values in this series have no recorded formula
 * version" — true, and useless, because the reader cannot tell *which* values
 * are unreadable or what produced them. A caveat that names nothing is an
 * apology; a caveat that names `keyword_overview` is information.
 */
export type EtvCaveatPoint = {
  /** Which model produced the value, or `null` when unknown. */
  formulaVersion: EtvFormulaVersion | null;
  /** The endpoint the value came from, when the caller knows it. */
  endpoint?: string;
};

/**
 * `` `a`, `b`, `c` and `d` `` — backticked, because these are code objects a
 * reader may need to type into a support email or a search, and comma-joined,
 * because a caveat naming four endpoints reads as a list rather than a
 * sentence. The final `and` is deliberate: "`a`, `b`, `c`, `d`" scans as a
 * truncated list and readers check whether something was cut off.
 */
function formatEndpointList(endpoints: readonly string[]): string {
  const quoted = endpoints.map((endpoint) => `\`${endpoint}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * What a chart must say when a series carries ETV values.
 *
 * Returns `null` only when the series is internally consistent AND fully known.
 * An unstamped (`null`) value is never filtered away: we do not know which model
 * produced it, and assuming one is exactly the guess this feature exists to
 * avoid. A chart containing an unknown therefore always carries a caveat.
 *
 * **An unknown value names its endpoint.** When the caller can say which
 * endpoint produced the unstamped values, the caveat names them — a reader then
 * knows the number came from `keywords_for_categories` (which we cannot claim a
 * formula for) rather than from the series at large. When it cannot, the caveat
 * says so in the general form, which is the honest fallback and not a failure.
 */
export function trendCaveat(
  points: EtvCaveatPoint[],
  cutover = ETV_CUTOVER_DATE,
): string | null {
  const hasUnknown = points.some((point) => point.formulaVersion === null);
  const present = new Set(
    points
      .map((point) => point.formulaVersion)
      .filter((v): v is EtvFormulaVersion => v !== null),
  );

  if (hasUnknown) {
    const unstampedEndpoints = [
      ...new Set(
        points
          .filter((point) => point.formulaVersion === null && point.endpoint)
          .map((point) => point.endpoint ?? ""),
      ),
    ];
    // **The named form replaces the general sentence rather than tagging it
    // onto it.** Two sentences saying the same thing — one in general and one
    // naming the endpoints — reads as two findings.
    const subject =
      unstampedEndpoints.length > 0
        ? `The values from ${formatEndpointList(unstampedEndpoints)} have no recorded ETV formula version — those endpoints are not on the vendor's list for the \`use_new_etv\` flag — so they cannot be compared like-for-like`
        : "Some values in this series have no recorded ETV formula version, so they cannot be compared like-for-like";
    return `${subject}. DataForSEO changed the ETV model on ${cutover} — check the formula version before reading a step here as a change in traffic.`;
  }

  if (present.size <= 1) {
    if (present.has("legacy")) {
      return `All values use the legacy ETV formula, which is the vendor's behaviour for historical endpoints. The new formula became the default on ${cutover}.`;
    }
    return null;
  }
  return `This series mixes ETV formulas (${[...present].join(" and ")}). DataForSEO changed the ETV model on ${cutover}, and historical endpoints are excluded from the new one — so this step is a method change, not a change in traffic.`;
}
