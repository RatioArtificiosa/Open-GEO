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

const TOOL = freeTools["spam-score-checker"];
const CACHE_TTL_SECONDS = 86_400;
const WORST_BACKLINKS_LIMIT = 10;

const requestSchema = z.object({
  target: z.string().trim().min(1, "Enter a domain").max(300),
  turnstileToken: z.string().max(4096).optional(),
});

const summarySchema = z
  .object({
    rank: z.number().nullable().optional(),
    backlinks: z.number().nullable().optional(),
    referring_domains: z.number().nullable().optional(),
    backlinks_spam_score: z.number().nullable().optional(),
    info: z
      .object({ target_spam_score: z.number().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const backlinksSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            type: z.string().nullable().optional(),
            domain_from: z.string().nullable().optional(),
            url_from: z.string().nullable().optional(),
            anchor: z.string().nullable().optional(),
            dofollow: z.boolean().nullable().optional(),
            domain_from_rank: z.number().nullable().optional(),
            backlink_spam_score: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

type SpamCheck = {
  target: string;
  spamScore: number | null;
  targetSpamScore: number | null;
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  worstBacklinks: Array<{
    domainFrom: string | null;
    urlFrom: string | null;
    anchor: string | null;
    dofollow: boolean | null;
    domainRank: number | null;
    spamScore: number | null;
  }>;
};

export const Route = createFileRoute("/api/spam-score-checker")({
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

        const cached = await readCached<SpamCheck>(TOOL.slug, domain);
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
                limit: WORST_BACKLINKS_LIMIT,
                mode: "one_per_domain",
                order_by: ["backlink_spam_score,desc"],
              },
              apiKey,
            ),
          ]);

          const summary = summarySchema.parse(summaryRaw ?? {});
          const backlinks = backlinksSchema.parse(backlinksRaw ?? {});

          const result: SpamCheck = {
            target: domain,
            spamScore: summary.backlinks_spam_score ?? null,
            targetSpamScore: summary.info?.target_spam_score ?? null,
            rank: summary.rank ?? null,
            backlinks: summary.backlinks ?? null,
            referringDomains: summary.referring_domains ?? null,
            worstBacklinks: (backlinks.items ?? [])
              .filter((item) => item.type === "backlink" && item.url_from)
              .map((item) => ({
                domainFrom: item.domain_from ?? null,
                urlFrom: item.url_from ?? null,
                anchor: item.anchor?.trim() ? item.anchor : null,
                dofollow: item.dofollow ?? null,
                domainRank: item.domain_from_rank ?? null,
                spamScore: item.backlink_spam_score ?? null,
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
          console.error("Spam score check error:", err);
          const message = "Spam score check failed. Please try again.";
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
