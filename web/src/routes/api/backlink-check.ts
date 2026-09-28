import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  cacheableJson,
  chargeToolBudget,
  dataforseoKey,
  failureResponse,
  fetchDataforseoResult,
  guardToolRequest,
  jsonResponse,
  readToolBody,
  normalizeDomain,
  readCached,
  serviceUnavailable,
  writeCached,
} from "@/lib/free-tools/server";
import { freeTools } from "@/lib/free-tools/tool-pages";

const TOOL = freeTools["backlink-checker"];
const TOP_BACKLINKS_LIMIT = 15;
const CACHE_TTL_SECONDS = 86_400;

const requestSchema = z.object({
  target: z.string().trim().min(1, "Enter a domain").max(300),
  turnstileToken: z.string().max(4096).optional(),
});

const summaryResultSchema = z
  .object({
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    broken_backlinks: z.number().nullable().optional(),
  })
  .passthrough();

const backlinksResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            type: z.string().nullable().optional(),
            domain_from: z.string().nullable().optional(),
            url_from: z.string().nullable().optional(),
            url_to: z.string().nullable().optional(),
            anchor: z.string().nullable().optional(),
            dofollow: z.boolean().nullable().optional(),
            domain_from_rank: z.number().nullable().optional(),
            page_from_title: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

type BacklinkCheck = {
  target: string;
  summary: {
    rank: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    brokenBacklinks: number | null;
  };
  topBacklinks: Array<{
    domainFrom: string | null;
    urlFrom: string | null;
    urlTo: string | null;
    pageTitle: string | null;
    anchor: string | null;
    dofollow: boolean | null;
    domainRank: number | null;
  }>;
};

export const Route = createFileRoute("/api/backlink-check")({
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

        const domain = normalizeDomain(parsed.data.target);
        if (!domain) {
          return jsonResponse(
            { error: "Enter a valid domain, like example.com" },
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

        const cached = await readCached<BacklinkCheck>(TOOL.slug, domain);
        if (cached) {
          return cached.ok
            ? cacheableJson(cached.data, CACHE_TTL_SECONDS)
            : failureResponse(cached.error);
        }

        // summary/live + backlinks/live
        const overBudget = await chargeToolBudget({
          tool: TOOL.slug,
          request,
          calls: 2,
        });
        if (overBudget) return overBudget;

        // Mirrors the app's backlinks defaults (src/server/lib/dataforseo/backlinks.ts).
        const commonPayload = {
          target: domain,
          include_subdomains: true,
          include_indirect_links: true,
          exclude_internal_backlinks: true,
          backlinks_status_type: "live",
          rank_scale: "one_hundred",
        };

        try {
          const [summaryRaw, backlinksRaw] = await Promise.all([
            fetchDataforseoResult(
              "/v3/backlinks/summary/live",
              commonPayload,
              apiKey,
            ),
            fetchDataforseoResult(
              "/v3/backlinks/backlinks/live",
              {
                ...commonPayload,
                limit: TOP_BACKLINKS_LIMIT,
                mode: "one_per_domain",
                // Strongest linking domains first, like Ahrefs' free checker.
                order_by: ["domain_from_rank,desc"],
              },
              apiKey,
            ),
          ]);

          const summary = summaryResultSchema.parse(summaryRaw ?? {});
          const backlinks = backlinksResultSchema.parse(backlinksRaw ?? {});

          const result: BacklinkCheck = {
            target: domain,
            summary: {
              rank: summary.rank ?? null,
              backlinks: summary.backlinks ?? null,
              referringDomains: summary.referring_domains ?? null,
              brokenBacklinks: summary.broken_backlinks ?? null,
            },
            topBacklinks: (backlinks.items ?? [])
              .filter((item) => item.type === "backlink" && item.url_from)
              .map((item) => ({
                domainFrom: item.domain_from ?? null,
                urlFrom: item.url_from ?? null,
                urlTo: item.url_to ?? null,
                pageTitle: item.page_from_title?.trim()
                  ? item.page_from_title
                  : null,
                anchor: item.anchor?.trim() ? item.anchor : null,
                dofollow: item.dofollow ?? null,
                domainRank: item.domain_from_rank ?? null,
              })),
          };

          await writeCached(
            TOOL.slug,
            domain,
            { ok: true, data: result },
            CACHE_TTL_SECONDS,
          );
          return cacheableJson(result, CACHE_TTL_SECONDS);
        } catch (err) {
          console.error("Backlink check error:", err);
          // Negative cache: money was already spent, so stop an immediate
          // retry loop on a reliably-failing domain.
          const message = "Backlink check failed. Please try again.";
          await writeCached(
            TOOL.slug,
            domain,
            { ok: false, error: message },
            120,
          );
          return failureResponse(message);
        }
      },
    },
  },
});
