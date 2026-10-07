/**
 * The page-speed waterfall: everything a page loaded, and how long each piece took.
 *
 * ## The read is free; the crawl is what costs — and that inverts the maths
 *
 * `[V 2026-10-06]` The reference states it plainly: *"Your account will not be charged for using
 * this function. You can get the results of the task within the next 30 days for free."* So the
 * purchase is a **crawl**, once, and every waterfall for its pages is free for a month. That is
 * the opposite of `content_parsing`, which bills on every read, and the asymmetry is worth
 * knowing before deciding which of the two to reach for.
 *
 * ## What the crawl has to ask for
 *
 * Resource timings need `load_resources` — **3× the base page price, about $0.00045 a page**,
 * which is a thousand pages for under fifty cents. `enable_browser_rendering` is **34×** and is
 * for Core Web Vitals; asking for it here would multiply the bill by eleven to add numbers this
 * endpoint does not return. The task also takes `max_crawl_pages`, and the vendor **refunds the
 * difference** when a site has fewer pages than that.
 *
 * ## Why the task is posted here rather than reused
 *
 * `postOnPageTaskForContentParsing` posts to the same endpoint, and the two send **deliberately
 * different flag sets**: that one pays for a parse, this one pays for resources, and either
 * would be wasting the other's money. Both sit on the same primitives — the billed-POST retry
 * policy and the `20100 Task Created` status — so the idiom is shared even though the flags are
 * not.
 *
 * ## What a caller must not forget
 *
 * The crawl is **asynchronous**: the post returns an id, and the waterfall read answers
 * `crawl_progress: in_progress` until the pages are done. A caller that treats the first read as
 * final will show an empty waterfall for a crawl that is still running.
 *
 * One more thing worth knowing before pointing this at a customer's site: the vendor's crawler
 * introduces itself as `Mozilla/5.0 (compatible; RSiteAuditor)`, not as this product, and it
 * comes from a published list of DataForSEO IPs. A site with a strict WAF will treat it as a
 * stranger, and the audit's own crawl — which is us, from our own edge — will not have that
 * problem. The two crawls can therefore disagree about whether a page is reachable at all.
 */
import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/** `[V]` reference page, read 2026-10-06. No `/live/` segment: this is a task read. */
const WATERFALL_PATH = "/v3/on_page/waterfall";
const TASK_POST_PATH = "/v3/on_page/task_post";

const resourceSchema = z
  .object({
    resource_type: z.string().nullish(),
    url: z.string().nullish(),
    initiator: z.string().nullish(),
    duration_time: z.number().nullish(),
    fetch_start: z.number().nullish(),
    fetch_end: z.number().nullish(),
    /**
     * A boolean, and the useful one: a render-blocking resource delays first paint for the whole
     * page, so it is the difference between "a big file" and "the reason the page looked slow".
     */
    is_render_blocking: z.boolean().nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    page_url: z.string().nullish(),
    time_to_interactive: z.number().nullish(),
    dom_complete: z.number().nullish(),
    connection_time: z.number().nullish(),
    time_to_secure_connection: z.number().nullish(),
    request_sent_time: z.number().nullish(),
    waiting_time: z.number().nullish(),
    download_time: z.number().nullish(),
    duration_time: z.number().nullish(),
    fetch_start: z.number().nullish(),
    fetch_end: z.number().nullish(),
    resources: z.array(resourceSchema).nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    crawl_progress: z.string().nullish(),
    items: z.array(itemSchema).nullish(),
  })
  .passthrough();

type WaterfallResource = {
  resourceType: string | null;
  url: string | null;
  initiator: string | null;
  /** Milliseconds. Null when the vendor omitted it. */
  durationMs: number | null;
  fetchStartMs: number | null;
  fetchEndMs: number | null;
  isRenderBlocking: boolean | null;
};

type WaterfallPage = {
  pageUrl: string | null;
  timeToInteractiveMs: number | null;
  domCompleteMs: number | null;
  connectionTimeMs: number | null;
  timeToSecureConnectionMs: number | null;
  requestSentTimeMs: number | null;
  /** Time to first byte. */
  waitingTimeMs: number | null;
  downloadTimeMs: number | null;
  durationTimeMs: number | null;
  fetchStartMs: number | null;
  fetchEndMs: number | null;
  resources: WaterfallResource[];
};

type WaterfallResult = {
  /** `in_progress` until the crawl finishes. A caller must not treat the first read as final. */
  crawlProgress: string | null;
  pages: WaterfallPage[];
};

/**
 * Post the crawl whose pages the waterfall can then be read for.
 *
 * `maxCrawlPages` is required by the vendor and is also the refund boundary: pages a site does
 * not have are credited back, so a generous number costs nothing while a stingy one truncates.
 */
export async function postOnPageCrawlTaskForWaterfall(input: {
  url: string;
  maxCrawlPages: number;
}): Promise<DataforseoApiResponse<{ taskId: string; url: string }>> {
  const url = input.url.trim();
  if (url.length === 0) {
    throw new AppError("VALIDATION_ERROR", "url is required");
  }
  if (!Number.isInteger(input.maxCrawlPages) || input.maxCrawlPages < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "maxCrawlPages must be a positive integer; the vendor charges for the pages it crawls and refunds the rest",
    );
  }

  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    TASK_POST_PATH,
    [
      {
        url,
        max_crawl_pages: input.maxCrawlPages,
        // **The one flag that makes the waterfall useful.** Without resource loading there is
        // no per-resource timing to read, and the task id would be perfectly valid.
        // `enable_browser_rendering` is deliberately absent: 34× the price for Core Web Vitals,
        // which this endpoint does not return.
        load_resources: true,
      },
    ],
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, { okTaskStatusCode: 20100 });
  const id = task.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO task_post returned no task id, so there is no crawl to read",
    );
  }

  return { data: { taskId: id, url }, billing: buildTaskBilling(task) };
}

/**
 * Read the waterfall for one page of a crawl.
 *
 * **Free at the vendor** (see the file header), which is why it is *not* metered: charging a
 * customer for a call the vendor did not bill is overcharging, not caution. The task id is good
 * for 30 days, so a past waterfall can be re-read at no cost.
 */
export async function fetchOnPageWaterfall(input: {
  taskId: string;
  url: string;
}): Promise<DataforseoApiResponse<WaterfallResult>> {
  const taskId = input.taskId.trim();
  const url = input.url.trim();
  if (taskId.length === 0 || url.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Both the task id and the page URL are required. Post an on_page crawl with load_resources first.",
    );
  }

  const response = await dataforseoPost(WATERFALL_PATH, [{ id: taskId, url }]);
  const task = assertOk(response);

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned an unexpected waterfall payload",
    );
  }

  return {
    data: {
      crawlProgress: raw.data.crawl_progress ?? null,
      pages: (raw.data.items ?? []).map((item) => ({
        pageUrl: item.page_url ?? null,
        timeToInteractiveMs: item.time_to_interactive ?? null,
        domCompleteMs: item.dom_complete ?? null,
        connectionTimeMs: item.connection_time ?? null,
        timeToSecureConnectionMs: item.time_to_secure_connection ?? null,
        requestSentTimeMs: item.request_sent_time ?? null,
        waitingTimeMs: item.waiting_time ?? null,
        downloadTimeMs: item.download_time ?? null,
        durationTimeMs: item.duration_time ?? null,
        fetchStartMs: item.fetch_start ?? null,
        fetchEndMs: item.fetch_end ?? null,
        resources: (item.resources ?? []).map((resource) => ({
          resourceType: resource.resource_type ?? null,
          url: resource.url ?? null,
          initiator: resource.initiator ?? null,
          durationMs: resource.duration_time ?? null,
          fetchStartMs: resource.fetch_start ?? null,
          fetchEndMs: resource.fetch_end ?? null,
          isRenderBlocking: resource.is_render_blocking ?? null,
        })),
      })),
    },
    billing: buildTaskBilling(task),
  };
}
