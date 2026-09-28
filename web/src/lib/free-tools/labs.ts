import { z } from "zod";

/** DataForSEO Labs response parsers shared by the free research tools. */

const organicMetricsSchema = z
  .object({
    metrics: z
      .object({
        organic: z
          .object({
            etv: z.number().nullable().optional(),
            count: z.number().nullable().optional(),
            estimated_paid_traffic_cost: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type OrganicMetrics = {
  organicTraffic: number | null;
  organicKeywords: number | null;
  trafficValue: number | null;
};

/** `domain_rank_overview` returns one item; `relevant_pages` items share the shape. */
export function readOrganicMetrics(input: unknown): OrganicMetrics {
  const organic = organicMetricsSchema.parse(input ?? {}).metrics?.organic;
  return {
    organicTraffic: organic?.etv != null ? Math.round(organic.etv) : null,
    organicKeywords: organic?.count != null ? Math.round(organic.count) : null,
    trafficValue:
      organic?.estimated_paid_traffic_cost != null
        ? Math.round(organic.estimated_paid_traffic_cost)
        : null,
  };
}

const rankedKeywordSchema = z
  .object({
    keyword_data: z
      .object({
        keyword: z.string().nullable().optional(),
        keyword_info: z
          .object({ search_volume: z.number().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
        keyword_properties: z
          .object({ keyword_difficulty: z.number().nullable().optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    ranked_serp_element: z
      .object({
        serp_item: z
          .object({
            rank_group: z.number().nullable().optional(),
            rank_absolute: z.number().nullable().optional(),
            url: z.string().nullable().optional(),
            etv: z.number().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type RankedKeywordRow = {
  keyword: string | null;
  searchVolume: number | null;
  difficulty: number | null;
  position: number | null;
  url: string | null;
};

export function readRankedKeyword(input: unknown): RankedKeywordRow {
  const item = rankedKeywordSchema.parse(input ?? {});
  const serpItem = item.ranked_serp_element?.serp_item;
  return {
    keyword: item.keyword_data?.keyword ?? null,
    searchVolume: item.keyword_data?.keyword_info?.search_volume ?? null,
    difficulty:
      item.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
    position: serpItem?.rank_group ?? serpItem?.rank_absolute ?? null,
    url: serpItem?.url ?? null,
  };
}

const relevantPageSchema = z
  .object({ page_address: z.string().nullable().optional() })
  .passthrough();

export type RelevantPageRow = {
  url: string | null;
  traffic: number | null;
  keywords: number | null;
};

export function readRelevantPage(input: unknown): RelevantPageRow {
  const metrics = readOrganicMetrics(input);
  return {
    url: relevantPageSchema.parse(input ?? {}).page_address ?? null,
    traffic: metrics.organicTraffic,
    keywords: metrics.organicKeywords,
  };
}

/** Order ranked keywords by the traffic the ranking page earns. */
export const RANKED_KEYWORDS_ORDER = ["ranked_serp_element.serp_item.etv,desc"];
export const RELEVANT_PAGES_ORDER = ["metrics.organic.etv,desc"];

const keywordIdeaSchema = z.object({
  keyword: z.string(),
  keyword_info: z
    .object({ search_volume: z.number().nullable().optional() })
    .nullable()
    .optional(),
  keyword_properties: z
    .object({ keyword_difficulty: z.number().nullable().optional() })
    .nullable()
    .optional(),
});
export type KeywordIdea = {
  keyword: string;
  searchVolume: number | null;
  difficulty: number | null;
};
export function readKeywordIdea(input: unknown): KeywordIdea {
  const item = keywordIdeaSchema.parse(input);
  return {
    keyword: item.keyword,
    searchVolume: item.keyword_info?.search_volume ?? null,
    difficulty: item.keyword_properties?.keyword_difficulty ?? null,
  };
}
