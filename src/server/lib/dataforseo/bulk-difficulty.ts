import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";

/**
 * Bulk keyword difficulty: KD for up to 1,000 keywords in one live call.
 *
 * ## [V] — endpoint reference read 2026-10-16
 *
 * `docs.dataforseo.com/v3/dataforseo_labs/google/bulk_keyword_difficulty/live`:
 * POST, one task per call, `keywords[]` required (max 1,000, UTF-8, lowercased
 * server-side), location code-or-name required, language code-or-name required,
 * optional `tag` (255 chars). Response `result[0].items[]` carries
 * `{se_type, keyword, keyword_difficulty}` — difficulty on a logarithmic 0–100
 * scale for cracking the top-10 organic results.
 *
 * ## The price triple, and the discrepancy inside it
 *
 * Endpoint path: `/v3/dataforseo_labs/google/bulk_keyword_difficulty/live`.
 * Book entry: `DFS_LABS.standard` ($0.012/request + $0.00012/keyword) — the Labs
 * family tier, the same tier `search_intent` carries in its own entry. Test pin:
 * `estimates.test.ts` pins the estimator's formula (see `estimateBulkDifficulty`).
 *
 * The reference's own sample response carries `cost: 0.0103` for 3 keywords,
 * which matches NEITHER the family tier ($0.01236 quoted) NOR a flat per-request
 * figure. Doc-sample costs are illustrative, so the family tier governs and the
 * direction is the safe one (overquote); CL-712a's live call settles the number.
 *
 * ## Market-scoped, unlike its sibling
 *
 * `search_intent` takes no location and no language; this endpoint requires one
 * of each pair. A caller copying this client's market handling onto
 * `search_intent` sends a billed rejection, and a caller copying `search_intent`'s
 * marketlessness here does the same in the other direction. The two clients
 * document each other for exactly this reason.
 *
 * ## A bought response is never discarded over one item
 *
 * `keyword_difficulty` outside 0–100, or a non-number, parses to `null` for that
 * keyword rather than failing the batch: the request succeeded and was billed,
 * so throwing the whole batch away over one anomalous row is the expensive
 * direction. Null means "unmeasured", never zero — a zero difficulty would read
 * as trivially easy, which is the most expensive misreading this module can ship.
 * A row whose `keyword` is not a usable string cannot join to anything, so that
 * row alone is dropped (the batch survives). The optional `tag` is refused above
 * 255 characters rather than sent to a billed rejection.
 */

const classifyBulkDifficultyError = createDataforseoBillingClassifier({
  pathPrefix: "/dataforseo_labs/",
  // A Labs code rather than the AI search one: the codes are per integration, so a
  // telemetry reader can tell which vendor family refused.
  billingIssueCode: "LABS_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/** `[V]` — the reference's task table, read 2026-10-16. */
const PATH = "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live";

export const MAX_BULK_DIFFICULTY_KEYWORDS = 1000;

/**
 * The per-keyword length this client accepts, and the rule is a **refusal rather
 * than a truncation**.
 *
 * The endpoint documents a 1,000-keyword cap and **no character limit**, so there
 * is nothing to truncate *to* — the same position `search-intent.ts` takes, for
 * the same reason. Both obvious alternatives are wrong: sending an over-long
 * keyword risks a billed rejection the caller never sees, and silently shortening
 * it changes the keyword, which then no longer joins to the metrics it came from.
 *
 * So the bound is the strictest keyword length the vendor documents anywhere in
 * this family — AI Keyword Data's 250 characters — and a longer keyword is refused
 * **by count**, in a sentence that says why. Visible, free, and it cannot corrupt
 * a join.
 */
const MAX_BULK_DIFFICULTY_KEYWORD_CHARS = 250;

const itemSchema = z
  .object({
    // `unknown` on purpose: one anomalous row must not fail the batch via
    // `safeParse`. `toDifficulty` nulls bad difficulties and rows without a
    // usable keyword are dropped below — the batch always survives parsing.
    keyword: z.unknown(),
    keyword_difficulty: z.unknown(),
  })
  .passthrough();

const resultSchema = z
  .object({
    items_count: z.number().nullish(),
    // `unknown` rows on purpose: one malformed row (null, a string, a number)
    // must not fail `safeParse` and discard the paid batch. Each row is parsed
    // on its own below and unusable rows are dropped individually.
    items: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type BulkDifficultyItem = {
  keyword: string;
  /** Null when the vendor returned no usable difficulty — unmeasured, never zero. */
  keywordDifficulty: number | null;
};

type BulkDifficultyResult = { items: BulkDifficultyItem[] };

/**
 * Trim and lowercase.
 *
 * The lowercase matches what the vendor does server-side, so the keyword returned
 * in the response is the key the caller sent — the join problem
 * `normaliseAiKeyword` names. No truncation here: see
 * `MAX_BULK_DIFFICULTY_KEYWORD_CHARS`.
 */
export function normaliseBulkDifficultyKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export function validateBulkDifficultyBatch(keywords: string[]): string[] {
  if (keywords.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one keyword is required for a bulk-difficulty request",
    );
  }
  if (keywords.length > MAX_BULK_DIFFICULTY_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO accepts at most ${MAX_BULK_DIFFICULTY_KEYWORDS} keywords per bulk-difficulty request; received ${keywords.length}. Split the batch.`,
    );
  }

  // Read through `unknown`: the parameter is typed `string[]`, so this check
  // is for JS callers outside the type boundary — no assertion needed.
  const raw: readonly unknown[] = keywords;
  const nonStrings = raw.filter(
    (keyword) => typeof keyword !== "string",
  ).length;
  if (nonStrings > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${nonStrings} keyword(s) were not strings. Keywords must be strings before normalisation — anything else cannot join to the metrics it came from.`,
    );
  }

  const normalised = keywords.map(normaliseBulkDifficultyKeyword);
  const blanks = normalised.filter((keyword) => keyword.length === 0).length;
  if (blanks > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${blanks} keyword(s) were empty after normalisation`,
    );
  }

  const tooLong = normalised.filter(
    (keyword) => keyword.length > MAX_BULK_DIFFICULTY_KEYWORD_CHARS,
  );
  if (tooLong.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${tooLong.length} keyword(s) are longer than ${MAX_BULK_DIFFICULTY_KEYWORD_CHARS} characters. This endpoint documents no character limit, so they are refused rather than silently shortened — a shortened keyword stops matching the one you sent. Shorten them and send again.`,
    );
  }

  return [...new Set(normalised)];
}

function requireMarketPair(
  values: readonly (string | number | null | undefined)[],
  label: string,
): void {
  const present = values.some(
    (value) =>
      value !== null && value !== undefined && `${value}`.trim() !== "",
  );
  if (!present) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A bulk-difficulty request needs ${label}: one of the pair is required and an empty request is a billed rejection`,
    );
  }
}

function toDifficulty(value: unknown): number | null {
  // A difficulty is usable only as a finite number inside the documented 0–100
  // scale. Anything else — a string, null, NaN, or a number outside the scale
  // the vendor documents — is unmeasured, never zero. Nulling an out-of-range
  // number is not falsifying a measurement: outside 0–100 the value cannot be
  // the logarithmic top-10 scale the reference documents, so presenting it
  // as one would be the falsification.
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

export async function fetchBulkKeywordDifficulty(input: {
  keywords: string[];
  locationCode?: number;
  locationName?: string;
  languageCode?: string;
  languageName?: string;
  tag?: string;
}): Promise<DataforseoApiResponse<BulkDifficultyResult>> {
  const keywords = validateBulkDifficultyBatch(input.keywords);
  if (input.tag !== undefined && input.tag.length > 255) {
    throw new AppError(
      "VALIDATION_ERROR",
      "The bulk-difficulty tag accepts at most 255 characters; a longer tag is a billed rejection, so it is refused before the network is reached",
    );
  }
  requireMarketPair(
    [input.locationCode, input.locationName],
    "location_code or location_name",
  );
  requireMarketPair(
    [input.languageCode, input.languageName],
    "language_code or language_name",
  );

  const response = await dataforseoPost(
    PATH,
    [
      {
        keywords,
        // Code wins when both are given: the vendor resolves codes exactly
        // and names ambiguously, so the exact one is sent.
        ...(input.locationCode !== undefined
          ? { location_code: input.locationCode }
          : { location_name: input.locationName }),
        ...(input.languageCode !== undefined
          ? { language_code: input.languageCode }
          : { language_name: input.languageName }),
        ...(input.tag ? { tag: input.tag } : {}),
      },
    ],
    { classify: classifyBulkDifficultyError },
  );

  const task = assertOk(response, {
    classify: classifyBulkDifficultyError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned an unexpected bulk-difficulty payload",
    );
  }

  const data = raw.data;
  const items: BulkDifficultyItem[] = [];
  for (const row of data.items ?? []) {
    // Parsed per row: a malformed row drops alone and the paid batch survives.
    const parsed = itemSchema.safeParse(row);
    if (!parsed.success) continue;
    const item = parsed.data;
    // A row without a usable keyword cannot join to anything the caller sent
    // (whitespace-only is unusable too — it matches nothing after the join
    // key is normalised), so it is dropped on its own.
    if (typeof item.keyword !== "string" || item.keyword.trim().length === 0)
      continue;
    items.push({
      keyword: item.keyword,
      keywordDifficulty: toDifficulty(item.keyword_difficulty),
    });
  }
  return {
    data: { items },
    billing: buildTaskBilling(task),
  };
}
