import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import { NO_RETRY_BILLED_POST } from "@/server/lib/dataforseo/billedTasks";
import { AppError } from "@/server/lib/errors";
import type { LlmModelSlug } from "@/server/lib/dataforseo/llm-models";
import {
  isRecord,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

/**
 * The Standard (queued) half of `llm_responses`.
 *
 * ## Why the path is platform-scoped
 *
 * The queued endpoint is **not** `/v3/ai_optimization/llm_responses/task_post`.
 * It is `/v3/ai_optimization/{se}/llm_responses/task_post`, where `se` is
 * `chat_gpt`, `claude`, `gemini` or `perplexity` — and the bare form 404s. The
 * same is true of `tasks_ready` and `task_get`. The existing Live client calls
 * `/live` on the shared prefix, which is why the queue path looks unavailable
 * from the code and is not.
 *
 * ## Four things the ledger and the internal gotchas file both get wrong
 *
 * 1. **The per-POST cap is 100, and it is not the same cap SERP uses by
 *    accident.** The internal table lists "Most `task_post` endpoints: 100" and
 *    `MAX_TASKS_PER_POST = 100` is what the SERP client uses. The LLM Responses
 *    page independently documents the same 100-task POST limit, and separately a
 *    2,000-request-per-minute *request* rate. Two different numbers that happen
 *    to agree: 100 bounds the batch, 2,000/min bounds the calls. Exceeding the
 *    batch cap returns 40006. Kept as a named constant with its verification
 *    date so nobody re-derives it from the wrong one.
 *
 * 2. **Standard is not 5 minutes here — the documented worst case is 72 hours.**
 *    The internal gotchas file's "~5 minutes on average" belongs to the SERP
 *    queue. An LLM Response can be *pending* for most of three days, and is then
 *    marked failed with the $0.01 advance **refunded**. This is the single
 *    most important difference: a nightly cron that posts work and expects
 *    results in minutes is not a nightly cron, it is a queue that takes a week
 *    to drain.
 *
 * 3. **It costs a $0.01 prepayment per task at POST time, refunded if the model
 *    costs less.** So the charge is *provisional* and settled later by
 *    `task_get`. Metering on the post-time figure understates nothing and
 *    overstates nothing, but the reconciliation has to be explicit about which
 *    number it is — the same distinction CL-201 drew for the Live path.
 *
 * 4. **`tasks_ready` is a *list of ids*, not results**, and it only lists tasks
 *    that were never collected. If a `postback_url` succeeded, the task will
 *    **not** appear — so using `tasks_ready` alongside postbacks to *discover*
 *    work double-counts nothing but does re-collect anything whose postback
 *    failed. The endpoint is for recovery, which is why it is not on the hot
 *    path here.
 *
 * ## `result: null` still means pending
 *
 * Unchanged from Live, and the reason `task_get` is polled rather than trusted:
 * HTTP 200 with `result: null` means the task was created and has not finished.
 * See `docs/DATAFORSEO_GOTCHAS.md` §1.5.
 *
 * Verified against the live docs on 2026-09-29.
 */

/** Documented cap for one `llm_responses` POST. Exceeding it returns 40006. */
export const MAX_TASKS_PER_LLM_POST = 100;

interface LlmResponseTaskInput {
  /** Up to 500 characters, per the endpoint's own limit. */
  userPrompt: string;
  modelName: string;
  /** Echoed on the response and on `tasks_ready`, so results map back by tag. */
  tag: string;
  webSearch?: boolean;
  systemMessage?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

interface PostedLlmResponseTask {
  taskId: string;
  tag: string;
  /** What the vendor charged at post time — the $0.01 advance, not the final cost. */
  costUsd: number;
}

function base(se: LlmModelSlug): string {
  return `/v3/ai_optimization/${se}/llm_responses`;
}

function taskBody(input: LlmResponseTaskInput): Record<string, unknown> {
  return {
    user_prompt: input.userPrompt,
    model_name: input.modelName,
    tag: input.tag,
    ...(input.webSearch === true ? { web_search: true } : {}),
    ...(input.systemMessage === undefined
      ? {}
      : { system_message: input.systemMessage }),
    ...(input.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: input.maxOutputTokens }),
    ...(input.temperature === undefined
      ? {}
      : { temperature: input.temperature }),
  };
}

/**
 * Post up to 100 LLM Response tasks in one call.
 *
 * Billed on acceptance, so this must not be retried on a server error — a 5xx on
 * the way back does not prove the vendor skipped the charge, and replaying it
 * creates a *second* batch of prepaid tasks. `NO_RETRY_BILLED_POST` plus the
 * gate in `billedTasks.test.ts`, which fails if a `task_post` in this directory
 * ever loses the opt-out.
 */
export async function postLlmResponseTasks(input: {
  se: LlmModelSlug;
  tasks: LlmResponseTaskInput[];
}): Promise<DataforseoApiResponse<PostedLlmResponseTask[]>> {
  const { se, tasks } = input;
  if (tasks.length === 0 || tasks.length > MAX_TASKS_PER_LLM_POST) {
    // Refusing rather than truncating: a silently shortened batch would produce
    // answers for a subset of the prompts, and the caller would report a
    // patrol that covered everything.
    throw new AppError(
      "INTERNAL_ERROR",
      `task_post accepts 1-${MAX_TASKS_PER_LLM_POST} tasks, got ${tasks.length}`,
    );
  }

  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(`${base(se)}/task_post`, tasks.map(taskBody), NO_RETRY_BILLED_POST);

  // One response entry per submitted task; accepted entries have status 20100
  // "Task Created" and their own cost — the $0.01 advance, charged at post time.
  //
  // Cost is summed over **every** entry, accepted or not, because anything the
  // vendor charged has to be metered. A rejected entry still costs us the
  // request; ignoring it would understate the bill and, per CL-201, an
  // undercounted cap is not a cap.
  const posted: PostedLlmResponseTask[] = [];
  let costUsd = 0;
  for (const task of response?.tasks ?? []) {
    costUsd += task.cost ?? 0;
    const id = typeof task.id === "string" ? task.id : null;
    if (id === null) continue;
    const data = isRecord(task.data) ? task.data : {};
    const tag = typeof data.tag === "string" ? data.tag : "";
    posted.push({ taskId: id, tag, costUsd: task.cost ?? 0 });
  }

  return {
    data: posted,
    // The cost here is the $0.01 prepayment, not the model's final cost. The
    // caller reconciles against `task_get`; see the module docblock. `path` is
    // the vendor's own routing breadcrumb, kept because every other call in this
    // SDK reports it and a cost without one is not traceable to a request.
    // Narrowed from `unknown` because the envelope carries an index signature:
    // absent means "the vendor did not say", which is an empty list rather than
    // a guess at a path.
    billing: { path: readPath(response?.path), costUsd },
  };
}

/**
 * The vendor's routing breadcrumb, or `[]` when it did not report one.
 *
 * Narrowed from `unknown` because the envelope carries an index signature:
 * absent means "the vendor did not say", which is an empty list rather than a
 * guess at a path.
 */
function readPath(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : [];
}

/** One completed task id, as `tasks_ready` reports it. */
type ReadyLlmTask = { taskId: string; tag: string; endpoint: string };

/**
 * List completed-but-uncollected task ids.
 *
 * **Recovery only.** The docs are explicit: a task whose `postback_url` delivery
 * succeeded will not appear here, and the list lags. Calling this on the hot
 * path would be a second discovery mechanism racing the postback handler, and
 * the failure mode is benign either way — a task collected twice returns the
 * same result, whereas a task never collected is invisible.
 *
 * Uncharged: the endpoint returns `cost: 0`.
 */
export async function listReadyLlmTasks(
  se: LlmModelSlug,
): Promise<ReadyLlmTask[]> {
  const response = await dataforseoGet(base(se) + "/tasks_ready");
  const ready: ReadyLlmTask[] = [];
  for (const task of response?.tasks ?? []) {
    for (const entry of task.result ?? []) {
      if (!isRecord(entry)) continue;
      const { id, tag, endpoint } = entry;
      if (typeof id !== "string") continue;
      if (typeof endpoint !== "string") continue;
      ready.push({
        taskId: id,
        tag: typeof tag === "string" ? tag : "",
        endpoint,
      });
    }
  }
  return ready;
}

/**
 * Collect one task's result.
 *
 * `result: null` with HTTP 200 means **pending**, not failed — the single most
 * misread field in this API, and the reason the caller needs the status code
 * rather than the result alone. `tasks_ready` and `task_get` are uncharged; the
 * documented response carries `cost: 0`.
 */
export async function getLlmResponseTask(
  se: LlmModelSlug,
  taskId: string,
): Promise<DataforseoApiResponse<unknown>> {
  const response = await dataforseoGet(
    `${base(se)}/task_get/${encodeURIComponent(taskId)}`,
  );
  const task = response?.tasks?.[0];
  return {
    data: task?.result ?? null,
    // Not `buildTaskBilling`: that throws when a task carries no billing
    // metadata, and a *pending* task legitimately has none. The result of a
    // not-yet-finished task is a normal outcome, not a malformed response.
    billing: { path: readPath(task?.path), costUsd: task?.cost ?? 0 },
  };
}
