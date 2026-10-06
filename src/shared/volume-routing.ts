/**
 * Which endpoint serves a volume pull and what batch it takes — as data, because
 * the caps are where the money is.
 *
 * ## The defect this exists for
 *
 * The metric path batched *every* source at **700**, because 700 is the cap on the
 * Labs endpoint it usually calls. Google Ads takes **1,000**, so a 1,000-keyword
 * Google Ads pull paid for **two tasks where one is enough** — $0.12 instead of
 * $0.06 on the Standard queue, every time, silently, because two correct calls look
 * exactly like one.
 *
 * ## Caps are per endpoint, not per family
 *
 * Verified 2026-10-06, and this is the trap: `keyword_overview`'s own reference page
 * says *"The maximum number of keywords you can specify: 700"*, while the vendor's
 * keyword-rules article gives Google Ads `search_volume` **1,000**. The price book's
 * Labs line claims *"1,000 items per request"* — true of the Labs family, **false for
 * the one endpoint we call**. A family number applied to an endpoint is how a batch
 * gets sized wrong in whichever direction is more expensive: too large is a rejection
 * **the vendor bills for**, too small is a silent double charge.
 *
 * ## When a pull feeds two endpoints, the stricter cap governs
 *
 * A local request calls Google Ads *and* Labs with the same slice. Sizing that slice
 * per source would send Labs 1,000 keywords on the local path — over its documented
 * cap, and billed. Hence `sharedKeywordsPerTask`.
 *
 * ## The $0.18 clickstream endpoints are not sources — that *is* the sampling policy
 *
 * Verified 2026-10-06 from the Clickstream Data API overview (the page failed once and
 * loaded on the second attempt — **a transient fetch is not a fact about the vendor**):
 * **all three endpoints take up to 1,000 keywords per call, and the API is Live only.**
 * `global_search_volume` and `dataforseo_search_volume` are **$0.18 a call**, so
 * arbitrating a 1,000-keyword pull costs **three times the Google Ads pull it exists to
 * correct** — and because the fee is per *call* rather than per keyword, the sample
 * size is not the cost lever, the number of calls is. Hence the policy: these settle a
 * **sample**, they are the "Data Honesty" reconciliation in **CL-407**, and they never
 * fetch a corpus. `role: "arbitration"` below is that policy as data, and
 * `sharedKeywordsPerTask` will not let one size a batch.
 *
 * ## What is deliberately not here
 *
 * **A cost-preview API.** Every number a caller would need is in the table below, and
 * the arithmetic (1,000 keywords is $0.06 on Google Ads, $0.30 on Bing, $0.18 to
 * arbitrate) is asserted in this module's tests rather than kept as an unused export.
 * When a surface wants to *show* the comparison, it is four lines on top of
 * `VOLUME_SOURCES`.
 */

import {
  DFS_KEYWORDS,
  DFS_LABS,
  type DfsPrice,
} from "@/shared/dataforseo-pricing";

type VolumeSourceId =
  | "google_ads"
  | "labs_keyword_overview"
  | "bing_ads"
  | "clickstream_global"
  | "clickstream_dfs";

/** `volume` fetches a corpus; `arbitration` settles a sample of one. */
type VolumeSourceRole = "volume" | "arbitration";

type VolumeSource = {
  id: VolumeSourceId;
  label: string;
  /** Keywords per request, as the vendor documents it for *this* endpoint. */
  keywordsPerTask: number;
  /** The queue this product buys. */
  price: DfsPrice;
  /**
   * Only a `volume` source may size a batch. An arbitration endpoint answers a
   * question *about* a pull, so letting it size one would pass its keyword cap off as
   * a fetch plan — see `sharedKeywordsPerTask`.
   */
  role: VolumeSourceRole;
  /** Where the cap comes from, in words a reader can check. */
  capSource: string;
};

/**
 * The caps, each with the page it came from.
 *
 * No entry states a *family* limit. Every one is the number on the endpoint's own
 * reference page, because that is the level at which the number binds.
 */
export const VOLUME_SOURCES: Readonly<Record<VolumeSourceId, VolumeSource>> = {
  google_ads: {
    id: "google_ads",
    label: "Google Ads",
    role: "volume",
    keywordsPerTask: 1000,
    price: DFS_KEYWORDS.googleAds.standard,
    capSource:
      "Vendor keyword-rules article, read 2026-10-06: Google Ads `search_volume` takes up to 1,000 keywords, each up to 80 characters / 10 words. Read at the endpoint, not at the family — which is the whole point of this table.",
  },
  labs_keyword_overview: {
    id: "labs_keyword_overview",
    label: "Labs keyword_overview",
    role: "volume",
    // **700, not 1,000.** The price book's Labs line says 1,000 items per request,
    // which is what a maintainer would raise this to without opening the endpoint's
    // page. The endpoint's page says 700.
    keywordsPerTask: 700,
    price: DFS_LABS.standard,
    capSource:
      'keyword_overview reference page, read 2026-10-06: "The maximum number of keywords you can specify: 700. The maximum number of characters for each keyword: 80. The maximum number of words for each keyword phrase: 10."',
  },
  bing_ads: {
    id: "bing_ads",
    label: "Bing Ads",
    role: "volume",
    keywordsPerTask: 200,
    price: DFS_KEYWORDS.bingAds.standard,
    capSource:
      "The price book's Bing row (200 keywords per task). The vendor's rules article puts the 200 cap on Bing `keywords_for_keywords` and gives Bing `search_volume` 1,000, so 200 is the conservative reading. **This product does not call Bing at all** — the entry exists so that \"why not Bing\" can be arithmetic rather than an assertion, and the arithmetic is in the tests.",
  },
  clickstream_global: {
    id: "clickstream_global",
    label: "Clickstream global",
    role: "arbitration",
    keywordsPerTask: 1000,
    price: DFS_KEYWORDS.clickstream.global,
    capSource:
      'Clickstream Data API overview, read 2026-10-06: Global Search Volume takes "up to 1000 keywords with geographical distribution across all available locations", and the API is Live only. $0.18 a call — three times the Google Ads pull it exists to correct, which is why it never sizes a batch.',
  },
  clickstream_dfs: {
    id: "clickstream_dfs",
    label: "Clickstream DataForSEO",
    role: "arbitration",
    keywordsPerTask: 1000,
    price: DFS_KEYWORDS.clickstream.dfs,
    capSource:
      'Clickstream Data API overview, read 2026-10-06: DataForSEO Search Volume provides "search volume normalized with Bing search volume data or clickstream data for up to 1000 keywords in a single request", Live only. $0.18 a call.',
  },
};

/** Keywords per request for one source. The one place a caller should ask. */
export function keywordsPerTaskFor(source: VolumeSourceId): number {
  return VOLUME_SOURCES[source].keywordsPerTask;
}

/**
 * Keywords per request for a slice that feeds several endpoints at once.
 *
 * The **minimum**, because the slice goes to all of them and the strictest cap binds.
 * Returns the limiting source alongside the number, since when two caps disagree the
 * smaller one is always correct and never the obvious one.
 */
export function sharedKeywordsPerTask(sources: VolumeSourceId[]): {
  keywordsPerTask: number;
  limitingSource: VolumeSourceId;
} {
  // **Arbitration sources are dropped, in both directions.** A caller listing one
  // alongside real sources still gets a correct batch for the part that fetches, and a
  // caller listing *only* one gets the conservative default rather than a batch sized
  // by an endpoint that was never going to fetch anything. Their 1,000-keyword cap is
  // real and it is not a fetch plan.
  const volumeSources = sources.filter(
    (source) => VOLUME_SOURCES[source].role === "volume",
  );
  const chosen =
    volumeSources.length > 0 ? volumeSources : ["google_ads" as const];
  const keywordsPerTask = Math.min(
    ...chosen.map((source) => keywordsPerTaskFor(source)),
  );
  const limitingSource =
    chosen.find((source) => keywordsPerTaskFor(source) === keywordsPerTask) ??
    chosen[0];
  return { keywordsPerTask, limitingSource };
}
