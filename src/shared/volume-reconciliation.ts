/**
 * Volume reconciliation: does the number we show survive a second opinion?
 *
 * ## What this is for
 *
 * Every volume this product displays comes from Google Ads' modelled data, which is a
 * *grouped estimate*: Google reports one figure for a cluster of close variants, so a
 * keyword can inherit its neighbour's volume. Clickstream data measures panel traffic
 * instead. Where the two disagree, the honest thing to do is say so rather than show one
 * of them with confidence.
 *
 * ## The trap this module exists to close
 *
 * The clickstream endpoint is **global**, and everything we show is **national**. Its
 * top-level `search_volume` is therefore not comparable to a country figure at all, and a
 * view that puts the two side by side would be wrong in a way that looks authoritative.
 * So the comparison is always against `countryVolume`, read from the response's own
 * per-country breakdown, and a missing country entry is `uncomparable` rather than a
 * guess. The global figure is carried through as context and never used as the verdict's
 * input.
 *
 * ## Why the band is this wide
 *
 * A quarter either way is not agreement in the strict sense; it is the point past which
 * the gap stops being explained by method. Both sources estimate, both round, and Google
 * Ads groups variants by design, so a 10% threshold would flag ordinary methodology as a
 * finding and teach readers to ignore the whole column.
 */

type VolumeVerdict =
  | "corroborated"
  | "measured-higher"
  | "measured-lower"
  | "uncomparable";

/** How far the two sources may differ before the gap is worth reporting. */
export const CORROBORATION_BAND = 0.25;

type ReconciliatedVolume = {
  keyword: string;
  /** What the product shows for this keyword and market. */
  referenceVolume: number | null;
  /** The country figure from the clickstream breakdown, which is what the verdict uses. */
  countryVolume: number | null;
  /** The global measurement, carried as context only. */
  globalVolume: number | null;
  /** `countryVolume / referenceVolume`, or null when either side cannot ratio. */
  ratio: number | null;
  verdict: VolumeVerdict;
  /** Why, in words a reader can act on. */
  note: string;
};

export function reconcileVolume(input: {
  keyword: string;
  referenceVolume: number | null;
  globalVolume: number | null;
  countryDistribution: ReadonlyArray<{
    countryIsoCode: string | null;
    searchVolume: number | null;
  }>;
  /** The market the reference figure describes, as an ISO code ("US"). */
  countryIsoCode: string;
}): ReconciliatedVolume {
  const share = input.countryDistribution.find(
    (entry) =>
      entry.countryIsoCode?.toUpperCase() ===
      input.countryIsoCode.toUpperCase(),
  );
  const countryVolume = share?.searchVolume ?? null;

  const base = {
    keyword: input.keyword,
    referenceVolume: input.referenceVolume,
    countryVolume,
    globalVolume: input.globalVolume,
  };

  if (input.referenceVolume === null) {
    return {
      ...base,
      ratio: null,
      verdict: "uncomparable",
      note: "No volume is stored for this keyword in this market, so there is nothing to corroborate.",
    };
  }
  if (countryVolume === null) {
    return {
      ...base,
      ratio: null,
      verdict: "uncomparable",
      note: `The clickstream breakdown has no figure for ${input.countryIsoCode}, so this keyword cannot be checked in this market. The global figure is context only.`,
    };
  }
  if (input.referenceVolume === 0) {
    // The ratio is undefined against zero, and the direction is still meaningful.
    return {
      ...base,
      ratio: null,
      verdict: countryVolume === 0 ? "corroborated" : "measured-higher",
      note:
        countryVolume === 0
          ? "Both sources report no measurable volume."
          : `Our figure is zero while the measured figure is ${countryVolume}, which means the keyword is being written off.`,
    };
  }

  const ratio = countryVolume / input.referenceVolume;
  if (ratio > 1 + CORROBORATION_BAND) {
    return {
      ...base,
      ratio,
      verdict: "measured-higher",
      note: `Measured volume is ${Math.round((ratio - 1) * 100)}% higher than the figure we show, which usually means Google Ads grouped this keyword with others and gave it the cluster's total.`,
    };
  }
  if (ratio < 1 - CORROBORATION_BAND) {
    return {
      ...base,
      ratio,
      verdict: "measured-lower",
      note: `Measured volume is ${Math.round((1 - ratio) * 100)}% lower than the figure we show, which usually means the shown figure is inherited from a cluster this keyword does not really belong to.`,
    };
  }
  return {
    ...base,
    ratio,
    verdict: "corroborated",
    note: "The two sources agree within the band, so the figure we show stands on its own.",
  };
}

type ReconciliationSummary = {
  total: number;
  corroborated: number;
  measuredHigher: number;
  measuredLower: number;
  uncomparable: number;
  /** Share of the *comparable* rows that agreed, 0 to 1, or null when none were comparable. */
  corroborationRate: number | null;
};

/**
 * The headline: how much of what we show survives the second opinion.
 *
 * The rate is over comparable rows only. Counting an uncomparable row as agreement would
 * flatter the number, and counting it as disagreement would invent a finding, so it is
 * excluded and reported separately for the reader to weigh.
 */
export function summariseReconciliation(
  rows: ReadonlyArray<ReconciliatedVolume>,
): ReconciliationSummary {
  const corroborated = rows.filter(
    (row) => row.verdict === "corroborated",
  ).length;
  const measuredHigher = rows.filter(
    (row) => row.verdict === "measured-higher",
  ).length;
  const measuredLower = rows.filter(
    (row) => row.verdict === "measured-lower",
  ).length;
  const uncomparable = rows.filter(
    (row) => row.verdict === "uncomparable",
  ).length;
  const comparable = rows.length - uncomparable;

  return {
    total: rows.length,
    corroborated,
    measuredHigher,
    measuredLower,
    uncomparable,
    corroborationRate: comparable > 0 ? corroborated / comparable : null,
  };
}
