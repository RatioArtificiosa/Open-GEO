import { Loader2, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@/client/components/Modal";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import {
  devicesCount,
  KEYWORDS_PER_BATCH,
  SECONDS_PER_BATCH,
} from "@/shared/rank-tracking";
import { estimateRankCheckSpend } from "@/serverFunctions/billing";

export function CheckConfirmModal({
  projectId,
  keywordCount,
  devices,
  serpDepth,
  isPending,
  onRunNow,
  onCancel,
}: {
  projectId: string;
  keywordCount: number;
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  isPending: boolean;
  onRunNow: () => void;
  onCancel: () => void;
}) {
  // Priced by the server, at the live multiplier. The number the confirm
  // dialog shows and the number the charge deducts have to come from the same
  // place, and the multiplier itself must not be a value the client can hold.
  const { data: spend } = useQuery({
    queryKey: [
      "rankCheckSpendEstimate",
      projectId,
      keywordCount,
      devices,
      serpDepth,
    ],
    queryFn: () =>
      estimateRankCheckSpend({
        data: { projectId, keywordCount, devices, serpDepth, method: "live" },
      }),
  });
  const dc = devicesCount(devices);
  const totalChecks = keywordCount * dc;
  const liveTime =
    Math.ceil(totalChecks / KEYWORDS_PER_BATCH) * SECONDS_PER_BATCH;
  // **The refusal is a pre-flight, not a consequence.**
  //
  // The dialog priced a check in full and then let the run proceed at any
  // balance, so a customer with no credits learned it from a failed charge.
  // The transport already refuses an unaffordable turn — but that refusal
  // arrives *after* the call was made, which is the wrong side of it. The
  // balance travels with the estimate from the same read the gate uses, so the
  // number here and the number judged there cannot disagree.
  // A missing balance is not a refusal: the query is still loading, and
  // treating "unknown" as "cannot afford" would block the run for a customer
  // who can pay while it decides.
  const unaffordable = spend !== undefined && !spend.affordable;
  const shortfall = spend
    ? Math.max(0, spend.costCredits - spend.balanceCredits)
    : 0;

  return (
    <Modal
      maxWidth="max-w-md"
      onClose={onCancel}
      labelledBy="rank-check-confirm-title"
    >
      <div>
        <h3 id="rank-check-confirm-title" className="text-lg font-semibold">
          Check {keywordCount} keyword
          {keywordCount !== 1 ? "s" : ""}
        </h3>
        <p className="text-sm text-base-content/60 mt-1">
          {keywordCount} keywords &times; {dc} device
          {dc !== 1 ? "s" : ""} = {totalChecks} SERP checks
        </p>
      </div>

      <button
        className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-base-300 disabled:hover:bg-transparent"
        onClick={onRunNow}
        disabled={isPending || unaffordable}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Zap className="size-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium">Run Now</p>
          <p className="text-xs text-base-content/60">
            {unaffordable
              ? `This check needs ${spend?.costCredits ?? 0} credits and you have ${spend?.balanceCredits ?? 0}. Add ${shortfall} credits to run it.`
              : `Results in ~${liveTime < 60 ? `${liveTime}s` : `${Math.ceil(liveTime / 60)} min`}`}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono font-semibold">
            {spend ? `~$${spend.costUsd.toFixed(2)}` : "—"}
          </p>
          {isPending && <Loader2 className="size-3 animate-spin ml-auto" />}
        </div>
      </button>

      <button className="btn btn-ghost btn-sm self-center" onClick={onCancel}>
        Cancel
      </button>
    </Modal>
  );
}
