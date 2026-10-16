import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { readAdTrafficForecast } from "@/shared/ad-traffic-forecast-read";
import type { AdTrafficForecast } from "@/shared/ad-traffic-forecast-read";
import { USABLE_AD_TRAFFIC_FIELDS } from "@/shared/ad-traffic-fields";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  creditsFor,
  dryRunInputSchema,
  dryRunResponse,
  wantsToSpend,
} from "@/server/mcp/dry-run";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { DFS_KEYWORDS } from "@/shared/dataforseo-pricing";

/**
 * `ad_traffic_cross_check` — what a paid plan is expected to return, beside the
 * organic numbers.
 *
 * ## Why a cross-check and not a forecast
 *
 * Ad traffic and organic traffic are different systems answering different
 * questions, and the reference publishes no mechanism joining them. This
 * endpoint is honest about a **bid's** expected outcome; it cannot corroborate
 * an organic one. The tool is named for what it is, and its description says
 * what it is not, so an agent does not present a paid forecast as a second
 * opinion on organic visibility.
 *
 * ## The landmine this tool exists to route around
 *
 * The endpoint returns `impressions` and `ctr` **always null** — deprecated
 * upstream. A chart built from them is a published nothing: axes, a legend, a
 * trend line through no data, telling a reader their impressions were flat when
 * the truth is that the vendor stopped reporting them. The caller names the
 * fields it wants; the read returns only those that carry a measurement and
 * **names what it refused**, so an unexplained missing series is impossible.
 *
 * ## What the caller chooses
 *
 * `fields` defaults to the three that carry a measurement. Passing
 * `impressions` or `ctr` is not an error — it is answered with the refusal
 * sentence and the three usable series, which is the honest reply to a request
 * for something the vendor no longer sends.
 */

const crossCheckInputSchema = {
  projectId: projectIdSchema,
  keywords: z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .describe(
      "Keywords to price a paid plan for, up to 1000 per request. One request is billed once whatever it carries.",
    ),
  fields: z
    .array(z.enum(["clicks", "average_cpc", "cost", "impressions", "ctr"]))
    .optional()
    .describe(
      "Which figures to return. Defaults to clicks, average_cpc and cost — the three that carry a measurement. `impressions` and `ctr` are deprecated by the vendor and always null; asking for them is answered with a refusal naming them, and nothing is charted for them.",
    ),
  locationCode: z
    .number()
    .int()
    .positive()
    .describe("Country-level location code the bid targets."),
  languageCode: z.string().min(1).describe("Language code the bid targets."),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start of the window, yyyy-mm-dd."),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End of the window, yyyy-mm-dd."),
  ...dryRunInputSchema,
} as const;

type CrossCheckArgs = z.infer<z.ZodObject<typeof crossCheckInputSchema>>;

export const adTrafficCrossCheckTool = {
  name: "ad_traffic_cross_check",
  config: {
    title: "Cross-check a paid plan against the organic numbers",
    description:
      "Estimates what a Google Ads plan for these keywords is expected to return — clicks, average CPC and cost — as a sanity check beside an organic forecast, never as a forecast of its own. `impressions` and `ctr` are deprecated by the vendor and always null, so they are never charted: asking for them returns a refusal naming them rather than an empty axis that reads as flat interest. Charges credits once per request; dry_run defaults to true.",
    inputSchema: crossCheckInputSchema,
    outputSchema: z
      .object({
        rows: z.array(
          z.looseObject({
            keyword: z.string(),
            values: z.looseObject({}),
          }),
        ),
        refusal: z.string().nullable(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CrossCheckArgs, context) => {
    const fields = args.fields ?? [...USABLE_AD_TRAFFIC_FIELDS];

    if (!wantsToSpend(args.dry_run)) {
      return dryRunResponse({
        subject: `this ad-traffic cross-check for ${args.keywords.length} keyword(s)`,
        estimatedCredits: creditsFor(
          DFS_KEYWORDS.adTrafficForecast.live.perRequest,
        ),
        unitSentence: `USD ${DFS_KEYWORDS.adTrafficForecast.live.perRequest} per request — one task whatever it carries, and the deprecated fields are refused rather than charted`,
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structured: {},
      });
    }

    const client = createDataforseoClient(context.billing);
    // The metered facade returns the rows directly and records the spend
    // itself, so there is no envelope here and no per-request cost to restate —
    // the dry-run quote already priced it, and a second number would be one
    // more thing to keep in step with the ledger.
    const rows = await client.keywords.adTrafficForecast({
      keywords: args.keywords,
      locationCode: args.locationCode,
      languageCode: args.languageCode,
      dateFrom: args.dateFrom,
      dateTo: args.dateTo,
    });

    // **Typed by the reader's contract**, so a change to what a forecast may
    // show fails this compile rather than quietly reshaping the wire's payload.
    const forecast: AdTrafficForecast = readAdTrafficForecast(rows, fields);

    const lines = [
      `Ad-traffic cross-check for ${args.keywords.length} keyword(s):`,
      "",
      ...forecast.rows.slice(0, 25).map((row) => {
        const shown = Object.entries(row.values)
          .map(([field, value]) => `${field} ${value}`)
          .join(", ");
        return `  ${row.keyword}: ${shown === "" ? "nothing measurable returned" : shown}`;
      }),
      ...(forecast.rows.length > 25
        ? [`  ...and ${forecast.rows.length - 25} more`]
        : []),
    ];
    if (forecast.refusal !== null) {
      lines.push("", forecast.refusal);
    }
    lines.push(
      "",
      "This is a paid plan's expected return, not a forecast. It cannot corroborate an organic number — the two are different systems.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: {
        rows: forecast.rows,
        refusal: forecast.refusal,
      },
    });
  }),
};
