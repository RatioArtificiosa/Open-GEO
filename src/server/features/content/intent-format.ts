/**
 * Intent→format and SERP-element→format rules (CL-718), as data.
 *
 * Sofia's table, shipped verbatim rather than paraphrased: a paraphrase is
 * where "comparison" quietly becomes "review" and nobody can tell which one
 * the vendor's rule actually named. The table is the contract; `formatFor`
 * reads it, and the test asserts every row of it — so a row changed here is a
 * test failure, not a silent drift in advice.
 */

/** The four documented search intents. `unknown` is not a fifth intent. */
export type ContentIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";

/** Formats this product can recommend. Closed: advice names only these. */
export type ContentFormat =
  | "guide"
  | "tutorial"
  | "faq"
  | "comparison"
  | "review"
  | "alternatives"
  | "product"
  | "service"
  | "landing"
  | "brand"
  | "video"
  | "qa-section"
  | "originals"
  | "concise-answer";

/**
 * Intent → formats, Sofia's table verbatim.
 *
 * Informational earns the long-form trio (guide/tutorial/FAQ); commercial
 * earns the evaluation trio (comparison/review/alternatives); transactional
 * earns the conversion trio (product/service/landing); navigational earns
 * brand/product because the searcher named a destination. An intent with no
 * row would be advice invented here, so there is no fallback row — `unknown`
 * is refused, not mapped.
 */
export const INTENT_FORMAT_RULES: Record<ContentIntent, ContentFormat[]> = {
  informational: ["guide", "tutorial", "faq"],
  commercial: ["comparison", "review", "alternatives"],
  transactional: ["product", "service", "landing"],
  navigational: ["brand", "product"],
};

/** SERP elements this product recognizes, as the vendor names them. */
export type SerpElement =
  | "video"
  | "people_also_ask"
  | "images"
  | "featured_snippet"
  | "ai_overview";

/**
 * SERP element → format, Sofia's table verbatim. Many video elements mean the
 * SERP wants video; PAA means the questions are asked outright (a Q&A
 * section); images mean originals (stock loses to the SERP's own); a featured
 * snippet means the concise answer or table that wins it; an AI Overview
 * means mirroring the cited topics.
 */
export const SERP_ELEMENT_FORMAT_RULES: Record<SerpElement, ContentFormat> = {
  video: "video",
  people_also_ask: "qa-section",
  images: "originals",
  featured_snippet: "concise-answer",
  ai_overview: "guide",
};

/**
 * Formats for an intent, or null when the intent is unknown.
 *
 * Null rather than a default trio: an unknown intent mapped to guides would
 * advise long-form for a buyer, and the caller — not this table — decides
 * what caution looks like. The returned array is a copy; the table is frozen
 * by convention (a caller that pushes into it rewrites advice for everyone).
 */
export function formatsForIntent(
  intent: ContentIntent | "unknown",
): ContentFormat[] | null {
  if (intent === "unknown") return null;
  return [...INTENT_FORMAT_RULES[intent]];
}

/** Format for one SERP element, or null when the element is unrecognized. */
export function formatForElement(element: string): ContentFormat | null {
  const byName: Record<string, ContentFormat> = SERP_ELEMENT_FORMAT_RULES;
  return byName[element] ?? null;
}
