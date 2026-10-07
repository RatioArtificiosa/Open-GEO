/**
 * Reading a demography answer, where two normalisations sit side by side.
 *
 * ## The rule that matters
 *
 * `demography.age` and `demography.gender` are normalised **per keyword** — each keyword's own
 * peak across its age buckets is 100 — so those numbers compare buckets *within one keyword*.
 * `demography_comparison` is normalised across the **requested keywords** within each bucket, so
 * those compare keywords *within one bucket*. The two look identical on screen and answer opposite
 * questions, so this module returns them as two named things rather than one table.
 *
 * And the vendor's `0` is the same sentence as everywhere else in this family: *"not enough data
 * for this term"*. It maps to `null`, because a demographic split drawn with a 0 reads as a
 * disinterested age group rather than an unmeasured one.
 */

type DemographyBucketValue = {
  bucket: string;
  /** Null where the vendor reported 0, which its documentation defines as "not enough data". */
  value: number | null;
};

type KeywordDemography = {
  keyword: string;
  age: DemographyBucketValue[];
  gender: DemographyBucketValue[];
};

type DemographyComparison = {
  /** One array per bucket, each aligned to the request's keyword order. */
  age: Record<string, Array<number | null>>;
  gender: Record<string, Array<number | null>>;
};

type RawBucket = { type?: string | null; value?: number | null };
type RawKeywordBlock = { keyword?: string | null; values?: RawBucket[] | null };

type DemographyLike = {
  keywords?: string[] | null;
  demography?: {
    age?: RawKeywordBlock[] | null;
    gender?: RawKeywordBlock[] | null;
  } | null;
  demography_comparison?: {
    age?: Record<string, number[] | null> | null;
    gender?: Record<string, number[] | null> | null;
  } | null;
};

function readValues(
  blocks: RawKeywordBlock[] | null | undefined,
): Array<{ keyword: string; values: DemographyBucketValue[] }> {
  return (blocks ?? []).map((block) => ({
    keyword: block.keyword ?? "",
    values: (block.values ?? []).map((entry) => ({
      bucket: entry.type ?? "",
      value: entry.value == null || entry.value === 0 ? null : entry.value,
    })),
  }));
}

/** Per keyword, with each keyword's own peak as its 100. */
export function readKeywordDemography(
  input: DemographyLike,
): KeywordDemography[] {
  const age = readValues(input.demography?.age);
  const gender = readValues(input.demography?.gender);
  const keywords = input.keywords ?? age.map((entry) => entry.keyword);

  return keywords.map((keyword, index) => ({
    keyword,
    age: age[index]?.values ?? [],
    gender: gender[index]?.values ?? [],
  }));
}

/**
 * Shares across the requested keywords, per bucket — or null.
 *
 * **Null is a real answer here**: the vendor returns null for a single keyword, because there is
 * nothing to compare it with. Returning an empty object instead would render as "no data" and
 * blame the index for a question that was never asked.
 */
/** Shares for each bucket, with the vendor's 0 mapped to null as everywhere in this family. */
function readBuckets(
  source: Record<string, number[] | null> | null | undefined,
): Record<string, Array<number | null>> {
  const out: Record<string, Array<number | null>> = {};
  for (const [bucket, values] of Object.entries(source ?? {})) {
    out[bucket] = (values ?? []).map((value) =>
      value == null || value === 0 ? null : value,
    );
  }
  return out;
}

export function readDemographyComparison(
  input: DemographyLike,
): DemographyComparison | null {
  const comparison = input.demography_comparison;
  if (comparison == null) return null;

  return {
    age: readBuckets(comparison.age),
    gender: readBuckets(comparison.gender),
  };
}

/**
 * How to describe the two rulers, in one sentence each, so no surface invents its own wording.
 */
export const DEMOGRAPHY_PER_KEYWORD_CAVEAT =
  "Age and gender scores are shares of that keyword's own peak, so they compare buckets within one keyword, not keywords with each other.";

export const DEMOGRAPHY_COMPARISON_CAVEAT =
  "Comparison scores are shares across the keywords in this request, so they compare keywords within one bucket. A single keyword has no comparison.";
