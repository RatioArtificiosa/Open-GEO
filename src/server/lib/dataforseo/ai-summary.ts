import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/**
 * `serp/ai_summary` — "ask the SERP anything".
 *
 * ## The two-step flow, and why it is not one call
 *
 * This endpoint **cannot be called on its own**. It requires a `task_id` from a
 * prior SERP POST, and DataForSEO keeps that id valid for **30 days**. So the
 * unit of work is a pair: post a SERP for a keyword, then ask that SERP a
 * question. A tool that only forwarded a `task_id` would make the caller
 * orchestrate a paid two-step flow with a 30-day expiry, which is exactly the
 * kind of thing an agent gets wrong.
 *
 * ## The four things that will bite, and are therefore refusals here
 *
 * 1. **`prompt` is capped at 2000 characters and must be relevant to the
 *    SERP's keyword.** Both are billed rejections, so the length is checked
 *    before the request rather than discovered as a 40501 after the charge.
 * 2. **`fetch_content` makes DataForSEO crawl the pages behind the results.**
 *    It defaults to `false` and stays `false` unless asked for: it is the one
 *    flag here that turns into page fetches, and its cost is not in the
 *    `$0.01` figure.
 * 3. **`support_extra` defaults to `true`**, so the summary may reason over
 *    the answer box, knowledge graph and featured snippet. That is the
 *    interesting behaviour, so it is left on — but it is stated, because it
 *    means the summary is not reasoning over organic results alone.
 * 4. **The summary is a string with inline links, not a citation list.**
 *    `[title](url)` markdown is appended to the prose when `include_links` is
 *    true. Those are extracted into a structured `links` array so a caller can
 *    cite them, and the prose is returned untouched — the model chose where
 *    to place them.
 *
 * ## What the summary is not
 *
 * It is **one model's reading of one SERP**, not a fact about the web and not
 * a ranking. DataForSEO does not say which model produced it, so neither can
 * we — and a summary that agrees with a client's expectation is not evidence
 * that the model read the page.
 *
 * Verified against the live documentation on 2026-10-03.
 */

const PATH = "/v3/serp/ai_summary";

/** Documented cap. Exceeding it is a billed rejection, so we check first. */
export const AI_SUMMARY_PROMPT_MAX = 2000;

const classifySerpError = createDataforseoBillingClassifier({
  pathPrefix: "/serp/",
  // The existing code for this family, reused rather than a new one invented:
  // `ai_summary` is a balance-failure like any other vendor call, and a fresh
  // code would need a message and a client mapping to say the same thing.
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const resultSchema = z
  .object({
    items_count: z.number().nullish(),
    items: z
      .array(
        z
          .object({
            summary: z.string().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/** Module-private: the metered client's inferred types carry these, and knip
 *  enforces that an export nobody names is a lie about the API surface. */
type AiSummaryResult = {
  /** The model's prose, exactly as written. Empty string when none came back. */
  summary: string;
  /**
   * The links the summary cited, in the order they appear in the prose.
   * Empty when `include_links` was false or the model cited nothing — which
   * is a real state, not a missing field.
   */
  links: Array<{ title: string; url: string }>;
  itemsCount: number | null;
};

/**
 * A SERP task that can be asked a question later.
 *
 * `taskId` is the only reason this function exists. `fetchLiveSerp` reads the
 * same endpoint and discards the id, which is the right default — a caller
 * that wants the rows should not be handed a 30-day expiry it did not ask
 * for. `ai_summary` is the one feature that cannot work without it, so it
 * gets its own POST rather than changing a function other tools depend on.
 */
type PostedSerpTask = {
  taskId: string;
  keyword: string;
};

/**
 * Post a SERP task and keep its id.
 *
 * **Depth 10, and only 10.** `ai_summary` reads the SERP the task collected,
 * so depth is what bounds the evidence — but the task is posted here purely to
 * obtain an id the caller may ask a question of, and the extra pages are billed
 * whether or not anyone ever asks. Ten results is one page fetch. A caller
 * that needs a deeper SERP to *read* should use `fetchLiveSerp`, which is a
 * different job with a different cost.
 */
export async function postSerpTaskForSummary(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
}): Promise<DataforseoApiResponse<PostedSerpTask>> {
  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    "/v3/serp/google/organic/task_post",
    [
      {
        keyword: input.keyword,
        location_code: input.locationCode,
        language_code: input.languageCode,
        device: "desktop",
        os: "windows",
        depth: 10,
      },
    ],
    NO_RETRY_BILLED_POST,
  );

  // **Not `assertOk`.** That helper treats anything but 20000 as a failure,
  // which is right for the fetch endpoints and wrong here: a POST answers
  // `20100 "Task Created"` on success. `postRankCheckTasks` reads the status
  // directly for the same reason, and copying that is deliberate — a shared
  // helper whose ladder does not include 20100 would report a successful post
  // as a charged failure and bill the customer for our own misreading.
  if (!response || response.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message ||
        "DataForSEO task_post failed, so there is no SERP to ask a question of",
    );
  }

  const task = response.tasks?.[0];
  const id = typeof task?.id === "string" ? task.id : undefined;
  if (!task || !id) {
    // A post that returned no id produced no task, so there is nothing to ask.
    // Failing here rather than passing an empty id downstream means the caller
    // is told the post failed instead of receiving a 40501 on the next call.
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO task_post returned no task id, so there is no SERP to ask a question of",
    );
  }

  // **The envelope being 20000 says nothing about the task.** A request-level
  // OK with a rejected entry is the documented shape — status 40501 "Invalid
  // Field" arrives inside a 20000 envelope, and the post is billed either way.
  // Accepting the id here would hand back a task that does not exist and spend
  // the customer's 10 credits discovering it on the next call.
  //
  // 20100 is what a POST returns on success; 20000 is accepted too because the
  // vendor has used both, and a completed task is still a task we can ask.
  if (task.status_code !== 20100 && task.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      `DataForSEO task_post rejected the task (${task.status_code ?? "no status"}): ${
        task.status_message ?? "no message"
      }. No SERP was stored, so there is nothing to ask a question of.`,
    );
  }

  return {
    data: { taskId: id, keyword: input.keyword },
    billing: buildTaskBilling(task),
  };
}

/**
 * Pull the markdown links out of a summary.
 *
 * The vendor appends them as `[title](url)` when `include_links` is true, so
 * they are recovered rather than re-derived — and **the prose keeps them too**,
 * because where the model chose to place a citation is part of the answer.
 * A summary with no links yields an empty list, which means "it cited
 * nothing", not "we failed to parse".
 */
function extractLinks(summary: string): Array<{ title: string; url: string }> {
  const links: Array<{ title: string; url: string }> = [];
  for (const match of summary.matchAll(
    /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
  )) {
    const title = match[1]?.trim() ?? "";
    const url = match[2];
    if (!url) continue;
    const existing = links.find((link) => link.url === url);
    if (existing) continue;
    links.push({ title: title === "" ? url : title, url });
  }
  return links;
}

type AiSummaryInput = {
  /** The SERP task to ask. Valid for 30 days from the POST that created it. */
  taskId: string;
  /** The question. Max 2000 characters, and must be relevant to the keyword. */
  prompt: string;
  /** Let the model reason over the answer box, knowledge graph and snippet. */
  supportExtra?: boolean;
  /**
   * Crawl the pages behind the results. Off by default and **not** covered by
   * the $0.01 — this is the one flag here that bills page fetches.
   */
  fetchContent?: boolean;
  /** Ask the vendor to append source links to the summary. Default true. */
  includeLinks?: boolean;
};

/**
 * Ask one posted SERP task a question.
 *
 * Billed at `$0.01` per request regardless of prompt length, so there is no
 * batching here to save money — but `fetch_content` is a separate spend, which
 * is why it is a flag rather than a default.
 */
export async function fetchAiSummary(
  input: AiSummaryInput,
): Promise<DataforseoApiResponse<AiSummaryResult>> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new AppError("VALIDATION_ERROR", "prompt is required");
  }
  if (prompt.length > AI_SUMMARY_PROMPT_MAX) {
    // Checked before the request: DataForSEO bills the task that fails, so a
    // length check that only ran server-side would cost the customer a cent to
    // learn something we could have known.
    throw new AppError(
      "VALIDATION_ERROR",
      `prompt must be ${AI_SUMMARY_PROMPT_MAX} characters or fewer; received ${prompt.length}.`,
    );
  }
  if (input.taskId.trim().length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "task_id is required. Post a SERP task first — DataForSEO keeps a task id valid for 30 days.",
    );
  }

  const response = await dataforseoPost(
    PATH,
    [
      {
        task_id: input.taskId,
        prompt,
        support_extra: input.supportExtra ?? true,
        fetch_content: input.fetchContent ?? false,
        include_links: input.includeLinks ?? true,
      },
    ],
    // Billed on acceptance; a 5xx on the way back does not prove the provider
    // skipped the charge, so replaying it would bill the customer twice.
    NO_RETRY_BILLED_POST,
  );

  const task = assertOk(response, {
    classify: classifySerpError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO serp/ai_summary returned an unexpected payload",
    );
  }

  const summary = raw.data.items?.[0]?.summary ?? "";
  return {
    data: {
      summary,
      links: extractLinks(summary),
      itemsCount: raw.data.items_count ?? null,
    },
    billing: buildTaskBilling(task),
  };
}
