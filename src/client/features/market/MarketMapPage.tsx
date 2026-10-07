import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Map as MapIcon } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getDomainCategories } from "@/serverFunctions/market";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import {
  summariseMarket,
  toMarketRows,
  type MarketRow,
} from "@/client/features/market/marketModel";

/**
 * The Market Map: the categories a domain ranks in, and what it earns in each.
 *
 * ## The action is priced before it runs, and it costs nothing to look
 *
 * The profile is a Labs request, so nothing is charged until the reader asks for it and the price
 * is on the button — the same shape as the volume check and the page-speed crawl. Opening this page
 * spends nothing.
 *
 * ## Two things the table refuses to hide
 *
 * A category our taxonomy cannot name stays in the table, labelled `Unnamed category (10007)`,
 * with a count of how many that happened to: that is the taxonomy being older than the data, which
 * a reader should see rather than have tidied away. And a row with no measured ETV sorts **last**
 * rather than as zero, so the biggest category on screen is never one nobody measured.
 */
export function MarketMapPage({ projectId }: { projectId: string }) {
  const [target, setTarget] = useState("");

  const analyse = useMutation({
    mutationFn: () => getDomainCategories({ data: { projectId, target } }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not analyse this domain."),
      ),
  });

  const rows = useMemo(
    () => (analyse.data ? toMarketRows(analyse.data.categories) : []),
    [analyse.data],
  );
  const summary = useMemo(() => summariseMarket(rows), [rows]);
  const requestCostUsd = DFS_LABS.standard.perRequest;
  const perCategoryUsd = DFS_LABS.standard.perUnit;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Market Map</h1>
        <p className="text-sm text-base-content/70">
          The product categories a domain ranks in, with the estimated organic
          traffic it earns in each — the shape of the market it actually
          competes in.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (target.trim().length === 0) return;
          analyse.mutate();
        }}
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Domain to profile
          </span>
          <input
            className="input input-bordered w-full"
            placeholder="example.com"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary gap-2"
          disabled={analyse.isPending || target.trim().length === 0}
        >
          {analyse.isPending && <Loader2 className="size-4 animate-spin" />}
          <MapIcon className="size-4" />
          Build the map
        </button>
        <p className="w-full text-xs text-base-content/60">
          One Labs request — about{" "}
          <span className="font-mono">${requestCostUsd.toFixed(3)}</span> plus{" "}
          <span className="font-mono">${perCategoryUsd.toFixed(5)}</span> per
          category returned.
        </p>
      </form>

      {analyse.data ? (
        summary.categoryCount === 0 ? (
          <p className="rounded-xl border border-base-300 p-6 text-sm text-base-content/70">
            This domain ranks in no categories in this market. That is an
            answer, not a failure: a site that ranks for nothing yet has no
            category profile.
          </p>
        ) : (
          <>
            <p className="text-sm text-base-content/80">
              <span className="font-semibold">{summary.categoryCount}</span>{" "}
              categor
              {summary.categoryCount === 1 ? "y" : "ies"}
              {summary.topLabel
                ? `, led by ${summary.topLabel}, with ${Math.round(summary.totalOrganicEtv).toLocaleString()} estimated monthly visits across all categories`
                : ""}
              .
              {summary.unnamedCount > 0
                ? ` ${summary.unnamedCount} carr${summary.unnamedCount === 1 ? "ies" : "y"} a category this product's taxonomy cannot name yet; they are listed rather than dropped.`
                : ""}
            </p>
            <MarketTable rows={rows} />
          </>
        )
      ) : (
        <p className="rounded-xl border border-dashed border-base-300 p-6 text-sm text-base-content/60">
          Nothing is charged until you build the map.
        </p>
      )}
    </div>
  );
}

function MarketTable({ rows }: { rows: MarketRow[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Category</th>
            <th className="text-right">Organic visits / mo</th>
            <th className="text-right">Ranking keywords</th>
            <th className="text-right">Paid keywords</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.criterionIds.join("-")}-${row.label}`}>
              <td title={row.fullPath ?? undefined}>
                <span className="text-sm">{row.label}</span>
                {row.unnamed ? (
                  <span className="badge badge-xs ml-2 border-0 bg-warning/20 text-warning">
                    unnamed
                  </span>
                ) : null}
              </td>
              <td className="text-right font-mono text-xs">
                {row.organicEtv === null
                  ? "—"
                  : Math.round(row.organicEtv).toLocaleString()}
              </td>
              <td className="text-right font-mono text-xs">
                {row.organicCount ?? "—"}
              </td>
              <td className="text-right font-mono text-xs">
                {row.paidCount ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
