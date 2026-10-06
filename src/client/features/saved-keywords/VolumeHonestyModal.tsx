import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BadgeCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import { reconcileKeywordVolumes } from "@/serverFunctions/keywords";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";
import {
  formatVolume,
  reconciliationHeadline,
  verdictBadge,
} from "./volumeHonestyModel";

/**
 * "Data Honesty": does the volume we show survive a second opinion?
 *
 * ## Nothing is charged until the reader asks
 *
 * The check costs real money (one clickstream request, billed per call) so it opens on a
 * confirm card with the price on it, exactly like starting a rank check. Running it on open
 * would bill somebody for closing a modal.
 *
 * ## The disagreement is not an error
 *
 * Google Ads reports a grouped estimate, so a keyword can inherit a cluster's total. When the
 * measured figure disagrees that is information about the *estimate*, not a fault, and the
 * panel says so in the row's own words rather than colouring it red.
 */
export function VolumeHonestyModal({
  projectId,
  keywords,
  onClose,
}: {
  projectId: string;
  keywords: string[];
  onClose: () => void;
}) {
  const [checking, setChecking] = useState(false);

  const check = useMutation({
    mutationFn: () =>
      reconcileKeywordVolumes({ data: { projectId, keywords } }),
    onSuccess: (result) => {
      captureClientEvent("saved_keywords:volume_reconciliation", {
        keywords: result.summary.total,
        corroborated: result.summary.corroborated,
      });
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Could not check these volumes."),
      );
      setChecking(false);
    },
  });

  const arbitrationCostUsd = DFS_KEYWORDS.clickstream.global.perRequest ?? 0;

  return (
    <Modal
      maxWidth="max-w-2xl"
      labelledBy="volume-honesty-title"
      onClose={onClose}
    >
      <div>
        <h3 id="volume-honesty-title" className="text-lg font-semibold">
          Volume confidence
        </h3>
        <p className="text-xs text-base-content/60">
          {keywords.length} selected keyword
          {keywords.length === 1 ? "" : "s"} checked against
          clickstream-measured volume for your project&rsquo;s market.
        </p>
      </div>

      {check.data ? (
        <ReconciliationResults result={check.data} />
      ) : (
        <>
          <p className="text-sm text-base-content/70">
            Every volume here comes from Google Ads, which reports one figure
            for a group of close variants, so a keyword can inherit its
            neighbour&rsquo;s total. This asks an independent source whether the
            numbers hold up, and says so per keyword.
          </p>

          <button
            type="button"
            className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
            onClick={() => {
              setChecking(true);
              check.mutate();
            }}
            disabled={checking}
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BadgeCheck className="size-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="font-medium">Check these volumes</p>
              <p className="text-xs text-base-content/60">
                Measured volume comes from panel data, not from Google Ads
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono font-semibold">
                ~${arbitrationCostUsd.toFixed(2)}
              </p>
              <p className="text-xs text-base-content/60">
                per call, plus the metrics request
              </p>
              {checking && (
                <Loader2 className="size-3 animate-spin ml-auto mt-1" />
              )}
            </div>
          </button>
        </>
      )}

      <div className="flex justify-end">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function ReconciliationResults({
  result,
}: {
  result: {
    countryIsoCode: string;
    summary: {
      total: number;
      corroborated: number;
      uncomparable: number;
      corroborationRate: number | null;
    };
    rows: Array<{
      keyword: string;
      referenceVolume: number | null;
      countryVolume: number | null;
      globalVolume: number | null;
      verdict: string;
      note: string;
    }>;
  };
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">{reconciliationHeadline(result.summary)}</p>

      <div className="max-h-72 overflow-auto rounded-lg border border-base-300">
        <table className="table table-sm">
          <thead className="sticky top-0 bg-base-100">
            <tr>
              <th>Keyword</th>
              <th className="text-right">Shown</th>
              <th className="text-right">Measured</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => {
              const badge = verdictBadge(row.verdict);
              return (
                <tr key={row.keyword}>
                  <td className="text-xs">{row.keyword}</td>
                  <td className="text-right font-mono text-xs">
                    {formatVolume(row.referenceVolume)}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {formatVolume(row.countryVolume)}
                  </td>
                  <td>
                    <span
                      className={`badge badge-sm border-0 ${badge.className}`}
                      title={`${badge.hint} ${row.note}`}
                    >
                      {badge.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-base-content/50">
        Measured volume is the clickstream figure for {result.countryIsoCode}.
        The global figure the vendor also returns is deliberately not shown as a
        comparison: it covers every country, so setting it beside a single
        market&rsquo;s number would overstate the gap enormously.
      </p>
    </div>
  );
}
