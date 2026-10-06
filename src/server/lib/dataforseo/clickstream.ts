/**
 * `keywords_data/clickstream_data/global_search_volume/live` — measured search volume.
 *
 * ## What this endpoint is for, and what it is not
 *
 * Clickstream volume comes from real user-panel traffic rather than Google Ads' modelled
 * figures, which makes it the closest thing to a second opinion on any volume number this
 * product shows. It is therefore **arbitration**: it settles a question about a number we
 * already have, and it never fetches the corpus. `@/shared/volume-routing` holds that
 * policy as data, and this client reads its cap from there rather than keeping a second
 * copy of the number.
 *
 * ## Verified against the endpoint reference, 2026-10-06
 *
 * - `keywords` is the only required field: **up to 1,000**, **each at least 3 characters**,
 *   lowercased server-side, and symbols/emoji are rejected outright.
 * - **There is no `location_code` and no `language_code`.** The measurement is *global* by
 *   definition, and the response carries the country split instead. That is the whole trap
 *   of this endpoint: **comparing its global number to a national one is the exact
 *   dishonesty this client exists to prevent**, so callers must read the country figure
 *   from `country_distribution` rather than the top-level `search_volume`.
 * - Live only, one task per call, 30 concurrent.
 *
 * The reference's own sample response shows `cost: 0.15`; our price book says **$0.18 a
 * call**, read from the pricing page on 2026-09-28. The sample is stamped
 * `version 0.1.20240801`, so it predates the current price and the book wins. Billing
 * reads the task's own `cost` either way, so a price change cannot go unnoticed.
 */
import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";
import { keywordsPerTaskFor } from "@/shared/volume-routing";

/** keywords_data tasks return their rows directly in `result`, with no items wrapper. */
type KeywordsDataTask<T> = DataforseoTaskLike & { result?: T[] };

/** The documented floor. A shorter keyword is rejected by the vendor, and billed. */
export const MIN_CLICKSTREAM_KEYWORD_CHARS = 3;

/** `[V]` endpoint reference, read 2026-10-06. */
const GLOBAL_SEARCH_VOLUME_PATH =
  "/v3/keywords_data/clickstream_data/global_search_volume/live";

const countryShareSchema = z
  .object({
    country_iso_code: z.string().nullish(),
    search_volume: z.number().nullish(),
    percentage: z.number().nullish(),
  })
  .passthrough();

const itemSchema = z
  .object({
    keyword: z.string(),
    search_volume: z.number().nullish(),
    country_distribution: z.array(countryShareSchema).nullish(),
  })
  .passthrough();

type ClickstreamCountryShare = {
  /** Null for the vendor's own "unknown country" bucket, which it does emit. */
  countryIsoCode: string | null;
  searchVolume: number | null;
  /** Share of the global figure, as the vendor reports it. */
  percentage: number | null;
};

type ClickstreamVolume = {
  keyword: string;
  /** The **global** figure. Not a national one: see the file header. */
  globalVolume: number | null;
  countryDistribution: ClickstreamCountryShare[];
};

/** Trim and lowercase, matching what the vendor does to the keywords it receives. */
export function normaliseClickstreamKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

/**
 * Validate a batch, refusing anything the vendor would reject rather than paying for a
 * failed task.
 *
 * The 3-character floor is refused **by count**, not silently dropped: a dropped keyword
 * would leave a gap in the reconciliation that looks like "no measurement exists", which
 * is a different answer.
 */
export function validateClickstreamKeywords(keywords: string[]): string[] {
  if (keywords.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one keyword is required for a clickstream volume request",
    );
  }

  const max = keywordsPerTaskFor("clickstream_global");
  if (keywords.length > max) {
    throw new AppError(
      "VALIDATION_ERROR",
      `DataForSEO accepts at most ${max} keywords per clickstream request; received ${keywords.length}. Split the batch.`,
    );
  }

  const normalised = keywords.map(normaliseClickstreamKeyword);
  const tooShort = normalised.filter(
    (keyword) => keyword.length < MIN_CLICKSTREAM_KEYWORD_CHARS,
  );
  if (tooShort.length > 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${tooShort.length} keyword(s) are shorter than ${MIN_CLICKSTREAM_KEYWORD_CHARS} characters, which this endpoint rejects outright. Remove them and send again.`,
    );
  }

  return [...new Set(normalised)];
}

export async function fetchClickstreamVolumes(input: {
  keywords: string[];
  tag?: string;
}): Promise<DataforseoApiResponse<ClickstreamVolume[]>> {
  const keywords = validateClickstreamKeywords(input.keywords);

  // **No location and no language.** The endpoint takes neither, and a task carrying an
  // unknown field is rejected and billed.
  const response = await dataforseoPost<KeywordsDataTask<unknown>>(
    GLOBAL_SEARCH_VOLUME_PATH,
    [
      {
        keywords,
        ...(input.tag ? { tag: input.tag } : {}),
      },
    ],
  );

  const task = assertOk(response);
  const rows = (task.result ?? [])
    .map((item) => itemSchema.safeParse(item))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);

  return {
    data: rows.map((item) => ({
      keyword: item.keyword,
      globalVolume: item.search_volume ?? null,
      countryDistribution: (item.country_distribution ?? []).map((share) => ({
        countryIsoCode: share.country_iso_code ?? null,
        searchVolume: share.search_volume ?? null,
        percentage: share.percentage ?? null,
      })),
    })),
    billing: buildTaskBilling(task),
  };
}
