import { sortBy } from "remeda";
import type { MonthlySearch } from "@/types/keywords";

/**
 * A trend in one line, for a table cell.
 *
 * §14.4 lists sparklines among the signature components, and this is what the job
 * is: the number beside it is the value, and the line is the *shape* of the last
 * twelve months — so a reader sees "rising", "flat" or "falling" at a glance
 * without opening the row.
 *
 * **Muted ink, never the accent.** DESIGN.md §2.3 caps amber at ~3% of a viewport
 * precisely because it is a *signal* colour; a sparkline in every row of a
 * fifty-row table would put the signal everywhere and therefore mark nothing.
 * §2.4's delta rule points the same way — a change is coloured only when it is
 * statistically meaningful, and painting twelve months of monthly volume green or
 * red is noise.
 *
 * **`aria-hidden`, and the redundancy is deliberate.** The volume column beside it
 * carries the number a screen reader needs, so this line needs no label of its
 * own; a sparkline that announced itself would read the same value twice.
 *
 * **Two points is the floor.** One reading is not a trend, and a line drawn
 * through it would be an assertion about a direction nobody measured — so a
 * single point renders the same dash the table uses for "no figure".
 */

/** Sort oldest-first and keep the last twelve, as `MonthlySearch[]` arrives. */
export function sparklineValues(points: MonthlySearch[]): number[] {
  // `remeda`'s `sortBy` rather than `Array#sort`, and not `toSorted` either:
  // the lint wants the ES2023 method, but `lib` is ES2022 so the type does not
  // exist here — the same trap this repo's ledger already paid for once.
  return sortBy(points, (point) => point.year * 100 + point.month)
    .slice(-12)
    .map((point) => point.searchVolume);
}

/**
 * The SVG path for a series in a `width` × `height` box, or `null` when there is
 * no trend to draw.
 *
 * Exported and pure so the geometry is tested without a DOM: the mapping is the
 * only claim here, and a line whose peaks point down is the chart equivalent of a
 * confident wrong number. A **flat series draws a level line at mid-height**
 * rather than dividing by a zero span.
 */
export function sparklinePath(
  values: number[],
  width: number,
  height: number,
  padding = 2,
): string | null {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usable = height - padding * 2;
  const stepX = width / (values.length - 1);

  return values
    .map((value, index) => {
      const y =
        span === 0 ? height / 2 : padding + usable * (1 - (value - min) / span);
      const x = index * stepX;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function Sparkline({
  points,
  width = 72,
  height = 20,
}: {
  points: MonthlySearch[];
  width?: number;
  height?: number;
}) {
  const path = sparklinePath(sparklineValues(points), width, height);

  if (path === null) {
    return <span className="text-base-content/35">-</span>;
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      className="text-base-content/45"
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
