import { describe, expect, it } from "vitest";
import {
  ETV_BEARING_LABS_ENDPOINTS,
  ETV_CUTOVER_DATE,
  ETV_NEW_DEFAULT_REGISTRATION_DATE,
  HISTORICAL_LABS_ENDPOINTS,
  isHistoricalLabsEndpoint,
  resolveEtvMode,
  seriesSpansCutover,
  trendCaveat,
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

describe("detecting a series that crosses the cutover", () => {
  it("is false for a series entirely on one side", () => {
    expect(
      seriesSpansCutover(["2026-01-01T00:00:00Z", "2026-10-01T00:00:00Z"]),
    ).toBe(false);
    expect(
      seriesSpansCutover(["2026-11-02T00:00:00Z", "2026-12-01T00:00:00Z"]),
    ).toBe(false);
  });

  it("is true when the series straddles the boundary", () => {
    expect(
      seriesSpansCutover(["2026-10-31T00:00:00Z", "2026-11-02T00:00:00Z"]),
    ).toBe(true);
  });

  it("uses the documented cutover date, not a clock", () => {
    // A test that read the system clock would pass or fail depending on when it
    // ran. The constant is the contract.
    expect(ETV_CUTOVER_DATE).toBe("2026-11-01");
    expect(ETV_NEW_DEFAULT_REGISTRATION_DATE).toBe("2026-09-01");
  });
});

describe("the caveat a chart must carry", () => {
  it("says nothing extra for a single-formula series", () => {
    expect(trendCaveat(["new", "new", "new"])).toBeNull();
  });

  it("explains a legacy series so a reader knows which model produced it", () => {
    const caveat = trendCaveat(["legacy", "legacy"]);
    expect(caveat).toMatch(/legacy ETV formula/);
  });

  it("refuses to let a mixed series read as a clean trend", () => {
    // This is the whole product claim. A chart that mixes formulas and says
    // nothing is worse than no chart, because the step looks like real growth.
    const caveat = trendCaveat(["legacy", "new"]);
    expect(caveat).toMatch(/mixes ETV formulas/);
    expect(caveat).toMatch(/not a change in traffic/);
    expect(caveat).toMatch(/2026-11-01/);
  });

  it("refuses to let an unstamped value pass as a known formula", () => {
    // null means "we do not know". Filtering it out would collapse unknown into
    // legacy and report a single-formula series — a guess presented as a fact,
    // which is precisely the failure we are marketing against.
    const caveat = trendCaveat(["legacy", null]);
    expect(caveat).toMatch(/no recorded ETV formula version/);
    expect(caveat).not.toMatch(/All values use the legacy/);
  });
});
