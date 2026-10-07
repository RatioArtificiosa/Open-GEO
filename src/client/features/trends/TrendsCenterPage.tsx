import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  countUnmeasured,
  toTrendChart,
  type ChartSeries,
} from "@/client/features/trends/trendChartModel";
import {
  coerceType,
  coerceWindow,
  priceFor,
  TREND_SOURCES,
  typesFor,
  windowsFor,
  type TrendSource,
  type TrendType,
  type TrendWindowValue,
} from "@/client/features/trends/trendSources";
import {
  CROSS_SOURCE_TREND_CAVEAT,
  TREND_SCALE_CAVEAT,
} from "@/server/features/trends/trendSeries";
import { getSearchTrends } from "@/serverFunctions/trends";

/**
 * The Trends Center: whether interest in a term is rising, seasonal, or fading.
 *
 * ## Two indexes, and the screen treats them as two
 *
 * DataForSEO Trends and Google Trends both score 0–100, and neither score is absolute: each is a
 * keyword's peak measured inside its own index and its own request. So the source is a **choice**
 * rather than an overlay, and the screen says plainly that a 90 from one and a 90 from the other
 * are different quantities. Drawing them on one axis would invent a comparison neither vendor
 * makes.
 *
 * The two also accept different vocabularies — `froogle` against `ecommerce`, and two
 * "since inception" presets only Google serves — so switching source **coerces the window and the
 * type** rather than carrying a value the other index would reject and bill for.
 *
 * ## What the chart refuses to do
 *
 * Every line shares **one ruler** — the request's biggest peak — so a forgotten keyword cannot be
 * drawn as tall as a famous one; and a week with no data is a **muted dash, not a floor**, because
 * a zero-height bar is exactly what a real zero looks like. The count of unmeasured points is
 * printed beside the chart, since "flat and low" and "measured in half the weeks" look alike at
 * this size.
 */
export function TrendsCenterPage({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");
  const [source, setSource] = useState<TrendSource>("dataforseo");
  const [type, setType] = useState<TrendType>("web");
  const [timeRange, setTimeRange] =
    useState<TrendWindowValue>("past_12_months");

  const keywords = useMemo(
    () =>
      input
        .split(",")
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword.length > 0)
        .slice(0, 5),
    [input],
  );

  const analyse = useMutation({
    mutationFn: () =>
      getSearchTrends({
        data: {
          projectId,
          keywords,
          source,
          type,
          timeRange,
        },
      }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(
          error,
          "Could not load trends for these terms.",
        ),
      ),
  });

  const chart = useMemo(
    () => (analyse.data ? toTrendChart(analyse.data.series) : null),
    [analyse.data],
  );
  const unmeasured = chart ? countUnmeasured(chart) : 0;
  const requestCostUsd = priceFor(source);

  function chooseSource(next: TrendSource) {
    setSource(next);
    // Coerced, not carried: `2004_present` is Google's and `froogle` is Google's, so sending either
    // to DataForSEO is a task the vendor rejects after charging for it.
    setTimeRange((current) => coerceWindow(next, current));
    setType((current) => coerceType(next, current));
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Trends Center</h1>
        <p className="text-sm text-base-content/70">
          Relative search interest over time, so you can see whether a term is
          climbing, seasonal, or quietly fading.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (keywords.length === 0) return;
          analyse.mutate();
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
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Index
          </span>
          <select
            className="select select-bordered"
            value={source}
            onChange={(event) => {
              const next = TREND_SOURCES.find(
                (option) => option.value === event.target.value,
              );
              if (next) chooseSource(next.value);
            }}
          >
            {TREND_SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Index type
          </span>
          <select
            className="select select-bordered"
            value={type}
            onChange={(event) => {
              const next = typesFor(source).find(
                (option) => option.value === event.target.value,
              );
              if (next) setType(next.value);
            }}
          >
            {typesFor(source).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-base-content/70">
            Window
          </span>
          <select
            className="select select-bordered"
            value={timeRange}
            onChange={(event) => {
              // Validated rather than asserted: the select hands back a string, and the repo bans
              // the narrowing cast that would turn it into one of these values unchecked.
              const next = windowsFor(source).find(
                (option) => option.value === event.target.value,
              );
              if (next) setTimeRange(next.value);
            }}
          >
            {windowsFor(source).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="btn btn-primary gap-2"
          disabled={analyse.isPending || keywords.length === 0}
        >
          {analyse.isPending && <Loader2 className="size-4 animate-spin" />}
          <TrendingUp className="size-4" />
          Chart interest
        </button>
        <p className="w-full text-xs text-base-content/60">
          One request — about{" "}
          <span className="font-mono">${requestCostUsd.toFixed(4)}</span>{" "}
          whether it carries one keyword or five. {CROSS_SOURCE_TREND_CAVEAT}
        </p>
      </form>

      {chart && chart.series.length > 0 ? (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-base-300 p-4">
            {chart.series.map((entry) => (
              <TrendLine key={entry.keyword} series={entry} peak={chart.peak} />
            ))}
          </div>
          <p className="text-xs text-base-content/60">
            {TREND_SCALE_CAVEAT}
            {unmeasured > 0
              ? ` ${unmeasured} point${unmeasured === 1 ? "" : "s"} across these lines had no data and are drawn as gaps.`
              : ""}
            {chart.peak === null
              ? " Nothing on this chart had a measured value."
              : ""}
          </p>
        </>
      ) : analyse.data ? (
        <p className="rounded-xl border border-base-300 p-6 text-sm text-base-content/70">
          The vendor returned no graph for these terms. That is an answer about
          its index rather than a failure of the request — a term nobody
          searches, or one too new to have history.
        </p>
      ) : (
        <p className="rounded-xl border border-dashed border-base-300 p-6 text-sm text-base-content/60">
          Nothing is charged until you chart something.
        </p>
      )}
    </div>
  );
}

/**
 * One keyword's line, drawn as bars.
 *
 * A measured point is a bar whose height is its share of the request's peak. An unmeasured point is
 * a **muted dash at the floor**, not an empty space: a gap reads as missing data on a chart this
 * short only if it is marked, and an unmarked gap is indistinguishable from a bar of zero height —
 * which is the confusion this whole path exists to avoid.
 */
function TrendLine({
  series,
  peak,
}: {
  series: ChartSeries;
  peak: number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{series.keyword}</span>
        <span className="font-mono text-xs text-base-content/60">
          {series.average === null ? "no average" : `avg ${series.average}`}
          {peak === null ? "" : ` · peak of this request: ${peak}`}
        </span>
      </div>
      <div
        className="flex h-12 items-end gap-px"
        role="img"
        aria-label={`Interest over time for ${series.keyword}`}
      >
        {series.points.map((point, index) => (
          <span
            key={`${point.dateFrom}-${index}`}
            className={
              point.unmeasured
                ? "w-full rounded-sm bg-base-content/15"
                : "w-full rounded-sm bg-primary/70"
            }
            style={
              point.unmeasured
                ? { height: "2px" }
                : { height: `${point.heightPct ?? 0}%` }
            }
            title={
              point.unmeasured
                ? `${point.dateFrom ?? ""}: no data in the vendor's index`
                : `${point.dateFrom ?? ""}: ${point.value}`
            }
          />
        ))}
      </div>
    </div>
  );
}
