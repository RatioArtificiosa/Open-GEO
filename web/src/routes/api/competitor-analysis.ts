import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { countryLanguage } from "@/lib/free-tools/countries";
import {
  RANKED_KEYWORDS_ORDER,
  readOrganicMetrics,
  readRankedKeyword,
  readRelevantPage,
  RELEVANT_PAGES_ORDER,
  type OrganicMetrics,
  type RankedKeywordRow,
  type RelevantPageRow,
} from "@/lib/free-tools/labs";
import {
  cacheableJson,
  chargeToolBudget,
  dataforseoKey,
  failureResponse,
  fetchDataforseoResult,
  guardToolRequest,
  itemsResultSchema,
  jsonResponse,
  readToolBody,
  normalizeDomain,
  readCached,
  serviceUnavailable,
  writeCached,
} from "@/lib/free-tools/server";
import { freeTools } from "@/lib/free-tools/tool-pages";

const TOOL = freeTools["competitor-analysis"];
const CACHE_TTL_SECONDS = 86_400;
const KEYWORD_LIMIT = 20;
const PAGE_LIMIT = 10;
const GAP_LIMIT = 20;

const requestSchema = z.object({
  competitor: z.string().trim().min(1, "Enter a competitor domain").max(300),
  yourDomain: z.string().trim().max(300).optional(),
  locationCode: z.number().int(),
  turnstileToken: z.string().max(4096).optional(),
});

const intersectionItemSchema = z
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
    first_domain_serp_element: z
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
  .passthrough();

type GapRow = RankedKeywordRow & { traffic: number | null };

type CompetitorAnalysis = {
  competitor: string;
  yourDomain: string | null;
  locationCode: number;
  keywords: RankedKeywordRow[];
  totalKeywords: number | null;
  pages: RelevantPageRow[];
  totalPages: number | null;
  comparison: {
    competitor: OrganicMetrics;
    you: OrganicMetrics;
  } | null;
  /**
   * null when no domain was given OR when the gap lookup failed (see
   * `gapFailed`); an empty array means the lookup worked and found nothing.
   */
  gap: GapRow[] | null;
  gapFailed: boolean;
};

export const Route = createFileRoute("/api/competitor-analysis")({
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

        const language = countryLanguage(parsed.data.locationCode);
        if (!language) {
          return jsonResponse({ error: "Pick a supported country" }, 400);
        }

        const competitor = normalizeDomain(parsed.data.competitor);
        if (!competitor) {
          return jsonResponse(
            { error: "Enter a valid competitor domain, like example.com" },
            400,
          );
        }

        const yourInput = parsed.data.yourDomain?.trim();
        const yourDomain = yourInput ? normalizeDomain(yourInput) : null;
        if (yourInput && !yourDomain) {
          return jsonResponse(
            { error: "Enter a valid domain of your own, like example.com" },
            400,
          );
        }
        if (yourDomain && yourDomain === competitor) {
          return jsonResponse(
            { error: "Enter two different domains to compare" },
            400,
          );
        }

        const apiKey = dataforseoKey();
        if (!apiKey) return serviceUnavailable(TOOL.slug);

        const blocked = await guardToolRequest({
          tool: TOOL.slug,
          request,
          turnstileToken: parsed.data.turnstileToken,
        });
        if (blocked) return blocked;

        const cacheKey = `organic-v2|${competitor}|${yourDomain ?? "-"}|${parsed.data.locationCode}`;
        const cached = await readCached<CompetitorAnalysis>(
          TOOL.slug,
          cacheKey,
        );
        if (cached) {
          return cached.ok
            ? cacheableJson(cached.data, CACHE_TTL_SECONDS)
            : failureResponse(cached.error);
        }

        // ranked_keywords + relevant_pages, plus two domain_rank_overview
        // calls and one domain_intersection when your own domain is given.
        const overBudget = await chargeToolBudget({
          tool: TOOL.slug,
          request,
          calls: yourDomain ? 5 : 2,
        });
        if (overBudget) return overBudget;

        const base = {
          location_code: parsed.data.locationCode,
          language_code: language,
        };

        try {
          const [keywordsRaw, pagesRaw] = await Promise.all([
            fetchDataforseoResult(
              "/v3/dataforseo_labs/google/ranked_keywords/live",
              {
                item_types: ["organic"],
                ...base,
                target: competitor,
                limit: KEYWORD_LIMIT,
                order_by: RANKED_KEYWORDS_ORDER,
              },
              apiKey,
            ),
            fetchDataforseoResult(
              "/v3/dataforseo_labs/google/relevant_pages/live",
              {
                ...base,
                target: competitor,
                limit: PAGE_LIMIT,
                order_by: RELEVANT_PAGES_ORDER,
              },
              apiKey,
            ),
          ]);

          const keywords = itemsResultSchema.parse(keywordsRaw ?? {});
          const pages = itemsResultSchema.parse(pagesRaw ?? {});

          const result: CompetitorAnalysis = {
            competitor,
            yourDomain,
            locationCode: parsed.data.locationCode,
            keywords: (keywords.items ?? []).map(readRankedKeyword),
            totalKeywords: keywords.total_count ?? null,
            pages: (pages.items ?? []).map(readRelevantPage),
            totalPages: pages.total_count ?? null,
            comparison: null,
            gap: null,
            gapFailed: false,
          };

          if (yourDomain) {
            const [theirs, yours] = await Promise.all([
              fetchDataforseoResult(
                "/v3/dataforseo_labs/google/domain_rank_overview/live",
                { ...base, target: competitor, limit: 1 },
                apiKey,
              ),
              fetchDataforseoResult(
                "/v3/dataforseo_labs/google/domain_rank_overview/live",
                { ...base, target: yourDomain, limit: 1 },
                apiKey,
              ),
            ]);
            result.comparison = {
              competitor: readOrganicMetrics(
                (itemsResultSchema.parse(theirs ?? {}).items ?? [])[0] ?? {},
              ),
              you: readOrganicMetrics(
                (itemsResultSchema.parse(yours ?? {}).items ?? [])[0] ?? {},
              ),
            };
            result.gap = await fetchKeywordGap(
              competitor,
              yourDomain,
              base,
              apiKey,
            );
            result.gapFailed = result.gap === null;
          }

          // A failed gap lookup isn't worth a day of caching — keep it short so
          // a retry can fill it in, without inviting an immediate retry loop.
          const ttl = result.gapFailed ? 120 : CACHE_TTL_SECONDS;
          await writeCached(
            TOOL.slug,
            cacheKey,
            { ok: true, data: result },
            ttl,
          );
          return cacheableJson(result, ttl);
        } catch (err) {
          console.error("Competitor analysis error:", err);
          const message = "Competitor analysis failed. Please try again.";
          await writeCached(
            TOOL.slug,
            cacheKey,
            { ok: false, error: message },
            120,
          );
          return failureResponse(message);
        }
      },
    },
  },
});

/**
 * Keywords the competitor ranks for and you don't: `intersections: false`
 * makes domain_intersection return target1-only keywords. Its own try/catch —
 * the gap table is the one optional part of the report, so a failure here
 * shouldn't throw away the keyword and page lists we already paid for.
 *
 * Returns null when the lookup failed and [] when it genuinely found nothing,
 * so the page can tell the visitor which happened.
 */
async function fetchKeywordGap(
  competitor: string,
  yourDomain: string,
  base: { location_code: number; language_code: string },
  apiKey: string,
): Promise<GapRow[] | null> {
  try {
    const raw = await fetchDataforseoResult(
      "/v3/dataforseo_labs/google/domain_intersection/live",
      {
        ...base,
        target1: competitor,
        target2: yourDomain,
        intersections: false,
        item_types: ["organic"],
        limit: GAP_LIMIT,
      },
      apiKey,
    );

    return (
      (itemsResultSchema.parse(raw ?? {}).items ?? [])
        .map((item) => intersectionItemSchema.parse(item))
        .map((item) => {
          const serpElement = item.first_domain_serp_element;
          return {
            keyword: item.keyword_data?.keyword ?? null,
            searchVolume:
              item.keyword_data?.keyword_info?.search_volume ?? null,
            difficulty:
              item.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
            position:
              serpElement?.rank_group ?? serpElement?.rank_absolute ?? null,
            url: serpElement?.url ?? null,
            traffic:
              serpElement?.etv != null ? Math.round(serpElement.etv) : null,
          };
        })
        // Ordered here rather than through order_by so the sort can't depend on
        // an undocumented field path.
        .sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0))
    );
  } catch (err) {
    console.error("Competitor keyword gap error:", err);
    return null;
  }
}
