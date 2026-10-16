/**
 * Content quality grading (CL-719): read the on-page verdict aloud, never blended.
 *
 * The vendor's crawl returns an `onpage_score` (0–100) and five readability
 * indices that run in opposite directions — Flesch–Kincaid higher means
 * easier, ARI/Coleman–Liau/Dale–Chall/SMOG higher means harder. Any module
 * that averages them produces a number whose direction is meaningless, which
 * is exactly R14: never blend without declared normalization. So this module
 * computes no blended number at all. There is no field for one to hide in.
 *
 * Pure: the crawl result arrives as an argument from the caller, where the
 * metering already lives.
 */

export type ReadabilityIndexName =
  | "fleschKincaid"
  | "ari"
  | "colemanLiau"
  | "daleChall"
  | "smog";

/** Display metadata per index: which direction is "harder". */
export const READABILITY_DIRECTIONS: Record<
  ReadabilityIndexName,
  { label: string; higherMeans: "easier" | "harder" }
> = {
  fleschKincaid: { label: "Flesch–Kincaid", higherMeans: "easier" },
  ari: { label: "ARI", higherMeans: "harder" },
  colemanLiau: { label: "Coleman–Liau", higherMeans: "harder" },
  daleChall: { label: "Dale–Chall", higherMeans: "harder" },
  smog: { label: "SMOG", higherMeans: "harder" },
};

export type ReadabilityReading = {
  name: ReadabilityIndexName;
  label: string;
  value: number;
  higherMeans: "easier" | "harder";
};

export type ContentGradeInput = {
  /**
   * The vendor's `onpage_score`, 0–100 — and specifically that field, never
   * `page_score`. The names differ by two letters and the values differ by
   * meaning; the caller passes the right one because only it can see the
   * crawl response it holds.
   */
  onpageScore: number;
  /** Indices present in this crawl; absent ones are omitted, not zeroed. */
  readability: Partial<Record<ReadabilityIndexName, number>>;
  /**
   * Keyword density as a ratio (0.02, not 2). Display multiplies by 100 and
   * labels it a ratio — a ratio presented as a grade invites "improve it to
   * 100", which is keyword stuffing as advice.
   */
  keywordDensityRatio: number | null;
  /** Summary checks as counts: passed of total, never a boolean. */
  checksPassed: number | null;
  checksTotal: number | null;
};

export type ContentGrade = {
  /** The vendor's onpage_score, passed through with its provenance. */
  score: number;
  scoreSource: "onpage_score";
  indices: ReadabilityReading[];
  densityPercent: number | null;
  densityNote: string | null;
  checkCoverage: string | null;
};

/**
 * Grade a crawl result by reading it aloud.
 *
 * An absent index is omitted from the list (an unmeasured index reported as
 * zero would read as maximally easy or hard depending on its direction); an
 * absent density or check count is null with the reason, never a zero that
 * would top-or-bottom a comparison.
 */
export function gradeContent(input: ContentGradeInput): ContentGrade {
  const indices: ReadabilityReading[] = [];
  const names: ReadabilityIndexName[] = [
    "fleschKincaid",
    "ari",
    "colemanLiau",
    "daleChall",
    "smog",
  ];
  for (const name of names) {
    const meta = READABILITY_DIRECTIONS[name];
    const value = input.readability[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    indices.push({
      name,
      label: meta.label,
      value,
      higherMeans: meta.higherMeans,
    });
  }
  return {
    score: input.onpageScore,
    scoreSource: "onpage_score",
    indices,
    densityPercent:
      input.keywordDensityRatio === null
        ? null
        : Math.round(input.keywordDensityRatio * 10000) / 100,
    densityNote:
      input.keywordDensityRatio === null
        ? "density not reported for this crawl"
        : "a ratio of occurrences to words, not a grade — higher is not better",
    checkCoverage:
      input.checksPassed === null || input.checksTotal === null
        ? null
        : `${input.checksPassed}/${input.checksTotal} checks passed`,
  };
}
