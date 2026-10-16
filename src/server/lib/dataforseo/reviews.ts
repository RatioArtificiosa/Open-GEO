import { z } from "zod";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  isNoResultsTask,
  isTaskInProgress,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/**
 * Trustpilot + Tripadvisor review clients (CL-504).
 *
 * Google's reviews live in `business.ts`; these two platforms did not exist
 * anywhere in src. Every field below was read from the endpoint reference on
 * 2026-10-16 (task_post + task_get for both families) — the second use of
 * that toolchain in this area, and the one that paid for itself, because the
 * two families spell the same idea differently: Trustpilot wants a `domain`
 * and bills per 20 reviews, Tripadvisor wants a `url_path` (or a keyword
 * plus a location) and bills per 10.
 *
 * Posting is metered at the facade (NO_RETRY: a billed task_post the vendor
 * accepts and then drops must never be replayed). Collection is free for 30
 * days per both references, so the task_get readers below stay unmetered —
 * routing a free read through the meter would charge twice.
 */

const TRUSTPILOT_POST_PATH = "/v3/business_data/trustpilot/reviews/task_post";
const TRIPADVISOR_POST_PATH = "/v3/business_data/tripadvisor/reviews/task_post";

/** Trustpilot bills per 20 reviews; depth defaults to one block, caps at ten. */
const TRUSTPILOT_DEFAULT_DEPTH = 20;
const TRUSTPILOT_MAX_DEPTH = 200;
/** Tripadvisor bills per 10 reviews; depth defaults to one block. */
const TRIPADVISOR_DEFAULT_DEPTH = 10;
const TRIPADVISOR_MAX_DEPTH = 4490;

function postedTaskId(task: DataforseoTaskLike & { id?: string }): string {
  // Same contract as the Google collector in business.ts: 20100 'Task
  // Created' is the success status for posts, and a missing id is an
  // internal error rather than an empty answer.
  if (typeof task.id === "string" && task.id.length > 0) {
    return task.id;
  }
  throw new AppError("INTERNAL_ERROR", "DataForSEO did not return a task id");
}

const ratingSchema = z
  .object({
    rating_type: z.string().nullish(),
    value: z.number().nullish(),
    votes_count: z.number().nullish(),
    rating_max: z.number().nullish(),
  })
  .nullish();

const trustpilotItemSchema = z
  .object({
    type: z.string().nullish(),
    url: z.string().nullish(),
    rating: ratingSchema,
    verified: z.boolean().nullish(),
    timestamp: z.string().nullish(),
    title: z.string().nullish(),
    review_text: z.string().nullish(),
  })
  .passthrough();

const trustpilotResultSchema = z
  .object({
    domain: z.string().nullish(),
    reviews_count: z.number().nullish(),
    rating: ratingSchema,
    items_count: z.number().nullish(),
    items: z.array(trustpilotItemSchema).nullish(),
  })
  .passthrough();

type TrustpilotReviewsResult = z.infer<typeof trustpilotResultSchema>;

const tripadvisorItemSchema = z
  .object({
    type: z.string().nullish(),
    url: z.string().nullish(),
    rating: ratingSchema,
    timestamp: z.string().nullish(),
    title: z.string().nullish(),
    review_text: z.string().nullish(),
  })
  .passthrough();

const tripadvisorResultSchema = z
  .object({
    url_path: z.string().nullish(),
    reviews_count: z.number().nullish(),
    rating: ratingSchema,
    rating_distribution: z.record(z.string(), z.number()).nullish(),
    items_count: z.number().nullish(),
    items: z.array(tripadvisorItemSchema).nullish(),
  })
  .passthrough();

type TripadvisorReviewsResult = z.infer<typeof tripadvisorResultSchema>;

/**
 * Post a Trustpilot reviews task. `domain` is the Trustpilot slug from the
 * business URL (www.thepearlsource.com, not a full URL) — the one required
 * field, and the mistake the reference's own example exists to prevent.
 */
export async function postTrustpilotReviewsTask(input: {
  domain: string;
  depth?: number;
  sortBy?: "recency" | "relevance";
}): Promise<DataforseoApiResponse<string>> {
  const domain = input.domain.trim();
  if (domain.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "postTrustpilotReviewsTask needs a Trustpilot domain: without it the vendor bills a rejection",
    );
  }
  const depth = input.depth ?? TRUSTPILOT_DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > TRUSTPILOT_MAX_DEPTH) {
    throw new AppError(
      "VALIDATION_ERROR",
      `postTrustpilotReviewsTask takes depth 1-${TRUSTPILOT_MAX_DEPTH}; got ${input.depth}`,
    );
  }
  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    TRUSTPILOT_POST_PATH,
    [
      {
        domain,
        depth,
        sort_by: input.sortBy,
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  const task = assertOk(response, { okTaskStatusCode: 20100 });
  return {
    data: postedTaskId(task),
    billing: buildTaskBilling(task),
  };
}

/**
 * Post a Tripadvisor reviews task. `url_path` is the accurate selector (the
 * reference recommends it over keyword); without it, a keyword plus a
 * location is required — a keyword alone is a billed rejection, so the pair
 * is refused here rather than at the vendor.
 */
export async function postTripadvisorReviewsTask(input: {
  urlPath?: string;
  keyword?: string;
  locationCode?: number;
  locationName?: string;
  depth?: number;
}): Promise<DataforseoApiResponse<string>> {
  const urlPath = input.urlPath?.trim() ?? "";
  const keyword = input.keyword?.trim() ?? "";
  if (urlPath.length === 0) {
    if (keyword.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "postTripadvisorReviewsTask needs url_path or keyword: the vendor requires one and bills the rejection",
      );
    }
    if (
      input.locationCode == null &&
      (input.locationName?.trim() ?? "") === ""
    ) {
      throw new AppError(
        "VALIDATION_ERROR",
        "postTripadvisorReviewsTask needs a location with a keyword (location_code or location_name): a keyword alone is a billed rejection",
      );
    }
  }
  const depth = input.depth ?? TRIPADVISOR_DEFAULT_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > TRIPADVISOR_MAX_DEPTH) {
    throw new AppError(
      "VALIDATION_ERROR",
      `postTripadvisorReviewsTask takes depth 1-${TRIPADVISOR_MAX_DEPTH}; got ${input.depth}`,
    );
  }
  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    TRIPADVISOR_POST_PATH,
    [
      {
        url_path: urlPath.length > 0 ? urlPath : undefined,
        keyword: keyword.length > 0 ? keyword : undefined,
        location_code: input.locationCode,
        location_name: input.locationName,
        depth,
      },
    ],
    { maxServerErrorRetries: 0 },
  );
  const task = assertOk(response, { okTaskStatusCode: 20100 });
  return {
    data: postedTaskId(task),
    billing: buildTaskBilling(task),
  };
}

type TaskGetEnvelope = {
  status_code?: number;
  status_message?: string;
  tasks?: DataforseoTaskLike[];
};

function firstResult(
  envelope: TaskGetEnvelope | null,
  taskId: string,
): { status: "pending" | "completed"; result: unknown } {
  const task = envelope?.tasks?.[0];
  if (envelope?.status_code !== 20000 || !task) {
    throw new AppError(
      "INTERNAL_ERROR",
      envelope?.status_message ?? "DataForSEO task_get failed",
    );
  }
  void taskId;
  if (isTaskInProgress(task)) return { status: "pending", result: null };
  if (task.status_code !== 20000) {
    // "No Search Results" is a valid empty outcome, same as the Google
    // collector: no reviews yet is an answer, not a failure.
    if (!isNoResultsTask(task)) {
      throw new AppError(
        "INTERNAL_ERROR",
        task.status_message ??
          "DataForSEO task failed (" + task.status_code + ")",
      );
    }
    return { status: "completed", result: null };
  }
  return { status: "completed", result: task.result?.[0] ?? null };
}

/**
 * Collect a Trustpilot task. Free for 30 days per the reference — unmetered
 * by design, like the Google collector in business.ts.
 */
export async function fetchTrustpilotReviewsResult(
  taskId: string,
): Promise<
  | { status: "pending"; result: null }
  | { status: "completed"; result: TrustpilotReviewsResult | null }
> {
  const envelope = await dataforseoGet<TaskGetEnvelope>(
    `/v3/business_data/trustpilot/reviews/task_get/${encodeURIComponent(taskId)}`,
  );
  const outcome = firstResult(envelope, taskId);
  if (outcome.status === "pending") return { status: "pending", result: null };
  if (outcome.result === null) return { status: "completed", result: null };
  const parsed = trustpilotResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO trustpilot reviews returned an invalid shape",
    );
  }
  return { status: "completed", result: parsed.data };
}

/**
 * Collect a Tripadvisor task. Free for 30 days per the reference — unmetered
 * by design.
 */
export async function fetchTripadvisorReviewsResult(
  taskId: string,
): Promise<
  | { status: "pending"; result: null }
  | { status: "completed"; result: TripadvisorReviewsResult | null }
> {
  const envelope = await dataforseoGet<TaskGetEnvelope>(
    `/v3/business_data/tripadvisor/reviews/task_get/${encodeURIComponent(taskId)}`,
  );
  const outcome = firstResult(envelope, taskId);
  if (outcome.status === "pending") return { status: "pending", result: null };
  if (outcome.result === null) return { status: "completed", result: null };
  const parsed = tripadvisorResultSchema.safeParse(outcome.result);
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO tripadvisor reviews returned an invalid shape",
    );
  }
  return { status: "completed", result: parsed.data };
}
