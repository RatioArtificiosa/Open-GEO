import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

// Approximate organic CTR by position (index = position; aggregate industry
// curves). Only used to weight the visibility metric, so relative weights
// matter, not exact values. Positions past the list fall back to a small CTR.
const CTR_BY_POSITION = [
  0, 0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.033, 0.028, 0.024, 0.021, 0.018,
  0.016, 0.014, 0.012, 0.011, 0.01, 0.009, 0.008, 0.007, 0.006,
];

/**
 * The CTR at position 1 — the denominator of the visibility metric.
 *
 * **Read through `ctr()` rather than as a second index into the table.**
 * `CTR_BY_POSITION[1]` was a literal copy of `ctr(1)`, and the two could drift:
 * if the table ever shrank, this read became `undefined` while `ctr()` kept its
 * `?? 0.005` fallback, so `visNum / (visVolume * undefined)` produced `NaN` —
 * which renders as "NaN%" and which **the `visVolume > 0` guard does not catch**,
 * because that guard is about volume, not about the denominator.
 *
 * Going through the helper removes the second index, so the value in the comment
 * below ("CTR@1") and the value in the code are the same number by construction.
 */
const TOP_CTR = ctr(1);

function ctr(position: number | null): number {
  if (position === null || position < 1) return 0;
  // **An optional read, not `at()`.** A tracked position can exceed the CTR
  // table — depth 100 with a page ranking past 20 — and `at()` throws on an
  // index the table does not have. A throw here would turn "we have no click
  // curve for that rank" into a rendered crash on the whole scorecard row,
  // which is a worse answer than the conservative fallback: a page ranking past
  // the last modelled position contributes its volume but almost no click
  // potential.
  return CTR_BY_POSITION[position] ?? 0.005;
}

interface Scorecards {
  /**
   * Volume-weighted, CTR-weighted share of click potential captured (0–100):
   * Σ(volume × CTR@position) ÷ Σ(volume × CTR@1). null if no volume data.
   */
  visibility: number | null;
  /** change in visibility (percentage points) vs the comparison period */
  visibilityDelta: number | null;
  /** keywords currently ranking (found within the tracked depth) */
  ranking: number;
  /** change in ranking-keyword count vs the comparison period */
  rankingDelta: number;
  top3: number;
  top10: number;
  improved: number;
  declined: number;
}

/**
 * Portfolio scorecards from the already-loaded latest results for one device.
 * `ranking` counts keywords found within the tracked depth (a non-null
 * position) — unlike an average, it correctly drops when keywords fall out.
 * Improved/declined use the same 4-case null rules as DeviceRankCell: a "new"
 * entry counts as improved, a "lost" ranking counts as declined, and we never
 * subtract through a null.
 */
export function computeScorecards(
  rows: RankTrackingRow[],
  device: "desktop" | "mobile",
): Scorecards {
  let countCurrent = 0;
  let countPrevious = 0;
  let top3 = 0;
  let top10 = 0;
  let improved = 0;
  let declined = 0;
  let visNumCurrent = 0;
  let visNumPrevious = 0;
  let visVolume = 0; // Σ volume over keywords with known volume

  for (const row of rows) {
    const { position, previousPosition } = row[device];

    if (position !== null) {
      countCurrent += 1;
      if (position <= 3) top3 += 1;
      if (position <= 10) top10 += 1;
    }
    if (previousPosition !== null) {
      countPrevious += 1;
    }

    if (row.searchVolume != null && row.searchVolume > 0) {
      visVolume += row.searchVolume;
      visNumCurrent += row.searchVolume * ctr(position);
      visNumPrevious += row.searchVolume * ctr(previousPosition);
    }

    // 4-case change classification (mirrors DeviceRankCell)
    if (position === null && previousPosition === null) {
      // nothing tracked — neither improved nor declined
    } else if (position === null) {
      declined += 1; // was ranking, now lost
    } else if (previousPosition === null) {
      improved += 1; // new entry
    } else if (previousPosition - position > 0) {
      improved += 1; // moved up
    } else if (previousPosition - position < 0) {
      declined += 1; // moved down
    }
  }

  const visibility =
    visVolume > 0 ? (visNumCurrent / (visVolume * TOP_CTR)) * 100 : null;
  const visibilityPrevious =
    visVolume > 0 ? (visNumPrevious / (visVolume * TOP_CTR)) * 100 : null;

  return {
    visibility,
    visibilityDelta:
      visibility !== null && visibilityPrevious !== null
        ? visibility - visibilityPrevious
        : null,
    ranking: countCurrent,
    rankingDelta: countCurrent - countPrevious,
    top3,
    top10,
    improved,
    declined,
  };
}
