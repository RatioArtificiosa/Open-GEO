import { z } from "zod";
import { sortBy } from "remeda";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import type {
  WaterfallPage,
  WaterfallResource,
} from "@/server/lib/dataforseo/on-page-waterfall";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { DFS_ONPAGE } from "@/shared/dataforseo-pricing";

/**
 * Page speed, as a **pair** of tools, because that is the shape the vendor's API has.
 *
 * A waterfall only exists for a crawl that already ran, and the crawl is queued — so the first
 * call starts it and returns an id, and the second reads a page of it. Collapsing the two into
 * one tool would mean blocking an agent for minutes, or polling inside a handler, and neither is
 * something a caller can be asked to wait for.
 *
 * **The economics are lopsided in the caller's favour** `[V 2026-10-06]`: the read is free for
 * 30 days, and the crawl costs by the page — `load_resources` is 3× the base page price, roughly
 * **$0.00045 a page**. So the tools state the cost up front, and the second one is free to call
 * as often as the caller likes.
 *
 * ## What this cannot tell you, and one reason it might look empty
 *
 * It reports what a page *loaded*, not whether it is a good page. And the crawl is run by the
 * vendor's crawler, which introduces itself as `RSiteAuditor` from published DataForSEO IPs — so
 * a site behind a strict WAF can turn it away while our own crawler gets in. An empty result is
 * that before it is a site with nothing to report.
 */

/** The crawl only needs resources for timings; browser rendering is 34× for metrics this returns none of. */
const RESOURCE_LOAD_MULTIPLIER = DFS_ONPAGE.loadResources;
const BASE_PAGE_USD = DFS_ONPAGE.basePage;

const startInputSchema = {
  projectId: projectIdSchema,
  url: z
    .string()
    .url()
    .describe(
      "Page to measure, with its scheme (https://example.com/pricing).",
    ),
  maxCrawlPages: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Pages to allow the crawl. The vendor refunds whatever it does not crawl, so a generous number costs nothing while a small one truncates; one page is enough for a single URL.",
    ),
} as const;

type StartArgs = z.infer<z.ZodObject<typeof startInputSchema>>;

export const startPageSpeedAuditTool = {
  name: "start_page_speed_audit",
  config: {
    title: "Start a page speed audit",
    description:
      "Starts a crawl whose pages can then be measured for page-speed timings, and returns the task id that `get_page_waterfall` needs. Use this when a page is slow and you want to know which request caused it. The crawl is queued, so results are not ready immediately; the read is free, so call `get_page_waterfall` again later with the returned id. Charges credits for the crawl, priced per page.",
    inputSchema: startInputSchema,
    outputSchema: z
      .object({
        taskId: z.string(),
        url: z.string(),
        estimatedCrawlCostUsd: z.number(),
        readIsFree: z.literal(true),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: StartArgs, context) => {
    const maxCrawlPages = args.maxCrawlPages ?? 1;
    const client = createDataforseoClient(context.billing);
    const task = await client.onPage.waterfallTask({
      url: args.url,
      maxCrawlPages,
    });

    const estimatedCrawlCostUsd =
      Math.round(
        BASE_PAGE_USD * RESOURCE_LOAD_MULTIPLIER * maxCrawlPages * 1e6,
      ) / 1e6;

    return mcpResponse({
      text: `Started a crawl for ${task.url} (task ${task.taskId}), allowing ${maxCrawlPages} page${maxCrawlPages === 1 ? "" : "s"} — about $${estimatedCrawlCostUsd.toFixed(5)} at the resource-loading rate, and the vendor refunds pages it does not crawl. The crawl is queued, so the waterfall is usually not ready for a few minutes: call get_page_waterfall with this task id and the URL. That read costs nothing and stays available for 30 days. Note the crawl runs as the vendor's crawler (RSiteAuditor), so a site that blocks it will come back empty even though this product can reach it.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/audit`,
      ),
      structuredContent: {
        taskId: task.taskId,
        url: task.url,
        estimatedCrawlCostUsd,
        readIsFree: true as const,
      },
    });
  }),
};

const waterfallInputSchema = {
  projectId: projectIdSchema,
  taskId: z
    .string()
    .min(1)
    .describe("Task id returned by start_page_speed_audit."),
  url: z.string().url().describe("The page to report timings for."),
} as const;

type WaterfallArgs = z.infer<z.ZodObject<typeof waterfallInputSchema>>;

export const getPageWaterfallTool = {
  name: "get_page_waterfall",
  config: {
    title: "Get a page waterfall",
    description:
      "Returns what a page loaded and how long each piece took: connection, secure connection, time to first byte, download, time to interactive, and every resource with its own duration and whether it blocked rendering. Use it to answer 'which request made this page slow'. Free to call — the vendor charges for the crawl, not this read — and safe to call repeatedly until the crawl reports finished.",
    inputSchema: waterfallInputSchema,
    outputSchema: z
      .object({
        taskId: z.string(),
        crawlProgress: z.string().nullable(),
        /** Slowest first, because that is the order the reader wants them in. */
        slowestResources: z.array(
          z.looseObject({
            url: z.string().nullable(),
            resourceType: z.string().nullable(),
            durationMs: z.number().nullable(),
            isRenderBlocking: z.boolean().nullable(),
          }),
        ),
        page: z.looseObject({
          timeToInteractiveMs: z.number().nullable(),
          waitingTimeMs: z.number().nullable(),
          downloadTimeMs: z.number().nullable(),
          durationTimeMs: z.number().nullable(),
          resourceCount: z.number(),
          renderBlockingCount: z.number(),
        }),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: WaterfallArgs, context) => {
    const client = createDataforseoClient(context.billing);
    // The read is bound to the client **unmetered** (the vendor charges nothing for it), so what
    // comes back is the raw envelope rather than the unwrapped payload a metered call returns.
    const read = await client.onPage.waterfall({
      taskId: args.taskId,
      url: args.url,
    });

    const page: WaterfallPage | undefined = read.data.pages[0];
    if (!page) {
      return mcpResponse({
        text: `The crawl (task ${args.taskId}) has no timing for ${args.url} yet — crawl status is "${read.data.crawlProgress ?? "unknown"}". If it stays empty, the most likely reason is that the vendor's crawler was turned away rather than that the page has nothing to measure. Call again once the crawl reports finished.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
        structuredContent: {
          taskId: args.taskId,
          crawlProgress: read.data.crawlProgress,
          slowestResources: [],
          page: {
            timeToInteractiveMs: null,
            waitingTimeMs: null,
            downloadTimeMs: null,
            durationTimeMs: null,
            resourceCount: 0,
            renderBlockingCount: 0,
          },
        },
      });
    }

    const slowest = sortBy(
      page.resources,
      (resource) => -(resource.durationMs ?? 0),
    ).slice(0, 10);
    const renderBlockingCount = page.resources.filter(
      (resource: WaterfallResource) => resource.isRenderBlocking === true,
    ).length;

    const worst = slowest[0];
    const headline = worst?.url
      ? `Slowest request: ${worst.url} at ${worst.durationMs ?? 0} ms${worst.isRenderBlocking ? ", and it blocks rendering" : ""}.`
      : "No resource timings came back for this page.";

    return mcpResponse({
      text: `${headline} The page took ${page.durationTimeMs ?? 0} ms overall, with ${page.waitingTimeMs ?? 0} ms before the first byte and ${page.timeToInteractiveMs ?? 0} ms to interactive. ${page.resources.length} resource${page.resources.length === 1 ? "" : "s"}, ${renderBlockingCount} of them render-blocking. Crawl status: ${read.data.crawlProgress ?? "unknown"}${read.data.crawlProgress === "in_progress" ? " — more pages may still arrive, though this one is complete" : ""}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/audit`,
      ),
      structuredContent: {
        taskId: args.taskId,
        crawlProgress: read.data.crawlProgress,
        slowestResources: slowest,
        page: {
          timeToInteractiveMs: page.timeToInteractiveMs,
          waitingTimeMs: page.waitingTimeMs,
          downloadTimeMs: page.downloadTimeMs,
          durationTimeMs: page.durationTimeMs,
          resourceCount: page.resources.length,
          renderBlockingCount,
        },
      },
    });
  }),
};
