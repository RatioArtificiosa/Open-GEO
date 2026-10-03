import { z } from "zod";
import { forecastTraffic } from "@/server/features/audit/services/trafficForecast";
import { getEtvSeries } from "@/server/features/geo/services/geoSeriesReads";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { findGeoTarget, geoDomainSchema } from "@/server/mcp/tools/geo-shared";

/**
 * `forecast_traffic` — 13 weeks of projected organic clicks, from the stored
 * ETV series.
 *
 * ## Why this is a wire and not a build
 *
 * `forecastTraffic` has existed with 14 tests, and `getEtvSeries` is the
 * reader behind the dashboard's traffic chart. **Neither was reachable from
 * MCP** — this is the same shape as `get_geo_top_citations` and
 * `ai_keyword_volume`, one layer down: a tested capability with no wire.
 *
 * ## What it will not do, and the reasons are the product
 *
 * Three refusals travel with every answer, because each of them is a way a
 * forecast becomes confidently wrong:
 *
 * 1. **It does not project across the ETV cutover as if nothing changed.**
 *    DataForSEO switches ETV formula on a fixed date. There is no published
 *    conversion, so a series spanning it is *reported* as spanning it, with
 *    both dates named. A smooth line across two different currencies would be
 *    the more convincing chart and the less true one.
 * 2. **A missing week stays missing.** Bucketing the daily series leaves a
 *    week with no capture as `null`, and `null` is excluded from the fit
 *    rather than imputed as zero — imputing it invents a collapse and then
 *    projects it forward for three months.
 * 3. **"No trend" is not "flat".** Under eight weeks of history there is no
 *    seasonal factor and no slope, and the answer says so rather than
 *    projecting a flat line that reads as a prediction.
 *
 * ## The band is the answer; the point estimate is not
 *
 * The band widens with the horizon and with the volatility of the history,
 * and every low/high is `null` rather than `0` when there is no basis for
 * one — a forecast of zero traffic is a much stronger claim than "we know
 * little".
 */

/** Seven days, so a bucket is a calendar week and the labels read as dates. */
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** How many weekly buckets to hand the forecaster. */
const HISTORY_WEEKS = 26;

const inputSchema = {
  projectId: projectIdSchema,
  domain: geoDomainSchema,
  endpoint: z
    .enum(["domain_rank_overview", "ranked_keywords", "relevant_pages"])
    .optional()
    .describe(
      "Which stored ETV series to forecast. Defaults to domain_rank_overview. These compute ETV over different populations, so they are never mixed and never compared.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview what would be read without running the query. Set dry_run: false to build the forecast. Forecasting reads the stored archive and spends no vendor credits.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * Bucket the daily ETV points into calendar weeks, oldest first.
 *
 * A week with no capture is `null`, not zero — see the module note above. The
 * sum is the week's measured clicks; `null` means we did not measure that week
 * and the forecaster excludes it from the fit.
 */
function toWeeklyHistory(
  points: Array<{ date: string; etv: number | null }>,
): Array<number | null> {
  if (points.length === 0) return [];

  // Anchor the buckets on the first stored point so the series is a fixed set
  // of weeks rather than a moving window, which would silently drop the oldest
  // week every time a capture lands.
  const first = Date.parse(`${points[0]?.date ?? ""}T00:00:00Z`);
  if (Number.isNaN(first)) return [];

  const buckets = new Map<number, { total: number; measured: boolean }>();
  for (const point of points) {
    const at = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(at)) continue;
    const week = Math.floor((at - first) / MS_PER_WEEK);
    const bucket = buckets.get(week) ?? { total: 0, measured: false };
    if (typeof point.etv === "number") {
      bucket.total += point.etv;
      bucket.measured = true;
    }
    buckets.set(week, bucket);
  }

  const lastWeek = Math.max(...buckets.keys());
  const weeks: Array<number | null> = [];
  for (let week = 0; week <= lastWeek; week += 1) {
    const bucket = buckets.get(week);
    // A week present in the range but never measured is null, not 0.
    weeks.push(bucket?.measured === true ? Math.round(bucket.total) : null);
  }
  return weeks.slice(-HISTORY_WEEKS);
}

export const forecastTrafficTool = {
  name: "forecast_traffic",
  config: {
    title: "Forecast organic traffic",
    description:
      "Projects 13 weeks of organic clicks from this domain's stored ETV series, with a band that widens by horizon and volatility. Reads the archive — no vendor credits, no live call. Refusals that travel with the answer: a missing week stays missing rather than being counted as zero; fewer than 8 weeks of history produces no trend and no seasonal factor rather than a flat prediction; and a window crossing DataForSEO's ETV formula change is reported as crossing it, because there is no published conversion and two currencies are not one line. The band is the answer — the point estimate is not a promise. dry_run defaults to true; set dry_run: false to build the forecast.",
    inputSchema,
    outputSchema: z
      .object({
        domain: z.string(),
        endpoint: z.string(),
        points: z.array(
          z
            .object({
              date: z.string(),
              expected: z.number().nullable(),
              low: z.number().nullable(),
              high: z.number().nullable(),
            })
            .passthrough(),
        ),
        basis: z
          .object({
            formulaVersion: z.string(),
            crossesCutover: z.boolean(),
            cutoverDate: z.string(),
            warning: z.string().nullable(),
          })
          .passthrough(),
        historyWeeks: z.number(),
        seasonalFactorApplied: z.boolean(),
        coverage: z.string(),
        summary: z.string(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    if (args.dry_run !== false) {
      return mcpResponse({
        text: [
          `Dry run: forecast_traffic would read the stored ETV series for "${args.domain}" (endpoint: ${args.endpoint ?? "domain_rank_overview"}) and project 13 weeks from it.`,
          `This reads the archive and spends no DataForSEO credits. Re-run with dry_run: false to build the forecast.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          domain: args.domain,
          endpoint: args.endpoint ?? "domain_rank_overview",
        },
      });
    }

    // Resolved through the target so an unmonitored domain is one sentence
    // rather than an MCP validation error the caller cannot interpret. The
    // read then re-derives the market from the target itself.
    const target = await findGeoTarget(args.projectId, args.domain);
    if (!target) {
      return mcpResponse({
        text: `"${args.domain}" is not a monitored target in this project, so there is no stored traffic series to forecast.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: { domain: args.domain, forecastUnavailable: true },
      });
    }

    const endpoint = args.endpoint ?? "domain_rank_overview";
    const series = await getEtvSeries({
      projectId: args.projectId,
      domain: target.domain,
      endpoint,
      limit: 400,
    });

    const history = toWeeklyHistory(series.points);
    const forecast = forecastTraffic({
      history,
      // The series' own formula stamp travels with the answer rather than being
      // assumed: the module refuses to blend the two versions across a cutover.
      provenance: {
        formulaVersion: series.formulaVersions.includes("new")
          ? "new"
          : "legacy",
      },
      today: new Date().toISOString().slice(0, 10),
    });

    const lines = [
      `Traffic forecast for "${series.domain}" (endpoint: ${series.endpoint}):`,
      "",
      forecast.summary,
      "",
      forecast.coverage,
    ];
    if (forecast.basis.warning) {
      lines.push("", `WARNING: ${forecast.basis.warning}`);
    }

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        domain: series.domain,
        endpoint: series.endpoint,
        points: forecast.points,
        basis: forecast.basis,
        historyWeeks: forecast.historyWeeks,
        seasonalFactorApplied: forecast.seasonalFactorApplied,
        coverage: forecast.coverage,
        summary: forecast.summary,
      },
    });
  }),
};
