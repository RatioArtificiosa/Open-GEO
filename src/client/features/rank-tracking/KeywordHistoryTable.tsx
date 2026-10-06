import { reverse } from "remeda";
import type { RankKeywordHistoryPoint } from "@/serverFunctions/rank-tracking";
import { hasAiOverview } from "@/shared/serp-features";
import { DeviceRankCell, SerpFeatureTags } from "./RankTrackingTableParts";

/**
 * The keyword-history table, and the row vocabulary the export shares with it.
 *
 * Split out of `KeywordTrendModal` when that file crossed the line budget, which was
 * the honest fix: the modal was carrying the chart, the export **and** the table, and
 * the table's row-mapping is a rule the CSV export depends on being the same one.
 */

export const DEVICE_STYLE: Record<
  "desktop" | "mobile",
  { label: string; color: string }
> = {
  desktop: { label: "Desktop", color: "var(--color-accent, #F59E0B)" },
  mobile: { label: "Mobile", color: "#34D399" },
};

/**
 * One list for copy and export, because they are the same table.
 *
 * Kept here after the two handlers each owned a copy: a column added to one and not the
 * other silently produces two different CSVs from one table.
 */
export const HISTORY_CSV_HEADERS = [
  "Date",
  "Device",
  "Position",
  "Change vs previous",
  "AI Overview",
];

interface HistoryRow {
  device: "desktop" | "mobile";
  checkedAt: string;
  position: number | null;
  previousPosition: number | null;
  /** `null` = this check has no feature record; `[]` = checked, none present. */
  serpFeatures: string[] | null;
}

/**
 * One row per snapshot (newest first) with the previous-check position for the same
 * device, so the Δ column can reuse DeviceRankCell's 4-case logic.
 *
 * `serpFeatures` rides through untouched, `null` included — the AI-Overview read is a
 * claim about *presence*, and the states that are not a yes must stay distinguishable.
 */
export function buildHistoryRows(
  points: RankKeywordHistoryPoint[],
): HistoryRow[] {
  const prevByDevice = new Map<"desktop" | "mobile", number | null>();
  const rows: HistoryRow[] = [];
  // points are oldest-first; walk forward to capture the prior position.
  for (const p of points) {
    const hadPrevious = prevByDevice.has(p.device);
    rows.push({
      device: p.device,
      checkedAt: p.checkedAt,
      position: p.position,
      previousPosition: hadPrevious
        ? (prevByDevice.get(p.device) ?? null)
        : null,
      serpFeatures: p.serpFeatures,
    });
    prevByDevice.set(p.device, p.position);
  }
  return reverse(rows);
}

export function KeywordHistoryTable({
  rows,
  devices,
  serpDepth,
}: {
  rows: HistoryRow[];
  devices: Array<"desktop" | "mobile">;
  /** The run's tracking depth, for the "not in top N" wording. */
  serpDepth: number;
}) {
  // **The GEO tie-in: "are you in the answer?", over time.** Two denominators on
  // purpose — a check with no feature record cannot answer the question, and counting
  // it as a "no" would invent a citation loss that never happened.
  const recorded = rows.filter((row) => row.serpFeatures !== null);
  const present = recorded.filter((row) =>
    hasAiOverview(row.serpFeatures),
  ).length;
  const unrecorded = rows.length - recorded.length;

  return (
    <>
      {recorded.length > 0 && (
        <p className="text-xs text-base-content/60">
          {present > 0
            ? `In an AI Overview for ${present} of ${recorded.length} recorded checks`
            : `Never in an AI Overview across ${recorded.length} recorded checks`}
          {unrecorded > 0 &&
            ` · ${unrecorded} check${unrecorded === 1 ? "" : "s"} with no SERP-feature record`}
        </p>
      )}

      <div className="max-h-64 overflow-auto rounded-lg border border-base-300">
        <table className="table table-sm">
          <thead className="sticky top-0 bg-base-100">
            <tr>
              <th>Date</th>
              {devices.length > 1 && <th>Device</th>}
              <th>Position</th>
              <th>Δ vs previous check</th>
              <th>SERP features</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              // No prior ranking to compare against (first check, or the previous
              // check was unranked): show the lone position as a centered neutral pill
              // so it doesn't look like a stray number next to the "before → after"
              // rows.
              const noPrevious =
                r.position !== null && r.previousPosition === null;
              return (
                <tr key={`${r.device}-${r.checkedAt}-${idx}`}>
                  <td className="whitespace-nowrap text-xs">
                    {new Date(r.checkedAt).toLocaleDateString()}
                  </td>
                  {devices.length > 1 && (
                    <td className="text-xs">{DEVICE_STYLE[r.device].label}</td>
                  )}
                  <td>
                    {r.position === null ? (
                      <span className="text-base-content/40 text-xs">
                        Not in top {serpDepth}
                      </span>
                    ) : noPrevious ? (
                      // Invisible placeholders matching the "before → after" layout so
                      // the lone pill lines up under the position badge column instead
                      // of floating.
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-6" aria-hidden />
                        <span aria-hidden className="opacity-0">
                          →
                        </span>
                        <span className="font-mono rounded bg-base-200 px-1.5 py-0.5 text-xs font-semibold text-base-content/70">
                          {r.position}
                        </span>
                      </span>
                    ) : (
                      <DeviceRankCell
                        result={{
                          position: r.position,
                          previousPosition: r.previousPosition,
                          rankingUrl: null,
                          serpFeatures: r.serpFeatures ?? [],
                        }}
                      />
                    )}
                  </td>
                  <td>
                    {/* Three states, and the third is not a "no": a check with no
                        feature record cannot say whether an AI Overview was there. */}
                    {r.serpFeatures === null ? (
                      <span
                        className="text-base-content/40 text-xs"
                        title="No SERP-feature record for this check — it was stored before features were captured."
                      >
                        not recorded
                      </span>
                    ) : r.serpFeatures.length === 0 ? (
                      <span
                        className="text-base-content/30 text-xs"
                        title="Checked, and no tracked SERP feature was present."
                      >
                        —
                      </span>
                    ) : (
                      <SerpFeatureTags features={r.serpFeatures} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
