import { createServerFn } from "@tanstack/react-start";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { readTrendSeries } from "@/server/features/trends/trendSeries";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { getSearchTrendsSchema } from "@/types/schemas/trends";

// The two clients have deliberately different vocabularies, so the source decides which is called
// and the page only offers the values that source accepts. These are *values* rather than type
// aliases so a request can be checked against them by lookup: the repository bans the narrowing
// cast that handing a bare string to a client expecting a union would otherwise need.
const LABS_TYPES = ["web", "news", "ecommerce"] as const;
const LABS_WINDOWS = [
  "past_4_hours",
  "past_day",
  "past_7_days",
  "past_30_days",
  "past_90_days",
  "past_12_months",
  "past_5_years",
] as const;
const GOOGLE_TYPES = ["web", "news", "youtube", "images", "froogle"] as const;
const GOOGLE_WINDOWS = [
  ...LABS_WINDOWS,
  "past_hour",
  "2004_present",
  "2008_present",
] as const;

/** The member of `allowed` that `value` names, or undefined. A lookup, never an assertion. */
function pick<T extends string>(
  allowed: readonly T[],
  value: string | undefined,
): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

/**
 * The app's entry point to both trend indexes, so the Trends Center is a screen rather than
 * something only an agent can read.
 *
 * It resolves location from the **project's own market**, and that is a decision worth stating:
 * these endpoints return **global** results when no location is given. A project's trends should be
 * about the market the project competes in, not the world, so the default is the project's
 * location rather than the vendor's global one.
 *
 * The two sources are not interchangeable — only Google takes `froogle`, only Google flags a
 * missing point rather than scoring it 0 — which is why the source chooses the client rather than
 * labelling the result. A value the chosen source does not know is **dropped rather than sent**,
 * because both vendors reject an unknown enum member and charge for the task anyway.
 */
export const getSearchTrends = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSearchTrendsSchema)
  .handler(async ({ data, context }) => {
    const client = createDataforseoClient(context);
    const source = data.source ?? "dataforseo";

    const items =
      source === "google"
        ? await client.keywords.googleTrendsExplore({
            keywords: data.keywords,
            type: pick(GOOGLE_TYPES, data.type),
            timeRange: pick(GOOGLE_WINDOWS, data.timeRange),
            dateFrom: data.dateFrom,
            dateTo: data.dateTo,
            locationCode: context.project.locationCode,
          })
        : await client.keywords.trendsExplore({
            keywords: data.keywords,
            type: pick(LABS_TYPES, data.type),
            timeRange: pick(LABS_WINDOWS, data.timeRange),
            dateFrom: data.dateFrom,
            dateTo: data.dateTo,
            locationCode: context.project.locationCode,
          });

    return {
      source,
      series: readTrendSeries(items[0] ?? {}),
      locationCode: context.project.locationCode,
    };
  });
