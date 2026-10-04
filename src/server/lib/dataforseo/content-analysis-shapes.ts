import { z } from "zod";

/**
 * Shapes shared by the three `content_analysis` fetchers.
 *
 * Extracted because `summary`, `phrase_trends` and `sentiment_analysis` all
 * parse the same five fields and each file was approaching the 400-line
 * budget on its own. One definition also means one place to change when the
 * vendor moves a field — which has happened once already on this endpoint
 * family.
 */

/**
 * `connotation_types`: citation counts per polarity.
 *
 * **Counts over the vendor's whole index for the keyword, not a sample
 * anyone chose** — so `positive: 261992` is "of every citing page in the
 * index, 262k were classified positive". It is not a sentiment score, and no
 * code here treats it as one.
 */
export const countMap = z
  .object({
    positive: z.number().nullish(),
    negative: z.number().nullish(),
    neutral: z.number().nullish(),
  })
  .passthrough();

/**
 * Drop nullish entries from a count map.
 *
 * For `sentiment_connotations` a missing key means the vendor had no count
 * for that label, and reporting it as zero would turn "we have no measurement"
 * into "measured as none". The `page_types` maps are the opposite case and
 * use `nullableCountsOf`, which keeps their nulls.
 */
export function countsOf(
  raw: Record<string, number | null | undefined> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** Narrow raw `top_domains` rows to ones a caller can render. */
export function toDomainRows(
  rows:
    | Array<{ domain?: string | null; count?: number | null }>
    | null
    | undefined,
): Array<{ domain: string; count: number }> {
  return (rows ?? []).filter(
    (row): row is { domain: string; count: number } =>
      typeof row.domain === "string" && typeof row.count === "number",
  );
}
