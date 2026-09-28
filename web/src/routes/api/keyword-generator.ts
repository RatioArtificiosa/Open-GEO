import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { countryLanguage } from "@/lib/free-tools/countries";
import { readKeywordIdea } from "@/lib/free-tools/labs";
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
  readCached,
  serviceUnavailable,
  writeCached,
} from "@/lib/free-tools/server";
const TOOL = "keyword-generator";
const TTL = 86_400;
const requestSchema = z.object({
  keyword: z.string().trim().min(1).max(100),
  locationCode: z.number().int(),
  turnstileToken: z.string().max(2048).optional(),
});
export const Route = createFileRoute("/api/keyword-generator")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readToolBody(request);
        if (body instanceof Response) return body;
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success)
          return jsonResponse(
            { error: "Enter a valid topic and country" },
            400,
          );
        const language = countryLanguage(parsed.data.locationCode);
        if (!language)
          return jsonResponse({ error: "Pick a supported country" }, 400);
        const value = parsed.data.keyword.toLowerCase().replace(/\s+/g, " ");
        const blocked = await guardToolRequest({
          tool: TOOL,
          request,
          turnstileToken: parsed.data.turnstileToken,
        });
        if (blocked) return blocked;
        const apiKey = dataforseoKey();
        if (!apiKey) return serviceUnavailable(TOOL);
        const key = `core-v2|${value}|${parsed.data.locationCode}`;
        const cached = await readCached(TOOL, key);
        if (cached)
          return cached.ok
            ? cacheableJson(cached.data, TTL)
            : failureResponse(cached.error);
        const overBudget = await chargeToolBudget({
          tool: TOOL,
          request,
          calls: 1,
        });
        if (overBudget) return overBudget;
        try {
          const raw = await fetchDataforseoResult(
            "/v3/dataforseo_labs/google/keyword_suggestions/live",
            {
              keyword: value,
              include_seed_keyword: false,
              include_serp_info: false,
              include_clickstream_data: false,
              exact_match: false,
              ignore_synonyms: true,
              location_code: parsed.data.locationCode,
              language_code: language,
              limit: 20,
            },
            apiKey,
          );
          const items = itemsResultSchema.parse(raw ?? {}).items ?? [];
          const result = {
            keyword: value,
            locationCode: parsed.data.locationCode,
            keywords: items.map(readKeywordIdea),
          };
          await writeCached(TOOL, key, { ok: true, data: result }, TTL);
          return cacheableJson(result, TTL);
        } catch (error) {
          console.error(`${TOOL} lookup failed:`, error);
          const message = "We couldn't load keywords. Please try again.";
          await writeCached(TOOL, key, { ok: false, error: message }, 120);
          return failureResponse(message);
        }
      },
    },
  },
});
