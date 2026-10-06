import { z } from "zod";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * Search intent: what the person typing a keyword is trying to do.
 *
 * ## The one Labs endpoint with no market parameter, and why that is the point
 *
 * Every sibling in this folder takes a `location_code` and a `language_code`. This
 * one takes **neither**. Verified on 2026-10-06 against the endpoint reference —
 * `keywords` and `tag` are the only task fields it lists — and against the vendor's
 * *keyword rules* article, which puts `search_intent` in one sentence: **up to 1,000
 * keywords per call, UTF-8, each lowercased server-side**, and multilingual
 * embeddings since 2026-09-24.
 *
 * That is not a detail, it is the reason this client caches cleanly. **Intent is a
 * property of the keyword rather than of the market**, so storing it per
 * (project, keyword) with no market column is *correct* rather than convenient —
 * which is what the prompt-set generator assumed when it read
 * `keyword_metrics.intent`. A `location_code` here would have been an invented
 * parameter, and the vendor **bills a task that fails**, so inventing one costs
 * money rather than raising an error.
 *
 * ## The second-best intent is kept, because that is where the use is
 *
 * `keyword_intent` carries the most probable intent and its probability;
 * `secondary_keyword_intents` carries the others. Dropping them would throw away the
 * one thing that makes a borderline keyword usable: *transactional 0.52,
 * informational 0.39* says "this could be either", and a writer deciding what to
 * produce needs that sentence. The field is `null` more often than not, and that
 * means "no second intent worth reporting" rather than "unknown" — so it parses to
 * `[]` and the distinction survives in the probabilities.
 *
 * ## A response we already paid for is never discarded over one item
 *
 * The four labels are documented, and the keywords feature already models *a label
 * outside them* as its own fifth value. This follows that: an unrecognised label
 * parses to **`unknown`** rather than failing the schema. The request succeeded and
 * was billed, so throwing the whole batch away because one keyword came back with a
 * word we had not seen would be the expensive direction — and the value is typed, so
 * a caller branching on intent must handle it.
 */

const classifySearchIntentError = createDataforseoBillingClassifier({
  pathPrefix: "/dataforseo_labs/",
  // A Labs code rather than the AI search one: the codes are per integration, so a
  // telemetry reader can tell which vendor family refused.
  billingIssueCode: "LABS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/** `[V]` — endpoint reference and keyword-rules article, both read 2026-10-06. */
const PATH = "/v3/dataforseo_labs/google/search_intent/live";

export const MAX_SEARCH_INTENT_KEYWORDS = 1000;

/**
 * The per-keyword length this client accepts, and the rule is a **refusal rather
 * than a truncation**.
 *
 * The vendor documents a 1,000-keyword cap for this endpoint and **no character
 * limit**, so there is nothing to truncate *to*. Both obvious alternatives are
 * wrong: sending an over-long keyword risks a billed rejection the caller never
 * sees, and silently shortening it changes the keyword — which then no longer joins
 * to the metrics it came from, the failure `normaliseAiKeyword` exists to prevent.
 *
 * So the bound is the strictest keyword length the vendor *does* document for this
 * family — AI Keyword Data's 250 characters — and a longer keyword is refused **by
 * count**, in a sentence that says why. Visible, free, and it cannot corrupt a join.
 */
const MAX_SEARCH_INTENT_KEYWORD_CHARS = 250;

/** The four labels the vendor documents. Private: the type below is the surface. */
const SEARCH_INTENT_LABELS = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
] as const;
type SearchIntentLabel = (typeof SEARCH_INTENT_LABELS)[number];

/**
 * A reported intent: the four documented labels, or `unknown`.
 *
 * `unknown` is a first-class value here rather than an error, matching the keywords
 * feature's own vocabulary — a label the vendor adds tomorrow degrades one keyword's
 * classification instead of failing a response we have already been charged for.
 */
type ReportedSearchIntent = SearchIntentLabel | "unknown";

const intentSchema = z
  .object({
    // A plain string rather than an enum on purpose: see the file header. The mapping
    // to `unknown` is a decision, and a schema that rejected the value would make it
    // a thrown error instead.
    label: z.string(),
    probability: z.number().nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    keyword: z.string(),
    keyword_intent: intentSchema.nullish(),
    secondary_keyword_intents: z.array(intentSchema).nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    items_count: z.number().nullish(),
    items: z.array(itemSchema).nullish(),
  })
  .passthrough();

type SearchIntentItem = {
  keyword: string;
  /** Null when the vendor returned no intent for this keyword at all. */
  intent: ReportedSearchIntent | null;
  /** `1` is the most probable. Null when the vendor omitted it. */
  probability: number | null;
  secondaryIntents: Array<{
    intent: ReportedSearchIntent;
    probability: number | null;
  }>;
};

type SearchIntentResult = { items: SearchIntentItem[] };

/** A **type guard** rather than a cast: the narrowing has to be checked, not asserted. */
function isSearchIntentLabel(value: string): value is SearchIntentLabel {
  return SEARCH_INTENT_LABELS.some((label) => label === value);
}

function toIntentLabel(value: string): ReportedSearchIntent {
  return isSearchIntentLabel(value) ? value : "unknown";
}

/**
 * Trim and lowercase.
 *
 * The lowercase matches what the vendor does server-side, so the keyword returned in
 * the response is the key the caller sent — the join problem `normaliseAiKeyword`
 * names. No truncation here: see `MAX_SEARCH_INTENT_KEYWORD_CHARS`.
 */
export function normaliseSearchIntentKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export function validateSearchIntentBatch(keywords: string[]): string[] {
  if (keywords.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one keyword is required for a search-intent request",
    );
  }
  if (keywords.length > MAX_SEARCH_INTENT_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO accepts at most ${MAX_SEARCH_INTENT_KEYWORDS} keywords per search-intent request; received ${keywords.length}. Split the batch.`,
    );
  }

  const normalised = keywords.map(normaliseSearchIntentKeyword);
  const blanks = normalised.filter((keyword) => keyword.length === 0).length;
  if (blanks > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${blanks} keyword(s) were empty after normalisation`,
    );
  }

  const tooLong = normalised.filter(
    (keyword) => keyword.length > MAX_SEARCH_INTENT_KEYWORD_CHARS,
  );
  if (tooLong.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${tooLong.length} keyword(s) are longer than ${MAX_SEARCH_INTENT_KEYWORD_CHARS} characters. This endpoint documents no character limit, so they are refused rather than silently shortened — a shortened keyword stops matching the one you sent. Shorten them and send again.`,
    );
  }

  return [...new Set(normalised)];
}

export async function fetchSearchIntent(input: {
  keywords: string[];
  tag?: string;
}): Promise<DataforseoApiResponse<SearchIntentResult>> {
  const keywords = validateSearchIntentBatch(input.keywords);

  // **Only `keywords` and `tag`.** No location, no language: the endpoint takes
  // neither, and a task carrying an unknown field is a billed rejection.
  const response = await dataforseoPost(
    PATH,
    [
      {
        keywords,
        ...(input.tag ? { tag: input.tag } : {}),
      },
    ],
    { classify: classifySearchIntentError },
  );

  const task = assertOk(response, {
    classify: classifySearchIntentError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned an unexpected search-intent payload",
    );
  }

  const data = raw.data;
  return {
    data: {
      items: (data.items ?? []).map((item) => ({
        keyword: item.keyword,
        intent: item.keyword_intent
          ? toIntentLabel(item.keyword_intent.label)
          : null,
        probability: item.keyword_intent?.probability ?? null,
        secondaryIntents: (item.secondary_keyword_intents ?? []).map(
          (secondary) => ({
            intent: toIntentLabel(secondary.label),
            probability: secondary.probability ?? null,
          }),
        ),
      })),
    },
    billing: buildTaskBilling(task),
  };
}
