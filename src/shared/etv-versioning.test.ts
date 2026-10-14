import { describe, expect, it } from "vitest";
import {
  ETV_CUTOVER_DATE,
  ETV_NEW_DEFAULT_REGISTRATION_DATE,
  HISTORICAL_LABS_ENDPOINTS,
  ETV_UNVERIFIED_LABS_ENDPOINTS,
  isHistoricalLabsEndpoint,
  resolveEtvMode,
  ETV_BEARING_LABS_ENDPOINTS,
  trendCaveat,
  type EtvCaveatPoint,
  type EtvFormulaVersion,
} from "@/shared/etv-versioning";

/**
 * The ETV formula cutover.
 *
 * The product claim is "most tools' traffic charts break silently on Nov 1; ours
 * don't". These tests are that claim. If the resolution logic regresses, a
 * user's trend line quietly mixes two models and we have shipped the exact
 * failure we advertise against.
 */

const beforeCutover = new Date("2026-10-15T00:00:00Z");
const afterCutover = new Date("2026-11-02T00:00:00Z");

describe("ETV endpoint classification", () => {
  it("treats historical endpoints as legacy-only", () => {
    expect(isHistoricalLabsEndpoint("historical_rank_overview")).toBe(true);
    expect(isHistoricalLabsEndpoint("historical_bulk_traffic_estimation")).toBe(
      true,
    );
    expect(isHistoricalLabsEndpoint("ranked_keywords")).toBe(false);
  });

  it("keeps the historical and ETV-bearing lists disjoint", () => {
    // A historical endpoint that also appeared in the versioned list would be
    // stamped `new` by a caller while the vendor still computes it as legacy.
    for (const endpoint of HISTORICAL_LABS_ENDPOINTS) {
      expect(ETV_BEARING_LABS_ENDPOINTS).not.toContain(endpoint);
    }
  });

  it("versions every ETV-bearing endpoint, not a hand-picked few", () => {
    // The whole point is that no stored ETV is unlabelled. An endpoint missing
    // from this list is a value we could persist without knowing its formula.
    expect([...ETV_BEARING_LABS_ENDPOINTS]).toContain("ranked_keywords");
    expect([...ETV_BEARING_LABS_ENDPOINTS]).toContain("domain_rank_overview");
    expect([...ETV_BEARING_LABS_ENDPOINTS]).toContain("relevant_pages");
    for (const endpoint of ETV_BEARING_LABS_ENDPOINTS) {
      const mode = resolveEtvMode({ endpoint, now: beforeCutover });
      expect(mode.version).toBe("legacy");
    }
  });
});

describe("resolving which formula a request runs under", () => {
  it("pins a historical endpoint to legacy even when the caller asks for new", () => {
    // The vendor excludes these endpoints, so a `use_new_etv: true` here would
    // be a lie. The vendor's rule wins over the caller's intent.
    const mode = resolveEtvMode({
      endpoint: "historical_bulk_traffic_estimation",
      useNewEtv: true,
      now: afterCutover,
    });
    expect(mode.version).toBe("legacy");
    expect(mode.useNewEtv).toBe(false);
  });

  it("honours an explicit opt-in on a normal endpoint", () => {
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      useNewEtv: true,
      now: beforeCutover,
    });
    expect(mode.version).toBe("new");
    expect(mode.useNewEtv).toBe(true);
  });

  it("honours an explicit opt-out, which is our transition strategy", () => {
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      useNewEtv: false,
      now: afterCutover,
    });
    expect(mode.version).toBe("legacy");
    expect(mode.useNewEtv).toBe(false);
  });

  it("treats a post-2026-09-01 account as new-model by default", () => {
    // Registering after that date means there is no legacy baseline at all.
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      accountRegisteredBeforeCutover: false,
      now: beforeCutover,
    });
    expect(mode.version).toBe("new");
  });

  it("keeps a pre-cutover account on legacy before the cutover", () => {
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      accountRegisteredBeforeCutover: true,
      now: beforeCutover,
    });
    expect(mode.version).toBe("legacy");
    expect(mode.useNewEtv).toBe(false);
  });

  it("switches a pre-cutover account to new on the cutover date", () => {
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      accountRegisteredBeforeCutover: true,
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(mode.version).toBe("new");
  });

  it("pins the flag when the registration date is unknown after the cutover", () => {
    // Without a pin, the same request would resolve differently next month, and
    // we would not be able to reproduce a stored value.
    const mode = resolveEtvMode({
      endpoint: "ranked_keywords",
      now: afterCutover,
    });
    expect(mode.version).toBe("new");
    expect(mode.useNewEtv).toBe(true);
    expect(mode.reason).toMatch(/registration date is unknown/);
  });

  it("always returns a flag, so the request is reproducible", () => {
    for (const now of [beforeCutover, afterCutover]) {
      const mode = resolveEtvMode({ endpoint: "relevant_pages", now });
      expect(typeof mode.useNewEtv).toBe("boolean");
      expect(mode.reason).toBeTruthy();
    }
  });
});

describe("the boundary constants", () => {
  it("uses the documented cutover date, not a clock", () => {
    // A test that read the system clock would pass or fail depending on when it ran. The
    // constant is the contract: a chart, a test and a support answer all agree on the day.
    expect(ETV_CUTOVER_DATE).toBe("2026-11-01");
    expect(ETV_NEW_DEFAULT_REGISTRATION_DATE).toBe("2026-09-01");
  });

  it("keeps the excluded endpoints where the resolver reads them", () => {
    // The resolver acts on these, so the list is the authority — and the price book's
    // `historicalEndpointsExcluded` references it rather than restating it, so a third
    // copy cannot drift from either.
    expect(HISTORICAL_LABS_ENDPOINTS).toContain("historical_rank_overview");
    expect(isHistoricalLabsEndpoint("bulk_traffic_estimation_history")).toBe(
      true,
    );
    // **The negative control.** Without it a resolver that excluded everything would
    // also satisfy the assertions above.
    expect(isHistoricalLabsEndpoint("ranked_keywords")).toBe(false);
  });
});

/**
 * The point shape `trendCaveat` takes: a version, and what produced it.
 *
 * Typed by the module's own exported contract rather than by hand, so a
 * signature change fails these tests at compile time instead of at an
 * assertion — the failure the repo has already produced once this week, in
 * the timeout scanner, by pinning a scanner's *output* as a fact.
 */
const point = (
  formulaVersion: EtvFormulaVersion | null,
  endpoint?: string,
): EtvCaveatPoint => ({ formulaVersion, endpoint });

describe("the caveat a chart must carry", () => {
  it("says nothing extra for a single-formula series", () => {
    expect(trendCaveat([point("new"), point("new"), point("new")])).toBeNull();
  });

  it("explains a legacy series so a reader knows which model produced it", () => {
    const caveat = trendCaveat([point("legacy"), point("legacy")]);
    expect(caveat).toMatch(/legacy ETV formula/);
  });

  it("refuses to let a mixed series read as a clean trend", () => {
    // This is the whole product claim. A chart that mixes formulas and says
    // nothing is worse than no chart, because the step looks like real growth.
    const caveat = trendCaveat([point("legacy"), point("new")]);
    expect(caveat).toMatch(/mixes ETV formulas/);
    expect(caveat).toMatch(/not a change in traffic/);
    expect(caveat).toMatch(/2026-11-01/);
  });

  it("refuses to let an unstamped value pass as a known formula", () => {
    // null means "we do not know". Filtering it out would collapse unknown into
    // legacy and report a single-formula series — a guess presented as a fact,
    // which is precisely the failure we are marketing against.
    const caveat = trendCaveat([point("legacy"), point(null)]);
    expect(caveat).toMatch(/no recorded ETV formula version/);
    expect(caveat).not.toMatch(/All values use the legacy/);
  });

  it("names each unstamped endpoint individually", () => {
    // The general form — "some values in this series" — was honest and
    // unactionable: a reader learns that something is unreadable and nothing
    // about which number to distrust or where it came from. The named form
    // reads as a finding: the value from `keywords_for_categories` is the one
    // whose formula we cannot claim.
    //
    // The loop is over the module's own list of unverified endpoints rather
    // than a literal here: a new endpoint added to that list is a new name the
    // caveat must learn, and this test fails until the loop below is satisfied.
    for (const endpoint of ETV_UNVERIFIED_LABS_ENDPOINTS) {
      const caveat = trendCaveat([point(null, endpoint)]);
      expect(caveat, `${endpoint} must be named`).toContain(`\`${endpoint}\``);
      expect(caveat).toMatch(/no recorded ETV formula version/);
      expect(caveat).toMatch(/use_new_etv/);
    }
  });

  it("names every unstamped endpoint together, deduplicated", () => {
    // Two points from the same endpoint are one unreadable producer, not two
    // findings: a caveat that names `keyword_overview` twice reads as two
    // problems and sends a reader looking for a second call site.
    const two = trendCaveat([
      point(null, "keyword_overview"),
      point(null, "keyword_overview"),
      point(null, "categories_for_domain"),
      point("legacy"),
    ]);
    expect(two?.match(/`keyword_overview`/g) ?? []).toHaveLength(1);
    expect(two).toContain("`keyword_overview` and `categories_for_domain`");

    // The join is a list, not a run-on: three or more names separate with
    // commas and read the last one with "and", so a reader can see the list is
    // complete rather than truncated mid-sentence.
    const four = trendCaveat(
      ETV_UNVERIFIED_LABS_ENDPOINTS.map((endpoint) => point(null, endpoint)),
    );
    const named = four?.match(/`[a-z_]+`/g) ?? [];
    expect(named).toHaveLength(ETV_UNVERIFIED_LABS_ENDPOINTS.length + 1); // + the flag's own mention
    expect(four).toMatch(/, `[a-z_]+` and `[a-z_]+` have no recorded/);
    expect(four).not.toMatch(/, and /);
  });

  it("keeps the general form when the caller cannot name the endpoint", () => {
    // The fallback is honest, not broken: an archive row that never stored its
    // endpoint still gets a caveat — the general one — rather than silence.
    const caveat = trendCaveat([point(null), point("legacy")]);
    expect(caveat).toMatch(/Some values in this series have no recorded/);
    expect(caveat).not.toMatch(/`/);
  });
});
