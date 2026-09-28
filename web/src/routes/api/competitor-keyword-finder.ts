import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { countryLanguage } from "@/lib/free-tools/countries";
import {
  readRankedKeyword,
  RANKED_KEYWORDS_ORDER,
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
const TOOL = "competitor-keyword-finder";
const TTL = 86_400;
const requestSchema = z.object({
  target: z.string().trim().min(1).max(300),
  locationCode: z.number().int(),
  turnstileToken: z.string().max(2048).optional(),
});
export const Route = createFileRoute("/api/competitor-keyword-finder")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readToolBody(request);
        if (body instanceof Response) return body;
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success)
          return jsonResponse(
            { error: "Enter a valid domain and country" },
            400,
          );
        const language = countryLanguage(parsed.data.locationCode);
        if (!language)
          return jsonResponse({ error: "Pick a supported country" }, 400);
        const value = normalizeDomain(parsed.data.target);
        if (!value) return jsonResponse({ error: "Enter a valid domain" }, 400);
        const blocked = await guardToolRequest({
          tool: TOOL,
          request,
          turnstileToken: parsed.data.turnstileToken,
        });
        if (blocked) return blocked;
        const apiKey = dataforseoKey();
        if (!apiKey) return serviceUnavailable(TOOL);
        const key = `${value}|${parsed.data.locationCode}`;
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
            "/v3/dataforseo_labs/google/ranked_keywords/live",
            {
              item_types: ["organic"],
              target: value,
              order_by: RANKED_KEYWORDS_ORDER,
              location_code: parsed.data.locationCode,
              language_code: language,
              limit: 20,
            },
            apiKey,
          );
          const items = itemsResultSchema.parse(raw ?? {}).items ?? [];
          const result = {
            target: value,
            locationCode: parsed.data.locationCode,
            keywords: items.map(readRankedKeyword),
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
