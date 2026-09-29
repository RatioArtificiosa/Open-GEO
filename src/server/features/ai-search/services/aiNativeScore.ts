import type { DemandRow } from "./demandTable";

/**
 * The AI-Native Score: AI demand per real Google search, on a 0–100 scale.
 *
 * ## The score is a bounded summary of an unbounded quantity
 *
 * The ratio itself is fine — CL-138 already established that dividing is
 * legitimate where adding is not. The problem is *normalising* an unbounded
 * number onto 0–100. A keyword asked of AI 5× more than on Google and one asked
 * 5,000× more are both "AI-dominant", but no linear map puts them at 50 and 100
 * without an arbitrary choice about which is the cap.
 *
 * This is the same missing-baseline problem as the cross-platform index
 * (CL-136), and it gets the same answer: **anchor on the points that mean
 * something, and say so.**
 *
 * Two anchors are intrinsic rather than invented:
 *
 * - **0** — nobody asks AI engines this. The floor is real.
 * - **50** — asked of AI exactly as often as on Google. *Parity* is a fact
 *   about the world, not a parameter we chose, so it belongs in the middle.
 *
 * Everything between them is linear, which is defensible because it is the only
 * assumption made and it is stated. **Above 50 the scale has no anchor**, because
 * there is no intrinsic point between parity and "infinitely AI-dominant". So
 * the score **saturates at 100 and says it did**. A capped number that declares
 * its cap is honest; a capped number that reads 100 silently is the exact
 * failure mode this product keeps refusing elsewhere.
 *
 * ## What the score is not
 *
 * It is **not** a priority. Priority needs difficulty, and a score that folded
 * KD in would be a different, worse metric wearing this name. `aiNativeScore`
 * is returned alongside `keywordDifficulty` and the ratio itself, and the
 * content calendar refuses to rank on the score alone — it sorts by the ratio
 * and shows difficulty beside it, so the trade-off is the user's to make.
 *
 * Nothing here may be averaged across keywords. The mean of three AI-dominant
 * keywords and one dead one is a number about nothing.
 */

/** The two anchors, and they are the whole design. */
const PARITY_RATIO = 1;
const PARITY_SCORE = 50;
const MAX_SCORE = 100;

type ScoreBand = "ai-dead" | "ai-weak" | "parity" | "ai-dominant";

type ScoredRow = {
  keyword: string;
  /** The raw ratio, unchanged. The score is a summary; this is the fact. */
  aiToGoogle: number | "infinite" | null;
  /** 0–100, or null when the ratio is null. Saturates at 100. */
  score: number | null;
  band: ScoreBand | null;
  /** True when the score was clamped, so the UI can render a "100+" marker. */
  saturated: boolean;
  /** Why the score is what it is, in words that name the anchor. */
  explanation: string;
  /**
   * Deliberately absent: any priority or recommendation. Difficulty is a user's
   * judgement, and a score that absorbed it would be a different metric.
   */
  keywordDifficulty: number | null;
};

type ScoredTable = {
  rows: ScoredRow[];
  /**
   * The rows worth a calendar slot, best first. Sorted by the **ratio**, not the
   * score, because the ratio does not saturate and so still orders the
   * AI-dominant rows against each other — which the score deliberately cannot.
   */
  calendar: ScoredRow[];
  /** How many calendar rows were dropped by the cap, so the list is not a mystery. */
  calendarTruncated: number;
  summary: string;
};

/** Score one row. Pure, so the scale is testable without a table around it. */
export function scoreRow(row: DemandRow): ScoredRow {
  const base = {
    keyword: row.keyword,
    aiToGoogle: row.aiToGoogle,
    keywordDifficulty: row.keywordDifficulty,
  };

  if (row.aiToGoogle === null) {
    return {
      ...base,
      score: null,
      band: null,
      saturated: false,
      explanation: row.aiToGoogleNote,
    };
  }

  if (row.aiToGoogle === "infinite") {
    // The one case with no upper bound at all, so it saturates by definition and
    // says so rather than pretending to have measured how extreme it is.
    return {
      ...base,
      score: MAX_SCORE,
      band: "ai-dominant",
      saturated: true,
      explanation:
        "Nobody searches this on Google, so AI demand per search is unbounded. The score is capped at 100 because the quantity is, not because we measured a hundred.",
    };
  }

  const ratio = row.aiToGoogle;
  // `>` not `>=`: parity *is* the 50 anchor, so it must be scored on the linear
  // side. An earlier version used `>=` and cancelled parity to 100, which put
  // the scale's own anchor at its ceiling — the parity test caught it, and the
  // same boundary error also let a keyword nobody prefers into the calendar.
  if (ratio > PARITY_RATIO) {
    return {
      ...base,
      score: MAX_SCORE,
      band: "ai-dominant",
      // Above parity there is no second anchor, so every AI-dominant keyword
      // saturates. The flag is what tells the reader the number is a floor and
      // not a measurement — and it is why the calendar sorts on the ratio.
      saturated: true,
      explanation: `Asked of AI ${ratio.toFixed(2)}× as often as on Google. AI-dominant, so the score is at its cap of 100; the ratio above is the real ordering.`,
    };
  }

  const score = Math.round((ratio / PARITY_RATIO) * PARITY_SCORE);
  const band: ScoreBand =
    ratio === 0 ? "ai-dead" : ratio < 0.25 ? "ai-weak" : "parity";
  return {
    ...base,
    score,
    band,
    saturated: false,
    explanation: `AI demand is ${(ratio * 100).toFixed(1)}% of Google demand, so the score is ${score} of 100 — 50 is the point where AI engines are asked about this as often as Google.`,
  };
}

export function buildScoredTable(
  rows: DemandRow[],
  calendarLimit = 12,
): ScoredTable {
  const scored = rows.map(scoreRow);
  const eligible = scored
    .filter((row) => row.aiToGoogle !== null)
    .filter((row) => row.band === "ai-dominant");

  // The calendar is sorted by the ratio, not the score. Every AI-dominant row has
  // a score of 100, so sorting by score would return them in arbitrary order and
  // quietly destroy the ranking the feature exists to provide. `infinite` first.
  const ordered = rankByRatio(eligible);
  const calendar = ordered.slice(0, calendarLimit);

  const table: ScoredTable = {
    rows: scored,
    calendar,
    calendarTruncated: ordered.length - calendar.length,
    summary: "",
  };
  table.summary = describe(table);
  return table;
}

function rankOf(row: ScoredRow): number {
  if (row.aiToGoogle === "infinite") return Number.NEGATIVE_INFINITY;
  return -(row.aiToGoogle ?? 0);
}

function rankByRatio(rows: ScoredRow[]): ScoredRow[] {
  // Insertion sort, for the same reason as everywhere else in this feature:
  // `no-array-sort` bans `sort` and the spread form, and `toSorted` is not in
  // the `lib` target.
  const ordered: ScoredRow[] = [];
  for (const row of rows) {
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other !== undefined && rankOf(other) > rankOf(row)) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, row);
  }
  return ordered;
}

function describe(table: ScoredTable): string {
  const scored = table.rows.filter((r) => r.score !== null);
  if (scored.length === 0) {
    return "No keyword could be scored: we have no AI demand or no Google volume to compare it against.";
  }
  const saturated = table.rows.filter((r) => r.saturated).length;
  return (
    `AI-Native Score = AI demand per real Google search, where 50 is the point at which AI engines ` +
    `are asked about a keyword as often as Google. ${saturated} of ${scored.length} scored keywords ` +
    `sit at the cap of 100 — above parity there is no second anchor, so the number is a floor and ` +
    `the ratio is the real ordering. Keyword difficulty is not folded in: ranking these is your call, ` +
    `not the score's. The score is never averaged across keywords.`
  );
}
