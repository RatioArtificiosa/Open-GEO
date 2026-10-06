import { describe, expect, it } from "vitest";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";
import {
  keywordsPerTaskFor,
  sharedKeywordsPerTask,
  VOLUME_SOURCES,
} from "@/shared/volume-routing";
import { estimateCost } from "@/shared/dataforseo-pricing";

/** Requests for a pull, the arithmetic every caller does. */
function requestsFor(keywords: number, perTask: number): number {
  return Math.ceil(keywords / perTask);
}

describe("volume source caps", () => {
  it("pins the documented caps, so changing one is deliberate", () => {
    // `keyword_overview` at 700 rather than the 1,000 every neighbouring source
    // takes is the whole reason this table exists. A pin here means raising it
    // requires deleting an assertion that names its source page.
    expect(keywordsPerTaskFor("google_ads")).toBe(1000);
    expect(keywordsPerTaskFor("labs_keyword_overview")).toBe(700);
    expect(keywordsPerTaskFor("bing_ads")).toBe(200);
    // The clickstream pair are arbitration endpoints, and their 1,000 is the cap on a
    // *sample* — see the role tests below.
    expect(keywordsPerTaskFor("clickstream_global")).toBe(1000);
    expect(keywordsPerTaskFor("clickstream_dfs")).toBe(1000);
  });

  it("gives every source a positive cap and a source a reader can check", () => {
    // A routing table with an empty entry enforces nothing and looks identical to a
    // working one — the same reason `limits.ts` pins its own table.
    for (const source of Object.values(VOLUME_SOURCES)) {
      expect(source.keywordsPerTask).toBeGreaterThan(0);
      expect(Number.isInteger(source.keywordsPerTask)).toBe(true);
      expect(source.capSource.length).toBeGreaterThan(40);
    }
  });

  it("reads its prices from the price book rather than restating them", () => {
    // Identity, not equality: a price change in one place cannot leave this table
    // quoting the old number.
    expect(VOLUME_SOURCES.google_ads.price).toBe(
      DFS_KEYWORDS.googleAds.standard,
    );
    expect(VOLUME_SOURCES.bing_ads.price).toBe(DFS_KEYWORDS.bingAds.standard);
  });
});

describe("batching across sources", () => {
  it("lets a Google Ads-only pull use the full thousand", () => {
    // **The fix.** Batched at the family's 700, this pull cost two tasks where one
    // is enough — silently, because two correct calls look exactly like one.
    expect(sharedKeywordsPerTask(["google_ads"])).toEqual({
      keywordsPerTask: 1000,
      limitingSource: "google_ads",
    });
    expect(requestsFor(1000, keywordsPerTaskFor("google_ads"))).toBe(1);
    expect(requestsFor(1001, keywordsPerTaskFor("google_ads"))).toBe(2);
  });

  it("bounds a slice sent to two endpoints by the stricter cap", () => {
    // The local path calls Ads *and* Labs with the same slice. Sizing it by Ads
    // would send Labs 1,000 keywords — over its documented cap, and the vendor bills
    // a task that fails.
    const shared = sharedKeywordsPerTask([
      "google_ads",
      "labs_keyword_overview",
    ]);
    expect(shared.keywordsPerTask).toBe(700);
    expect(shared.limitingSource).toBe("labs_keyword_overview");
  });

  it("never exceeds any member's cap, whatever order they are given in", () => {
    const orders = [
      ["google_ads", "labs_keyword_overview"],
      ["labs_keyword_overview", "google_ads"],
      ["google_ads", "bing_ads"],
      ["bing_ads", "google_ads", "labs_keyword_overview"],
    ] as const;

    for (const sources of orders) {
      const { keywordsPerTask } = sharedKeywordsPerTask([...sources]);
      for (const source of sources) {
        expect(keywordsPerTask).toBeLessThanOrEqual(keywordsPerTaskFor(source));
      }
    }
  });

  it("falls back to a single source rather than to nothing", () => {
    // An empty list must not produce `Infinity`, `NaN` or a zero batch: a plan with
    // no source is a misconfiguration, and the safe direction is the conservative
    // single source rather than a slice of every keyword at once.
    expect(sharedKeywordsPerTask([]).keywordsPerTask).toBe(1000);
  });
});

describe("the cost comparison, as arithmetic", () => {
  it("prices a 1,000-keyword pull at $0.06 on Google Ads", () => {
    const cost = estimateCost({
      price: VOLUME_SOURCES.google_ads.price,
      requests: requestsFor(1000, keywordsPerTaskFor("google_ads")),
    });
    expect(cost.totalUsd).toBe(0.06);
  });

  it("prices the same pull at $0.30 on Bing, which is why nothing routes there", () => {
    // The checklist's claim — "never route 1,000 keywords via Bing" — as a number
    // computed from the two prices rather than asserted in prose.
    const bing = estimateCost({
      price: VOLUME_SOURCES.bing_ads.price,
      requests: requestsFor(1000, keywordsPerTaskFor("bing_ads")),
    });
    expect(bing.totalUsd).toBe(0.3);
    expect(bing.totalUsd / 0.06).toBe(5);
  });

  it("shows the Labs route costing more per request than Ads, and why it is still the one for KD", () => {
    // Labs is $0.012 a request against Ads' $0.06, so the *batch size* is not what
    // makes Labs the cheap route — it is the per-endpoint fields. Recorded so the
    // next reader does not "optimise" the route on request price alone.
    const labs = estimateCost({
      price: VOLUME_SOURCES.labs_keyword_overview.price,
      requests: requestsFor(1000, keywordsPerTaskFor("labs_keyword_overview")),
    });
    expect(labs.totalUsd).toBe(0.024);
    expect(labs.totalUsd).toBeLessThan(0.06);
  });
});

describe("arbitration is not a volume source", () => {
  it("marks both $0.18 clickstream endpoints as arbitration", () => {
    // Verified from the Clickstream Data API overview, 2026-10-06: **all three**
    // endpoints take up to 1,000 keywords per call, and the API is Live only. Here the
    // 1,000 is the cap on a *sample*, not on a corpus.
    expect(VOLUME_SOURCES.clickstream_global.role).toBe("arbitration");
    expect(VOLUME_SOURCES.clickstream_dfs.role).toBe("arbitration");
    expect(VOLUME_SOURCES.google_ads.role).toBe("volume");
    expect(VOLUME_SOURCES.labs_keyword_overview.role).toBe("volume");
  });

  it("will not let an arbitration endpoint size a batch, in either direction", () => {
    // Alone: the conservative default, rather than a cap from an endpoint that was
    // never going to fetch anything.
    expect(sharedKeywordsPerTask(["clickstream_global"])).toEqual({
      keywordsPerTask: 1000,
      limitingSource: "google_ads",
    });
    // Alongside real sources: dropped, so the real cap still governs the slice.
    expect(
      sharedKeywordsPerTask(["clickstream_dfs", "labs_keyword_overview"]),
    ).toEqual({
      keywordsPerTask: 700,
      limitingSource: "labs_keyword_overview",
    });
  });

  it("costs three times the pull it corrects, which is the entire policy", () => {
    // $0.18 a call against Google Ads' $0.06 for the same 1,000 keywords. The fee is
    // per *call* rather than per keyword, so the sample size is not the cost lever —
    // the number of calls is. That is why these settle a sample (CL-407's "Data
    // Honesty" reconciliation) and never a corpus fetch, and why they are marked
    // `arbitration` rather than listed as a cheaper alternative.
    const arbitration = estimateCost({
      price: VOLUME_SOURCES.clickstream_global.price,
      requests: 1,
    });
    expect(arbitration.totalUsd).toBe(0.18);
    expect(arbitration.totalUsd / 0.06).toBe(3);
  });
});
