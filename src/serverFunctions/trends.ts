import { createServerFn } from "@tanstack/react-start";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { readTrendSeries } from "@/server/features/trends/trendSeries";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { getSearchTrendsSchema } from "@/types/schemas/trends";

/**
 * The app's entry point to DataForSEO Trends, so the Trends Center is a screen rather than
 * something only an agent can read.
 *
 * It resolves location from the **project's own market**, and that is a decision worth stating:
 * this endpoint returns **global** results when no location is given. A project's trends should be
 * about the market the project competes in, not the world, so the default is the project's
 * location rather than the vendor's global one.
 */
export const getSearchTrends = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getSearchTrendsSchema)
  .handler(async ({ data, context }) => {
    const client = createDataforseoClient(context);
    const items = await client.keywords.trendsExplore({
      keywords: data.keywords,
      type: data.type,
      timeRange: data.timeRange,
      dateFrom: data.dateFrom,
      dateTo: data.dateTo,
      locationCode: context.project.locationCode,
    });

    return {
      series: readTrendSeries(items[0] ?? {}),
      locationCode: context.project.locationCode,
    };
  });
