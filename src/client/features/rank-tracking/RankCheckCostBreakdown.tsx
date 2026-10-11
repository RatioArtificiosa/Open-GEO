import { useQuery } from "@tanstack/react-query";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { estimateRankCheckSpend } from "@/serverFunctions/billing";

/**
 * What a rank check costs, for a configuration that is still being edited.
 *
 * ## Why this asks the server
 *
 * The multiplier applied to a vendor cost is an operator dial resolved per
 * request (see `src/server/billing/costMarkup.ts`), and it used to be a
 * constant in a module this component bundled — so the rate shipped to every
 * browser and the figure shown here could drift from the figure charged. The
 * shape of the check travels to the server and only the number comes back.
 *
 * A missing estimate renders as "…" rather than a fallback number: a price
 * shown while the request is in flight and then corrected is worse than a
 * placeholder, because the reader cannot tell which one they saw.
 */
export function RankCheckCostBreakdown({
  projectId,
  devices,
  serpDepth,
  schedule,
}: {
  projectId: string;
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  schedule: "daily" | "weekly" | "monthly" | "manual";
}) {
  const method = schedule === "manual" ? "live" : "queued";
  const { data: spend } = useQuery({
    queryKey: [
      "rankCheckSpendEstimate",
      projectId,
      1,
      devices,
      serpDepth,
      method,
    ],
    queryFn: () =>
      estimateRankCheckSpend({
        data: { projectId, keywordCount: 1, devices, serpDepth, method },
      }),
  });
  const costPerKeywordUsd = spend?.costUsd ?? null;
  const checksPerMonth =
    schedule === "daily" ? 30 : schedule === "weekly" ? 4 : 1;

  return (
    <div className="rounded-lg bg-base-200/50 px-3 py-2.5 text-xs text-base-content/70 space-y-0.5">
      <div>
        <span className="font-mono font-semibold text-base-content">
          {costPerKeywordUsd === null
            ? "…"
            : `~$${costPerKeywordUsd.toFixed(4)}`}
        </span>{" "}
        per keyword per check
      </div>
      {schedule !== "manual" && (
        <div>
          50 keywords would cost{" "}
          <span className="font-mono font-semibold text-base-content">
            {costPerKeywordUsd === null
              ? "…"
              : `~$${(costPerKeywordUsd * 50 * checksPerMonth).toFixed(2)}`}
          </span>
          /month
        </div>
      )}
    </div>
  );
}
