/**
 * Keyword density, computed from the page text the crawler already has.
 *
 * ## Why this is local rather than the vendor's `on_page/keyword_density`
 *
 * DataForSEO sells keyword density as an On-Page add-on, and it is priced per page on a
 * crawl *their* crawler runs. This audit runs its own crawl, so buying that endpoint
 * would mean a second crawl of the same site at $0.0003 a page plus a task fee, to
 * measure text we already hold in memory. The analysis here costs nothing and runs in
 * the same pass as the other reporters.
 *
 * ## What it looks for, and what it refuses to claim
 *
 * Repetition, not optimisation. A term at 5% or more of a page's words is deliberate
 * repetition rather than prose, and that is the only thing this reports. It does
 * **not** claim a page is "optimised" for a term, because density alone cannot support
 * that: the audit has no target keyword per URL, and inventing one from the page's own
 * most frequent term would make every page look perfectly optimised for itself.
 *
 * ## The two floors, and why both are needed
 *
 * - **Density** alone flags a three-word page whose title repeats once.
 * - **A minimum count** alone flags a 5,000-word guide for a term used fifteen times,
 *   which is ordinary English.
 *
 * So a term is only reported when it is *both* at or above the density threshold *and*
 * used at least `STUFFING_MIN_OCCURRENCES` times. The thresholds are deliberately
 * conservative: an audit that cries stuffing on normal pages teaches readers to ignore
 * the whole report.
 */

import { sortBy } from "remeda";

export interface StuffedTerm {
  term: string;
  count: number;
  /** Share of counted words, 0 to 1. */
  density: number;
}

/** Share of a page's words above which repetition reads as deliberate. */
export const STUFFING_MIN_DENSITY = 0.05;

/** Uses below this are not stuffing, whatever the density says on a short page. */
export const STUFFING_MIN_OCCURRENCES = 8;

/** How many offenders a report carries. The rest are a count, not a list. */
const MAX_REPORTED_TERMS = 3;

/**
 * Function words, which would otherwise top every page's list.
 *
 * A deliberately short English list rather than a full stop-word corpus: the goal is to
 * stop `the` and `and` winning, not to lemmatise the language. Terms shorter than
 * `MIN_TERM_CHARS` are dropped for the same reason, which covers most of the rest.
 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "our",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "but",
  "can",
  "will",
  "all",
  "any",
  "how",
  "what",
  "when",
  "who",
  "why",
  "its",
  "it's",
  "they",
  "their",
  "them",
  "there",
  "here",
  "more",
  "most",
  "other",
  "into",
  "over",
  "than",
  "then",
  "too",
  "very",
  "just",
  "also",
  "about",
  "after",
  "before",
  "between",
  "out",
  "one",
  "two",
  "use",
  "using",
  "get",
  "make",
  "see",
  "new",
]);

const MIN_TERM_CHARS = 3;

/** Words that are only punctuation, or that carry no letters, are not terms. */
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;

/**
 * Term frequencies over a page's visible text.
 *
 * Density is measured against the words that survived filtering, not against every
 * token. A page of navigation links would otherwise have its share diluted by words
 * nobody reads, and the threshold would mean something different on every site.
 */
export function countTerms(bodyText: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of bodyText.toLowerCase().matchAll(WORD_PATTERN)) {
    const term = match[0].replace(/^'-|-'$/g, "");
    if (term.length < MIN_TERM_CHARS || STOP_WORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/**
 * The terms a page repeats past the point of prose, strongest first.
 *
 * Returns an empty list for a page with nothing worth saying, which is the common case
 * and the one that keeps the report readable.
 */
export function findStuffedTerms(
  bodyText: string,
  options: {
    minDensity?: number;
    minOccurrences?: number;
    max?: number;
  } = {},
): StuffedTerm[] {
  const minDensity = options.minDensity ?? STUFFING_MIN_DENSITY;
  const minOccurrences = options.minOccurrences ?? STUFFING_MIN_OCCURRENCES;
  const max = options.max ?? MAX_REPORTED_TERMS;

  const counts = countTerms(bodyText);
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total === 0) return [];

  const offenders = [...counts.entries()]
    .map(([term, count]) => ({ term, count, density: count / total }))
    .filter(
      (entry) => entry.count >= minOccurrences && entry.density >= minDensity,
    );

  // **Density first, then count, then the term**, and descending on the first two.
  // Within one page every term shares a denominator, so density and count produce the
  // same order and this is simply the right key to name. The density does its real work
  // in the filter above, where a term with many uses on a long page is excluded and a
  // term with the same count on a short page is not. The alphabetical fallback keeps the
  // order stable run to run, which matters because the issue row is written from this
  // list. `sortBy` rather than `sort`, because the repo's lib target has no `toSorted`.
  return sortBy(
    offenders,
    (entry) => -entry.density,
    (entry) => -entry.count,
    (entry) => entry.term,
  ).slice(0, max);
}
