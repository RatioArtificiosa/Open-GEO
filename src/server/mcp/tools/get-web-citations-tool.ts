import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { metaOnlyOutputFields } from "@/server/mcp/tools/geo-shared";

/**
 * `get_web_citations` — who is talking about this topic, and in what terms.
 *
 * ## Why one tool covers four fetchers
 *
 * All four Content Analysis endpoints answer the same question at different
 * grains, and the useful shape is *one* answer:
 *
 * - `search` — the pages themselves (the outreach list)
 * - `summary` — the aggregate polarity across them
 * - `sentiment_analysis` — the same corpus cut by emotion as well as polarity
 * - `phrase_trends` — the above over a date range, if asked
 *
 * A caller asking "who mentions us" wants the list **and** the context that
 * makes it interpretable. Splitting these across four tools means four round
 * trips and four chances to read a number without its unit, so the two that
 * always belong together — the pages and the aggregate over them — travel in
 * one response, and `includeTrend` adds the time axis only when asked.
 *
 * ## The unit warning is the description, not a footnote
 *
 * `search`'s per-row sentiment is a **probability 0-1**; `summary`'s is a
 * **count over the vendor's whole index**. They are the same field name and
 * incompatible units, and an agent quoting `positive: 0.41` beside
 * `positive: 261992` as one scale is off by six orders of magnitude. So the
 * response names both explicitly (`polarityScores` per row, `positiveCitations`
 * in the aggregate) and the text repeats which is which.
 *
 * ## This is the reachability lesson, applied deliberately
 *
 * Four fetchers have now sat on the metered client with no caller — the same
 * shape this project hit with `get_geo_top_citations`, `ai_keyword_volume`,
 * `forecast_traffic` and `compareSentiment`. **A fetcher with no reader is a
 * capability that does not exist**, and the first three were only found by
 * asking "who can reach this?" So the reader ships in the same milestone as
 * the last fetcher rather than as a follow-up.
 */

/** ~$0.02 for the page list, ~$0.02 for the aggregate, ~$0.02 per trend read. */
const CREDITS_PAGES = 2;
const CREDITS_AGGREGATE = 2;
const CREDITS_TREND = 2;

const inputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "The topic or brand to look for citations of. Matches the vendor's own index, so a topic with no coverage returns nothing — that is an absence of mentions, not a claim that none exist.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "How many citing pages to return. Defaults to 25 and is capped at 300 — the vendor allows 1,000, but each row carries a snippet and two score maps, and a 1,000-row response is not something an agent can read.",
    ),
  sortBy: z
    .enum(["prominence", "anger"])
    .optional()
    .describe(
      "prominence (default) — the most-cited-prominent pages first, which is the outreach list. anger — the most negative first, for triaging complaints. The vendor's own default is anger-first, which is the wrong default for watching a brand's representation.",
    ),
  includeEmotions: z
    .boolean()
    .optional()
    .describe(
      "Also split by emotion (anger, happiness, love, sadness, share, fun). Adds no cost — it is the same corpus read a second way.",
    ),
  includeTrend: z
    .boolean()
    .optional()
    .describe(
      "Also return the monthly series for the last year, with a worded direction. Adds roughly one more request.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: preview the credit cost without spending. Set dry_run: false to fetch.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getWebCitationsTool = {
  name: "get_web_citations",
  config: {
    title: "Get web citations for a topic",
    description:
      "Returns the pages in DataForSEO's index that cite a topic, with each page's own sentiment probabilities, plus the aggregate polarity across the whole corpus. USE THIS to find who already talks about a topic — the outreach list. UNIT WARNING: per-page sentiment is a probability between 0 and 1, while the aggregate positive count is a number of pages and neither is comparable with Google search volume. Emotions are optional; a monthly trend is optional. All figures come from the open web's citation index — this is NOT what AI engines say, and for that use compare_ai_web_sentiment instead. dry_run defaults to true.",
    inputSchema,
    outputSchema: z
      .object({
        ...metaOnlyOutputFields,
        keyword: z.string(),
        /** Pages in the vendor's index citing the topic. Not a chosen sample. */
        totalCount: z.number().nullable(),
        pages: z.array(
          z
            .object({
              url: z.string().nullable(),
              domain: z.string().nullable(),
              title: z.string().nullable(),
              snippet: z.string().nullable(),
              prominence: z.number().nullable(),
              /** Per-page probabilities, 0-1. Never counts. */
              polarityScores: z.record(z.string(), z.number().nullable()),
              connotationScores: z
                .record(z.string(), z.number().nullable())
                .optional(),
              country: z.string().nullable(),
              language: z.string().nullable(),
              publishedAt: z.string().nullable(),
            })
            .passthrough(),
        ),
        aggregate: z
          .object({
            /** Citation counts per polarity over the whole index. Never summed with the per-page scores. */
            positiveCitations: z.number().nullable(),
            negativeCitations: z.number().nullable(),
            neutralCitations: z.number().nullable(),
            /** Named for what it counts over, because the same field name means counts elsewhere and scores here. */
            countBasis: z.string(),
          })
          .passthrough(),
        trend: z
          .object({
            direction: z.enum(["rising", "falling", "flat"]).nullable(),
            points: z.array(
              z
                .object({
                  date: z.string().nullable(),
                  positiveShare: z.number().nullable(),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .optional(),
        /** Dominant polarity as a label, never a percentage — the buckets overlap. */
        dominantPolarity: z
          .enum(["positive", "negative", "neutral"])
          .nullable(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const limit = args.limit ?? 25;
    const includeEmotions = args.includeEmotions === true;
    const includeTrend = args.includeTrend === true;
    const sortBy = args.sortBy ?? "prominence";

    if (args.dry_run !== false) {
      // The aggregate travels with the list by design, so both are quoted.
      const estimate =
        CREDITS_PAGES + CREDITS_AGGREGATE + (includeTrend ? CREDITS_TREND : 0);
      return mcpResponse({
        text: [
          `Dry run: the citing pages for "${args.keyword}" cost approximately ${estimate} credits — ${CREDITS_PAGES} for up to ${limit} pages, ${CREDITS_AGGREGATE} for the aggregate over the whole corpus${
            includeTrend ? `, and ${CREDITS_TREND} for the monthly trend` : ""
          }. Charged amount is what DataForSEO reports at send time.`,
          `Re-run with dry_run: false to fetch. Per-page sentiment is a probability 0-1; the aggregate is a page count — they are not comparable.`,
        ].join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: {
          dryRun: true,
          keyword: args.keyword,
          limit,
          estimatedCredits: estimate,
        },
      });
    }

    const client = createDataforseoClient(context.billing);

    // **The list and its aggregate travel together**, because the aggregate is
    // only interpretable next to the rows it summarises. Fetched together so a
    // failure on one cannot leave the other half reading as complete.
    const [pages, aggregate, emotions, trend] = await Promise.all([
      client.serp
        .contentSearch({
          keyword: args.keyword,
          limit,
          // **The vendor's own default is anger-first** — right for triaging
          // complaints, wrong for watching a brand's representation. Prominence
          // is the default here, and `anger` is opt-in for triage: an option
          // the description offers has to actually reach the request, or it is
          // a promise rather than a feature.
          orderBy:
            sortBy === "anger"
              ? ["content_info.sentiment_connotations.anger,desc"]
              : ["score,desc"],
        })
        .catch((error: unknown) => ({ failure: describeError(error) })),
      client.serp
        .contentSummary({ keyword: args.keyword, internalListLimit: 5 })
        .catch((error: unknown) => ({ failure: describeError(error) })),
      includeEmotions
        ? client.serp
            .contentSentiment({ keyword: args.keyword })
            .catch((error: unknown) => ({ failure: describeError(error) }))
        : Promise.resolve(null),
      includeTrend
        ? client.serp
            .contentPhraseTrends({
              keyword: args.keyword,
              dateFrom: yearAgo(),
              dateGroup: "month",
            })
            .catch((error: unknown) => ({ failure: describeError(error) }))
        : Promise.resolve(null),
    ]);

    if ("failure" in pages) {
      return mcpResponse({
        text: `Could not read the citing pages for "${args.keyword}": ${pages.failure}`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/geo`,
        ),
        structuredContent: { keyword: args.keyword, failure: pages.failure },
      });
    }

    const lines: string[] = [
      `${pages.totalCount ?? pages.rows.length} pages in DataForSEO's index cite "${args.keyword}". Showing ${pages.rows.length}, ${
        // **The header states the sort that ran**, not the sort that usually
        // runs: a reader who asked for anger-first and sees "most prominent
        // first" has been told something false about their own request.
        sortBy === "anger" ? "most angry first." : "most prominent first."
      }`,
      "",
    ];

    if (pages.rows.length === 0) {
      lines.push(
        "No citing pages came back. That is an absence of mentions in this index, not evidence that none exist — a topic nobody has written about looks the same.",
      );
    } else {
      for (const row of pages.rows) {
        const parts = [`- ${row.domain ?? row.url ?? "unknown"}`];
        if (row.title) parts.push(`— ${row.title}`);
        const scores = row.polarityScores;
        if (scores.positive !== null || scores.negative !== null) {
          parts.push(
            ` (polarity p+${fmt(scores.positive)} p−${fmt(scores.negative)})`,
          );
        }
        lines.push(parts.join(""));
      }
    }

    if ("failure" in aggregate) {
      lines.push(
        "",
        `The aggregate over the whole corpus could not be read: ${aggregate.failure}`,
      );
    } else {
      lines.push(
        "",
        `Across the whole index for this topic: ${aggregate.polarity.positive} positive, ${aggregate.polarity.negative} negative, ${aggregate.polarity.neutral} neutral citations. That is a page count; the per-page figures above are probabilities, and the two are not comparable.`,
      );
    }

    if (emotions && !("failure" in emotions)) {
      // **Only the emotion buckets, not the polarity ones** — the aggregate above
      // already reports polarity, and printing it twice would invite the reader
      // to treat the two lists as comparable when they are different cuts of the
      // same corpus.
      lines.push("", "By emotion (the same pages, cut differently):");
      for (const emotion of [
        "anger",
        "happiness",
        "love",
        "sadness",
        "share",
        "fun",
      ] as const) {
        const count = emotions.byConnotation[emotion]?.totalCount ?? null;
        if (count !== null) lines.push(`- ${emotion}: ${count} citations`);
      }
    }

    if (trend && !("failure" in trend)) {
      lines.push(
        "",
        `Over the last year: ${trend.direction ?? "no clear direction"}. ${
          trend.direction === null
            ? "With one usable month there is no direction to report."
            : "Direction is a word rather than a percentage — the monthly totals move, so a ratio of two shares would not be a measurement."
        }`,
      );
    }

    lines.push(
      "",
      "This is the open web's citation index, not what AI engines say. For the AI side use compare_ai_web_sentiment.",
    );

    return mcpResponse({
      text: lines.join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/geo`,
      ),
      structuredContent: {
        keyword: args.keyword,
        totalCount: pages.totalCount,
        pages: pages.rows.map((row) => ({
          url: row.url,
          domain: row.domain,
          title: row.title,
          snippet: row.snippet,
          prominence: row.prominence,
          polarityScores: row.polarityScores,
          ...(includeEmotions
            ? { connotationScores: row.connotationScores }
            : {}),
          country: row.country,
          language: row.language,
          publishedAt: row.groupDate,
        })),
        aggregate:
          "failure" in aggregate
            ? { failure: aggregate.failure }
            : {
                positiveCitations: aggregate.polarity.positive,
                negativeCitations: aggregate.polarity.negative,
                neutralCitations: aggregate.polarity.neutral,
                countBasis: aggregate.countBasis,
              },
        ...(trend && !("failure" in trend)
          ? {
              trend: {
                direction: trend.direction,
                points: trend.points.map((point) => ({
                  date: point.date,
                  positiveShare: point.positiveShare,
                })),
              },
            }
          : {}),
        dominantPolarity:
          emotions && !("failure" in emotions)
            ? emotions.dominantPolarity
            : null,
      },
    });
  }),
};

function fmt(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Twelve months back, because `phrase_trends` history starts 2022-10-31. */
function yearAgo(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}
