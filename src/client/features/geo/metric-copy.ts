/**
 * What every AI-visibility metric actually measures.
 *
 * This is a **registry**, not a set of strings sprinkled through the UI, and the
 * difference is not tidiness. `BrandLookupResults.tsx` carried a hand-written
 * tooltip reading "estimated monthly search demand for prompts where the brand
 * appears in AI answers" directly above a number that was Google demand plus
 * ChatGPT demand added together — two different units, a ~198× ratio apart. The
 * copy was accurate about *neither* half, and no test could have caught that,
 * because the number and its explanation lived in different files.
 *
 * So the explanation lives here, next to nothing else that can change it, and a
 * metric that is not in this registry does not compile. Two rules the registry
 * enforces by existing at all:
 *
 * 1. **Every number names its unit.** "Mentions" is a count of answers.
 *    "ChatGPT demand" is a modelled monthly rate. "Google demand" is a real
 *    search-volume rate. None of them is traffic, and none is the others.
 * 2. **Every number names its limit.** A reader who knows a number is an
 *    estimate still needs to know *whose* estimate and covering *what*.
 *
 * Adding a metric without a footnote is a type error, which is the only way to
 * make the habit survive a deadline.
 */

/** The metrics this product shows. Adding one is a deliberate act. */
export const METRIC_IDS = [
  "mentions",
  "chatgpt_demand",
  "google_demand",
  "etv",
  "citation_gap",
  "retrieved_but_uncited",
  "freshness",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

type MetricCopy = {
  /** The short name on the card. Names the unit, never a bare noun. */
  label: string;
  /**
   * The footnote. One sentence on what it measures, one on what it does not.
   * The second sentence is the one that prevents the misreading.
   */
  footnote: string;
};

export const METRIC_COPY: Record<MetricId, MetricCopy> = {
  mentions: {
    label: "Mentions",
    footnote:
      "Count of AI answers that named this brand, across the platforms listed. This is a count of answers, not traffic and not demand — and unlike demand it is comparable across platforms, because both count the same kind of event.",
  },

  chatgpt_demand: {
    label: "ChatGPT demand",
    footnote:
      "Estimated monthly conversational demand for prompts where the brand appears in ChatGPT answers, modelled from People-Also-Ask style questions rather than measured. It is not search volume and must not be added to Google's figure, which is a different unit.",
  },

  google_demand: {
    label: "Google demand",
    footnote:
      "Estimated monthly search demand for prompts where the brand appears in Google AI Overviews, derived from real search volume. It is not conversational demand and must not be added to ChatGPT's figure, which is a different unit.",
  },

  etv: {
    label: "Estimated traffic",
    footnote:
      "A model estimate of organic visits, not a measurement from analytics. Every stored value carries the formula that produced it, because DataForSEO changed the model on 1 November 2026 and a series that crosses that date is a method change rather than a trend.",
  },

  citation_gap: {
    label: "Citation gap",
    footnote:
      "The difference between what a model retrieved while researching an answer and what it actually cited. A page in this gap was read and passed over. It is available for ChatGPT only: Google AI Overviews reports citations but not retrievals, so asking there would be a question the data cannot answer.",
  },

  retrieved_but_uncited: {
    label: "Retrieved but not cited",
    footnote:
      "Pages the model fetched while composing an answer and then did not use. This is a directness problem, not a volume problem: the page was found and skipped, so more content is rarely the fix.",
  },

  freshness: {
    label: "Last checked",
    footnote:
      "When the nightly patrol last ran for this brand. Archived answers age out on a retention window; the run that produced them stays for the cost and status, but the answer text may not be there any more.",
  },
};

/**
 * The footnote for a metric.
 *
 * Takes `MetricId` rather than `string` so a typo or a renamed metric is a
 * compile error rather than a card with no explanation.
 */
export function footnoteFor(id: MetricId): string {
  return METRIC_COPY[id].footnote;
}

/** The label for a metric, for the same reason. */
export function labelFor(id: MetricId): string {
  return METRIC_COPY[id].label;
}
