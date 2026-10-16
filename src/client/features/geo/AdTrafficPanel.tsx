import { useMutation } from "@tanstack/react-query";
import { Loader2, ReceiptText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getAdTrafficCrossCheck } from "@/serverFunctions/keywords";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * Ad-traffic cross-check (CL-723 surface).
 *
 * What a Google Ads plan for these keywords is expected to return — clicks,
 * average CPC and cost — beside the organic numbers, never as a forecast of
 * its own. Nothing is charged until the button is pressed, and the price is
 * on it: one request whatever it carries, read from the book. The
 * deprecation guardrail renders where a chart would otherwise invent flat
 * lines: impressions and ctr are refused by name, never drawn.
 */

const MAX_KEYWORDS = 10;

export function AdTrafficPanel({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");

  const keywords = input
    .split(",")
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_KEYWORDS);

  const check = useMutation({
    mutationFn: () => getAdTrafficCrossCheck({ data: { projectId, keywords } }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not run the cross-check."),
      ),
  });

  const requestUsd = DFS_KEYWORDS.adTrafficForecast.standard.perRequest;
  const rows = check.data?.rows ?? [];

  return (
    <section className="rounded-lg border border-base-content/10 p-4">
      <h2 className="text-base font-semibold">Paid cross-check</h2>
      <p className="mt-1 text-sm text-base-content/70">
        A paid plan&apos;s expected return for these keywords, beside the
        organic numbers above. It cannot corroborate them — paid and organic are
        different systems.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (keywords.length === 0) return;
          check.mutate();
        }}
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Keywords, comma separated (up to {MAX_KEYWORDS})
          </span>
          <input
            className="input input-bordered w-full"
            placeholder="crm software, sales pipeline tool"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary gap-2"
          disabled={check.isPending || keywords.length === 0}
        >
          {check.isPending && <Loader2 className="size-4 animate-spin" />}
          <ReceiptText className="size-4" />
          Check paid cost
        </button>
        <p className="w-full text-xs text-base-content/60">
          One request — about{" "}
          <span className="font-mono">${requestUsd.toFixed(4)}</span> whether it
          carries one keyword or ten.
        </p>
      </form>

      {check.isSuccess ? (
        rows.length === 0 ? (
          <p className="mt-3 text-sm text-base-content/70">
            The vendor returned no paid figures for these keywords. That is an
            answer about its index, not a forecast of zero cost.
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-hidden rounded-xl border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th className="text-right">Clicks</th>
                    <th className="text-right">Avg CPC</th>
                    <th className="text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.keyword}>
                      <td className="text-sm">{row.keyword}</td>
                      <td className="text-right font-mono text-xs">
                        {row.values.clicks ?? "—"}
                      </td>
                      <td className="text-right font-mono text-xs">
                        {row.values.average_cpc == null
                          ? "—"
                          : `$${row.values.average_cpc}`}
                      </td>
                      <td className="text-right font-mono text-xs">
                        {row.values.cost == null ? "—" : `$${row.values.cost}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {check.data?.refusal ? (
              <p className="mt-2 text-xs text-base-content/60">
                {check.data.refusal}
              </p>
            ) : null}
          </>
        )
      ) : !check.isPending && !check.isIdle ? (
        <p className="mt-3 text-sm text-base-content/70">
          This panel could not be read. That is a fault here, not a statement
          about paid costs.
        </p>
      ) : null}
    </section>
  );
}
