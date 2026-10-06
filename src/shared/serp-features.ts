/**
 * SERP features: the vocabulary, and the single decoder for the stored form.
 *
 * ## `null` is not `[]`, and the difference is the whole point
 *
 * A snapshot stores its feature list as a JSON array of SERP item-type strings, or
 * nothing at all. Those are two different claims:
 *
 * - `[]` means **checked, and the SERP carried no features we record.** A real answer.
 * - `null` means **no feature record exists for this check**: a row written before the
 *   column was populated, or a payload we could not read.
 *
 * They render identically the moment both collapse to `[]`, which is what the original
 * decode did. It matters most for the AI Overview question, because the GEO tie-in reads
 * *absence* as "you were not in the AI Overview". A legacy row would then be reported as
 * a confident **not cited**, which is a fabricated negative rather than a gap. So
 * `parseSerpFeatures` preserves `null`, and each caller narrows to `[]` only where its
 * own type already says the list is always present.
 *
 * ## One decoder, because a second copy is how the two states drift apart
 *
 * The rank-tracking service and the rank-tracking history read both decode this column.
 * This file exists because those two would otherwise each own a copy of the rule that
 * `null` means "none", which is the bug described above.
 */

/** The SERP element type Google's AI Overview carries in an Advanced SERP response. */
export const AI_OVERVIEW_FEATURE = "ai_overview";

/**
 * Decode a stored feature list, **preserving `null`**.
 *
 * A malformed payload is a record we cannot read, not a SERP with no features, so it
 * decodes to `null` rather than `[]`, for the reason in the file header.
 */
export function parseSerpFeatures(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // Falls through to the same answer as a non-array payload: unreadable.
  }
  return null;
}

/**
 * Whether a recorded feature list says the SERP carried an AI Overview.
 *
 * `null` is **falsey by design**: "no record" cannot support "it was there". Callers that
 * need to distinguish "not present" from "not recorded" must test `null` themselves; this
 * answers only the presence question.
 */
export function hasAiOverview(
  features: readonly string[] | null | undefined,
): boolean {
  return features != null && features.includes(AI_OVERVIEW_FEATURE);
}
