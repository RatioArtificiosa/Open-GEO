import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { countryLanguage } from "@/lib/free-tools/countries";
import {
  RANKED_KEYWORDS_ORDER,
  readOrganicMetrics,
  readRankedKeyword,
  readRelevantPage,
  RELEVANT_PAGES_ORDER,
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

const TOOL = freeTools["website-traffic-checker"];
const CACHE_TTL_SECONDS = 86_400;
const ROW_LIMIT = 5;

const requestSchema = z.object({
  target: z.string().trim().min(1, "Enter a domain").max(300),
  compare: z.string().trim().max(300).optional(),
  locationCode: z.number().int(),
  turnstileToken: z.string().max(4096).optional(),
});

type DomainTraffic = {
  domain: string;
  organicTraffic: number | null;
  organicKeywords: number | null;
  trafficValue: number | null;
  topKeywords: RankedKeywordRow[];
  topPages: RelevantPageRow[];
  totalPages: number | null;
};

export const Route = createFileRoute("/api/website-traffic-checker")({
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

        const target = normalizeDomain(parsed.data.target);
        if (!target) {
          return jsonResponse(
            { error: "Enter a valid domain, like example.com" },
            400,
          );
        }

        const compareInput = parsed.data.compare?.trim();
        const compare = compareInput ? normalizeDomain(compareInput) : null;
        if (compareInput && !compare) {
          return jsonResponse(
            { error: "Enter a valid domain to compare, like example.com" },
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

        const domains =
          compare && compare !== target ? [target, compare] : [target];
        const cacheKeys = domains.map(
          (domain) => `organic-v2|${domain}|${parsed.data.locationCode}`,
        );
        const cachedEntries = await Promise.all(
          cacheKeys.map((key) => readCached<DomainTraffic>(TOOL.slug, key)),
        );

        const failed = cachedEntries.find((entry) => entry && !entry.ok);
        if (failed && !failed.ok) return failureResponse(failed.error);

        const misses = domains.filter((_, index) => !cachedEntries[index]);
        // Three calls per domain (overview + keywords + pages); only
        // uncached domains are charged, so compare mode can cost 3 or 6.
        const overBudget = await chargeToolBudget({
          tool: TOOL.slug,
          request,
          calls: misses.length * 3,
        });
        if (overBudget) return overBudget;

        try {
          const fetched = new Map<string, DomainTraffic>();
          await Promise.all(
            misses.map(async (domain) => {
              const snapshot = await fetchDomainTraffic(
                domain,
                parsed.data.locationCode,
                language,
                apiKey,
              );
              fetched.set(domain, snapshot);
              await writeCached(
                TOOL.slug,
                `organic-v2|${domain}|${parsed.data.locationCode}`,
                { ok: true, data: snapshot },
                CACHE_TTL_SECONDS,
              );
            }),
          );

          const results = domains.map((domain, index) => {
            const entry = cachedEntries[index];
            return entry?.ok ? entry.data : fetched.get(domain)!;
          });

          return cacheableJson(
            {
              locationCode: parsed.data.locationCode,
              primary: results[0],
              comparison: results[1] ?? null,
            },
            CACHE_TTL_SECONDS,
          );
        } catch (err) {
          console.error("Website traffic check error:", err);
          const message = "Traffic check failed. Please try again.";
          await Promise.all(
            misses.map((domain) =>
              writeCached(
                TOOL.slug,
                `organic-v2|${domain}|${parsed.data.locationCode}`,
                { ok: false, error: message },
                120,
              ),
            ),
          );
          return failureResponse(message);
        }
      },
    },
  },
});

async function fetchDomainTraffic(
  domain: string,
  locationCode: number,
  languageCode: string,
  apiKey: string,
): Promise<DomainTraffic> {
  const base = {
    target: domain,
    location_code: locationCode,
    language_code: languageCode,
  };

  const [overviewRaw, keywordsRaw, pagesRaw] = await Promise.all([
    fetchDataforseoResult(
      "/v3/dataforseo_labs/google/domain_rank_overview/live",
      { ...base, limit: 1 },
      apiKey,
    ),
    fetchDataforseoResult(
      "/v3/dataforseo_labs/google/ranked_keywords/live",
      {
        item_types: ["organic"],
        ...base,
        limit: ROW_LIMIT,
        order_by: RANKED_KEYWORDS_ORDER,
      },
      apiKey,
    ),
    fetchDataforseoResult(
      "/v3/dataforseo_labs/google/relevant_pages/live",
      { ...base, limit: ROW_LIMIT, order_by: RELEVANT_PAGES_ORDER },
      apiKey,
    ),
  ]);

  const overviewItems = itemsResultSchema.parse(overviewRaw ?? {}).items ?? [];
  const pages = itemsResultSchema.parse(pagesRaw ?? {});

  return {
    domain,
    ...readOrganicMetrics(overviewItems[0] ?? {}),
    topKeywords: (itemsResultSchema.parse(keywordsRaw ?? {}).items ?? []).map(
      readRankedKeyword,
    ),
    topPages: (pages.items ?? []).map(readRelevantPage),
    totalPages: pages.total_count ?? null,
  };
}
