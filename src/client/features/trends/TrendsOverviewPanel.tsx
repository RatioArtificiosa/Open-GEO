import { useMemo, useState } from "react";
import { sortBy } from "remeda";
import { useMutation } from "@tanstack/react-query";
import { Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getTrendsOverview } from "@/serverFunctions/trends";
import { TREND_SCALE_CAVEAT } from "@/server/features/trends/trendSeries";
import { DEMOGRAPHY_PER_KEYWORD_CAVEAT } from "@/server/features/trends/demography";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * The whole picture: interest over time, where it is, and who it is.
 *
 * ## Why it is one request rather than three
 *
 * The merged endpoint returns all three views together, so they **share one window and one
 * location** and cannot disagree about the period they describe. Fetching them separately could
 * produce three answers to what looks like one question, with the discrepancy invisible.
 *
 * It costs what the three cost separately, so this is a **guarantee, not a saving**: one button,
 * one price, one window.
 *
 * ## And it says what the numbers are
 *
 * Each block is normalised differently — the series inside its own request, the regional and
 * demographic scores against each keyword's own peak — so both caveats are printed beside the data
 * rather than left for a reader to assume the three are comparable.
 */
export function TrendsOverviewPanel({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");

  const keywords = useMemo(
    () =>
      input
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0)
        .slice(0, 5),
    [input],
  );

  const run = useMutation({
    mutationFn: () => getTrendsOverview({ data: { projectId, keywords } }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not load the whole picture."),
      ),
  });

  const overview = run.data;
  const requestCostUsd = DFS_KEYWORDS.dfsTrends.mergedData.perRequest;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-base-300 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">The whole picture</h2>
        <p className="text-sm text-base-content/70">
          One request: interest over time, the regional split, and the age and
          gender breakdown, all describing the same window and place.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (keywords.length === 0) return;
          run.mutate();
        }}
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Keywords, comma separated (up to 5)
          </span>
          <input
            className="input input-bordered w-full"
            placeholder="standing desk, treadmill desk"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn btn-primary gap-2"
          disabled={run.isPending || keywords.length === 0}
        >
          {run.isPending && <Loader2 className="size-4 animate-spin" />}
          <Layers className="size-4" />
          Load all three
        </button>
        <p className="w-full text-xs text-base-content/60">
          One request — about{" "}
          <span className="font-mono">${requestCostUsd.toFixed(4)}</span>, the
          same as the three separate views would cost together.{" "}
          {TREND_SCALE_CAVEAT}
        </p>
      </form>

      {overview ? (
        overview.series.length === 0 ? (
          <p className="text-sm text-base-content/70">
            The vendor returned nothing for these terms, which is an answer
            about its index rather than a failure of the request.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <OverviewRow
              title="Interest over time"
              rows={overview.series.map((entry) => entry.keyword)}
            />
            <OverviewRow
              title="Top regions"
              rows={topRegions(overview.regions)}
            />
            <OverviewRow
              title="Age and gender"
              rows={topDemography(overview.demography)}
            />
            <p className="text-xs text-base-content/60">
              {DEMOGRAPHY_PER_KEYWORD_CAVEAT}
            </p>
          </div>
        )
      ) : (
        <p className="text-xs text-base-content/60">
          Nothing is charged until you load it.
        </p>
      )}
    </section>
  );
}

/** The strongest locations for the first keyword, as \`place score\` strings. */
function topRegions(
  regions: Array<{
    keyword: string;
    locations: Array<{ geo: string; value: number | null }>;
  }>,
): string[] {
  const first = regions[0];
  if (!first) return [];
  return sortBy(
    first.locations.filter((row) => row.value !== null),
    (row) => -(row.value ?? 0),
  )
    .slice(0, 5)
    .map((row) => row.geo + " " + row.value);
}

/** The strongest age band and the gender split for the first keyword. */
function topDemography(
  demography: Array<{
    keyword: string;
    age: Array<{ bucket: string; value: number | null }>;
    gender: Array<{ bucket: string; value: number | null }>;
  }>,
): string[] {
  const first = demography[0];
  if (!first) return [];
  const strongest = sortBy(
    first.age.filter((row) => row.value !== null),
    (row) => -(row.value ?? 0),
  )[0];
  const genders = first.gender
    .filter((row) => row.value !== null)
    .map((row) => row.bucket + " " + row.value)
    .join(", ");
  return [
    strongest ? "strongest band " + strongest.bucket : "no age data",
    genders.length > 0 ? "gender " + genders : "no gender data",
  ];
}

function OverviewRow({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-base-content/70">{title}</span>
      <span className="font-mono text-xs">
        {rows.length > 0 ? rows.join(" / ") : "no data"}
      </span>
    </div>
  );
}
