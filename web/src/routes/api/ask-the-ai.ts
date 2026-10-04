import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  cacheableJson,
  chargeToolBudget,
  dataforseoKey,
  failureResponse,
  fetchDataforseoResult,
  guardToolRequest,
  jsonResponse,
  readToolBody,
  readCached,
  serviceUnavailable,
  writeCached,
} from "@/lib/free-tools/server";
import { freeTools } from "@/lib/free-tools/tool-pages";

const TOOL = freeTools["ask-the-ai"];
/** An answer is prose, so it is worth caching longer than a row-shaped tool. */
const CACHE_TTL_SECONDS = 86_400;

/**
 * **Two billable calls, and they must run in sequence.**
 *
 * `serp/ai_summary` cannot be called on its own — it needs a `task_id` from a
 * prior SERP POST. So this route is a two-step flow, and the steps are
 * sequential by necessity rather than by choice: a `Promise.all` would post a
 * summary for a task that does not exist yet.
 *
 * Both calls are reserved as one `calls: 2` budget charge *before* the first
 * one, so a visitor cannot get the free SERP post free by having the summary
 * rejected.
 */
const CALLS_PER_RUN = 2;

const requestSchema = z.object({
  keyword: z
    .string()
    .trim()
    .min(1, "Enter a search term")
    .max(300, "That search term is too long"),
  prompt: z
    .string()
    .trim()
    .min(3, "Ask a question")
    // DataForSEO's own cap. Exceeding it is a *billed* rejection, so the check
    // has to happen here rather than at the provider.
    .max(2000, "That question is too long — keep it under 2000 characters"),
  turnstileToken: z.string().max(4096).optional(),
});

const taskPostSchema = z
  .object({
    id: z.string().optional(),
    status_code: z.number().optional(),
    status_message: z.string().optional(),
  })
  .passthrough();

const summarySchema = z
  .object({
    items: z
      .array(
        z.object({ summary: z.string().nullable().optional() }).passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

export type AskTheAi = {
  keyword: string;
  prompt: string;
  summary: string;
  links: Array<{ title: string; url: string }>;
  /**
   * True when the model cited nothing. An absence the visitor is told about,
   * rather than a bare prose block they will read as a sourced answer.
   */
  uncited: boolean;
};

/**
 * Pull the markdown links out of the summary.
 *
 * The vendor appends `[title](url)` when `include_links` is set. The prose
 * keeps them — where the model chose to place a citation is part of the answer
 * — and this gives the page a list it can render.
 */
function extractLinks(summary: string): AskTheAi["links"] {
  const links: AskTheAi["links"] = [];
  for (const match of summary.matchAll(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    const title = match[1]?.trim() ?? "";
    const url = match[2];
    if (!url || links.some((link) => link.url === url)) continue;
    links.push({ title: title === "" ? url : title, url });
  }
  return links;
}

/**
 * POST a SERP task and return its id.
 *
 * **Not `fetchDataforseoResult`.** That helper requires `20000`, which is right
 * for the fetch endpoints and wrong here: a POST answers `20100 "Task Created"`
 * on success. Using it would report every successful post as a charged
 * failure. The same distinction `postRankCheckTasks` makes in the main app.
 */
async function postSerpTask(input: {
  keyword: string;
  apiKey: string;
}): Promise<string> {
  const response = await fetch(
    "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${input.apiKey}`,
      },
      body: JSON.stringify([
        {
          keyword: input.keyword,
          location_code: 2840,
          language_code: "en",
          device: "desktop",
          os: "windows",
          // Depth 10, one page. The task exists only to obtain an id to ask, so
          // deeper pages are billed at post time and may never be read.
          depth: 10,
        },
      ]),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`DataForSEO HTTP ${response.status} on serp task_post`);
  }
  const envelope = z
    .object({ tasks: z.array(z.record(z.string(), z.unknown())).optional() })
    .parse(await response.json());
  const task = taskPostSchema.parse(envelope.tasks?.[0] ?? {});
  // The envelope being present says nothing about the task: a refused entry
  // arrives inside a successful response, and both calls are billed.
  if (task.status_code !== 20100 || !task.id) {
    throw new Error(
      `DataForSEO task_post (${task.status_code ?? "no status"}): ${task.status_message ?? "no task created"}`,
    );
  }
  return task.id;
}

export const Route = createFileRoute("/api/ask-the-ai")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readToolBody(request);
        if (body instanceof Response) return body;
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { error: parsed.error.issues[0]?.message ?? "Invalid request" },
            400,
          );
        }

        const keyword = parsed.data.keyword;
        const prompt = parsed.data.prompt;
        // The cache key is the *question*, not the keyword: the same keyword
        // asked two ways is two different answers, and keying on the keyword
        // alone would serve one question's prose for another's.
        const cacheKey = `${keyword}::${prompt}`.toLowerCase();

        const apiKey = dataforseoKey();
        if (!apiKey) return serviceUnavailable(TOOL.slug);

        const blocked = await guardToolRequest({
          tool: TOOL.slug,
          request,
          turnstileToken: parsed.data.turnstileToken,
        });
        if (blocked) return blocked;

        const cached = await readCached<AskTheAi>(TOOL.slug, cacheKey);
        if (cached) {
          return cached.ok
            ? cacheableJson(cached.data, CACHE_TTL_SECONDS)
            : failureResponse(cached.error);
        }

        // Both steps reserved before the first one, so the free SERP post
        // cannot be had by having the summary rejected.
        const overBudget = await chargeToolBudget({
          tool: TOOL.slug,
          request,
          calls: CALLS_PER_RUN,
        });
        if (overBudget) return overBudget;

        try {
          const taskId = await postSerpTask({ keyword, apiKey });
          const raw = await fetchDataforseoResult(
            "/v3/serp/ai_summary",
            {
              task_id: taskId,
              prompt,
              support_extra: true,
              // Off: this crawls the pages behind the results, and its cost is
              // not in the 10 cents the summary costs. An anonymous visitor
              // does not get it.
              fetch_content: false,
              include_links: true,
            },
            apiKey,
          );
          const parsedSummary = summarySchema.parse(raw ?? {});
          const summary = parsedSummary.items?.[0]?.summary ?? "";
          const links = extractLinks(summary);

          const result: AskTheAi = {
            keyword,
            prompt,
            summary,
            links,
            uncited: links.length === 0,
          };

          await writeCached(
            TOOL.slug,
            cacheKey,
            { ok: true, data: result },
            CACHE_TTL_SECONDS,
          );
          return cacheableJson(result, CACHE_TTL_SECONDS);
        } catch (err) {
          console.error("Ask the AI error:", err);
          const message =
            "Could not read the AI answer for that question. Please try again.";

          // **Only a deterministic failure is cached.** A refused task — an
          // off-topic prompt, a rejected field — will be refused identically for
          // the same input, so caching it saves two billable calls per retry.
          // A timeout or a 5xx will not: caching those turns a thirty-second
          // network blip into a two-minute "this question failed" that the
          // visitor sees as the answer, which is the failure this whole tool is
          // built to avoid. Transient failures stay uncached so a retry can
          // actually work.
          //
          // The split is on the message, because the provider's status text is
          // the only thing that distinguishes them — and it is the same text
          // `fetchDataforseoResult` and `postSerpTask` already branch on.
          const detail = err instanceof Error ? err.message : String(err);
          const deterministic =
            /status_code \(40\d\d\d\)|Invalid Field|Task .*rejected|no task created/i.test(
              detail,
            );
          if (deterministic) {
            await writeCached(
              TOOL.slug,
              cacheKey,
              { ok: false, error: message },
              120,
            );
          }
          return failureResponse(message);
        }
      },
    },
  },
});
