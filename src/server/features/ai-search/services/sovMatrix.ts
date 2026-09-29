import {
  resolveCompetitorGroups,
  roundOrNull,
  sumNullable,
  type CrossOutcome,
} from "./shareOfVoice";
import type { LlmPlatform } from "@/server/lib/dataforseo";

/**
 * The share-of-voice matrix: brands × platforms.
 *
 * `computeShareOfVoice` sums mentions across platforms, and for *mentions* that
 * is right — a mention is a mention. But the sum destroys the only thing a
 * customer actually asks for here: **"where am I strong?"** A brand at 60% that
 * is entirely ChatGPT and 0% on Google looks identical, in the sum, to one at 60%
 * split evenly. Those are different businesses with different next moves.
 *
 * So the matrix keeps the cells, and makes three refusals:
 *
 * 1. **No cross-platform demand total is offered.** Google's `ai_search_volume`
 *    is real search volume and ChatGPT's is People-Also-Ask modelled — we
 *    measured 12,621,380 against 63,850 for one keyword. A demand row spanning
 *    both would be the same 198×-wrong number this product has now refused
 *    twice. Mention rows *are* totalled, and only mentions, because those units
 *    match.
 * 2. **A failed platform yields a null cell, not a zero.** If Google's call
 *    failed, ChatGPT at 100% is "the only platform we could measure", not "you
 *    own Google". Zero would be a claim about a platform we never asked.
 * 3. **A brand with no data is a row of nulls, not an absence.** It stays in
 *    the matrix so the reader can see we looked for it.
 */

type SovCell = {
  mentions: number | null;
  /** Share of that platform's measured mentions. Null when the cell is unknown. */
  sharePct: number | null;
};

export type SovRow = {
  label: string;
  isTarget: boolean;
  /** Per platform, in the order the calls were attempted. */
  cells: Record<string, SovCell>;
  /** Mentions summed across platforms. Mentions only — never demand. */
  totalMentions: number | null;
};

export type SovMatrix = {
  rows: SovRow[];
  /** Platforms we attempted, in order. */
  platforms: LlmPlatform[];
  /** Platforms that returned a usable result, in order. */
  measuredPlatforms: LlmPlatform[];
  /**
   * Platforms we tried and could not measure. A row total spanning only the
   * measured platforms is then explicitly a partial view, and this is how the UI
   * says so.
   */
  unavailablePlatforms: LlmPlatform[];
  summary: string;
};

/** One cell's key: platform, then the brand, lowercased for matching. */
function cellKey(platform: string, label: string): string {
  return `${platform}::${label.toLowerCase()}`;
}

/**
 * Build the matrix from the raw cross-aggregated outcomes.
 *
 * `attemptedPlatforms` is passed separately rather than inferred, because a
 * platform that failed has no successful outcome to infer itself from — and a
 * platform silently missing from the matrix is exactly the reader being told we
 * have no data on it.
 */
export function computeSovMatrix(input: {
  outcomes: CrossOutcome[];
  targetValue: string;
  competitors: string[];
  /**
   * `LlmPlatform` rather than `string`, so a typo in a caller's list is a
   * compile error instead of a platform column that appears in the matrix with
   * no data behind it.
   */
  attemptedPlatforms: LlmPlatform[];
}): SovMatrix {
  const groups = resolveCompetitorGroups(input.targetValue, input.competitors);
  const labels = [input.targetValue, ...groups.map((group) => group.label)];
  const keyByLabel = new Map(
    labels.map((label) => [label.toLowerCase(), label]),
  );

  // Seed every requested brand on every attempted platform, so a brand we know
  // nothing about is a row of nulls rather than a missing row.
  const cells = new Map<string, number | null>();
  for (const platform of input.attemptedPlatforms) {
    for (const label of labels) cells.set(cellKey(platform, label), null);
  }

  const measuredPlatforms: LlmPlatform[] = [];
  for (const outcome of input.outcomes) {
    if (outcome.status !== "success") continue;
    measuredPlatforms.push(outcome.platform);
    for (const item of outcome.items) {
      if (item.key == null) continue;
      const label = keyByLabel.get(item.key.toLowerCase());
      // The provider echoes the aggregation keys we asked for. An unexpected key
      // is not ours to score, and letting it in would silently widen the set the
      // percentages are computed over.
      if (label === undefined) continue;
      const value = sumNullable(
        (item.platform ?? []).map((entry) => roundOrNull(entry.mentions)),
      );
      const key = cellKey(outcome.platform, label);
      // null + null stays null ("no data"); null + n = n; m + n = m + n.
      cells.set(key, sumNullable([cells.get(key) ?? null, value]));
    }
  }

  const unavailablePlatforms = input.attemptedPlatforms.filter(
    (platform) => !measuredPlatforms.includes(platform),
  );

  // The denominator is per platform: a brand's share of ChatGPT mentions is
  // computed against the ChatGPT total, never against a cross-platform sum.
  const denominators = new Map<string, number>();
  for (const platform of measuredPlatforms) {
    const total =
      sumNullable(
        labels.map((label) => cells.get(cellKey(platform, label)) ?? null),
      ) ?? 0;
    denominators.set(platform, total);
  }

  const rows: SovRow[] = labels.map((label) => {
    const row: Record<string, SovCell> = {};
    for (const platform of input.attemptedPlatforms) {
      const value = cells.get(cellKey(platform, label)) ?? null;
      const denominator = denominators.get(platform) ?? 0;
      row[platform] = {
        mentions: value,
        sharePct:
          value === null || denominator <= 0
            ? null
            : (value / denominator) * 100,
      };
    }
    return {
      label,
      isTarget: label.toLowerCase() === input.targetValue.toLowerCase(),
      cells: row,
      totalMentions: sumNullable(
        input.attemptedPlatforms.map(
          (platform) => cells.get(cellKey(platform, label)) ?? null,
        ),
      ),
    };
  });

  const matrix: SovMatrix = {
    rows: orderRows(rows),
    platforms: input.attemptedPlatforms,
    measuredPlatforms,
    unavailablePlatforms,
    summary: "",
  };
  matrix.summary = describe(matrix);
  return matrix;
}

/**
 * Target first, then by total mentions descending, with unknown totals last — a
 * brand we could not measure should not outrank one we could.
 *
 * A plain insertion loop rather than `sort`, because `unicorn/no-array-sort`
 * forbids both `sort` and `toSorted` here (the `lib` target predates
 * `toSorted`, so it is not an option). It is also the clearer way to express a
 * *stable* order that keeps the caller's array untouched.
 */
function orderRows(rows: SovRow[]): SovRow[] {
  const ordered: SovRow[] = [];
  for (const row of rows) {
    const rank = rankOf(row);
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      if (other === undefined) continue;
      // Insert *before* the first row that sorts after us. `rankOf` is ascending
      // (target first, then most mentions), so "sorts after" is the larger rank.
      if (rankOf(other) > rank) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, row);
  }
  return ordered;
}

/** Ascending sort key: the target leads, then mentions descending, unknown last. */
function rankOf(row: SovRow): number {
  if (row.isTarget) return Number.NEGATIVE_INFINITY;
  return -(row.totalMentions ?? -1);
}

function describe(matrix: SovMatrix): string {
  const target = matrix.rows.find((row) => row.isTarget);
  if (!target) return "No share-of-voice data was requested.";

  if (matrix.measuredPlatforms.length === 0) {
    return "Every comparison failed, so there is no share-of-voice data. This is not a zero share.";
  }

  const parts = matrix.measuredPlatforms.map((platform) => {
    const cell = target.cells[platform];
    if (cell === undefined || cell.mentions === null) {
      return `${platform}: no data`;
    }
    const pct =
      cell.sharePct === null ? "share unknown" : `${cell.sharePct.toFixed(1)}%`;
    return `${platform}: ${cell.mentions} mentions (${pct})`;
  });

  const missing =
    matrix.unavailablePlatforms.length > 0
      ? ` Not measured: ${matrix.unavailablePlatforms.join(", ")} — the totals above cover only the platforms we could read.`
      : "";

  return `${parts.join(". ")}. Shares are per platform and are never added together.${missing}`;
}
