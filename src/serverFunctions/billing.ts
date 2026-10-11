import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
} from "@/shared/billing";
import { estimateRankCheckCredits } from "@/shared/rank-tracking";
import {
  BRAND_LOOKUP_COMPETITOR_RAW_COST_USD,
  BRAND_LOOKUP_RAW_COST_USD,
} from "@/shared/brand-lookup-cost";
import { estimateRankCheckSpendSchema } from "@/types/schemas/rank-tracking";
import {
  applyCostMarkup,
  describeCostMarkup,
  resolveCostMarkup,
  setConfiguredCostMarkupOverride,
} from "@/server/billing/costMarkup";
import {
  isPlatformAdmin,
  PLATFORM_ADMIN_ENV_VAR,
} from "@/server/billing/platformAdmin";
import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

const AUTUMN_EVENTS_LIST_URL = "https://api.useautumn.com/v1/events.list";
const EVENT_PAGE_LIMIT = 1000;
// Autumn rate-limits events.list; back off on 429 before giving up.
const AUTUMN_MAX_RETRIES = 3;
const AUTUMN_RETRY_BACKOFF_MS = 250;
// Cap a server-supplied Retry-After so a bogus value can't stall the Worker.
const AUTUMN_MAX_RETRY_DELAY_MS = 5000;
const BILLING_USAGE_FEATURE_IDS = [
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
] as const;

const billingUsageRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
});

const billingUsagePropertySchema = z.json();

const autumnEventSchema = z
  .object({
    value: z.number(),
    properties: z
      .record(z.string(), billingUsagePropertySchema)
      .optional()
      .default({}),
  })
  .passthrough();

const autumnEventsListResponseSchema = z
  .object({
    list: z.array(autumnEventSchema),
    has_more: z.boolean().optional(),
    hasMore: z.boolean().optional(),
  })
  .passthrough();

export type BillingUsageEvent = {
  value: number;
  properties: Record<string, z.infer<typeof billingUsagePropertySchema>>;
};

/**
 * What an unsaved rank-check configuration would cost, priced at the live
 * multiplier.
 *
 * The UI asks this for state that has not been written yet — a depth slider
 * mid-drag, a keyword selection in a confirm dialog. The request carries the
 * shape of the check and the response carries the number, so the markup is
 * resolved here and never rendered into the browser. There is deliberately no
 * client-side fallback estimate: a figure computed from a rate the client
 * happens to hold is the defect this endpoint exists to replace.
 */
export const estimateRankCheckSpend = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(estimateRankCheckSpendSchema)
  .handler(async ({ data }) => {
    const markup = await resolveCostMarkup();
    return estimateRankCheckCredits(
      data.keywordCount,
      data.devices,
      data.serpDepth,
      data.method,
      markup,
    );
  });

/**
 * What a Brand Lookup costs the customer, priced at the live multiplier.
 *
 * The figure used to be computed in the browser from
 * `applyBillingMarkupUsd`, which made the platform's markup part of the
 * client bundle — readable from devtools on any hosted session. The raw vendor
 * prices stay in `src/shared/brand-lookup-cost.ts` because they are
 * DataForSEO's numbers, not ours; only the markup moved.
 */
export const getBrandLookupCostEstimate = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const markup = await resolveCostMarkup();
    return {
      baseUsd: applyCostMarkup(BRAND_LOOKUP_RAW_COST_USD, markup),
      competitorUsd: applyCostMarkup(
        BRAND_LOOKUP_COMPETITOR_RAW_COST_USD,
        markup,
      ),
    };
  });

/**
 * The operator billing settings, for the admin area.
 *
 * The markup is the only dial an MVP needs, so this returns it and the source
 * it came from. "Which source" is the first question when an invoice looks
 * wrong, and answering it by reading two sources in a shell is not an answer.
 *
 * Hidden behind `PLATFORM_ADMIN_USER_IDS` rather than any organization role:
 * the dial is a property of the platform, so a tenant's administrator must
 * never reach it, and an unconfigured deployment has no owner and therefore
 * no admin.
 */
export const getBillingAdminSettings = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    await requirePlatformAdmin(context.userId);

    return describeCostMarkup();
  });

export const setCostMarkupSetting = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(
    z.object({
      /** `null` clears the override, handing control back to the env binding. */
      markup: z.number().positive().finite().nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    await requirePlatformAdmin(context.userId);

    await setConfiguredCostMarkupOverride({
      markup: data.markup,
      updatedByUserId: context.userId,
    });

    return describeCostMarkup();
  });

/**
 * The one door into the operator settings.
 *
 * Throws FORBIDDEN rather than returning an empty list, because an empty
 * admin response is indistinguishable from an unconfigured deployment and
 * would let a stranger learn which mode the app is in.
 */
async function requirePlatformAdmin(userId: string): Promise<void> {
  const allowlist = await getOptionalEnvValue(PLATFORM_ADMIN_ENV_VAR);
  if (!isPlatformAdmin(userId, allowlist)) {
    throw new AppError("FORBIDDEN");
  }
}

export const getBillingUsageEvents = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(billingUsageRangeSchema)
  .handler(async ({ data, context }) => {
    if (!(await isHostedServerAuthMode())) {
      return [];
    }

    const events: BillingUsageEvent[] = [];
    let offset = 0;

    for (;;) {
      const page = await fetchAutumnEventsPage({
        customerId: context.organizationId,
        end: data.end,
        offset,
        start: data.start,
      });

      events.push(...page.list);

      if (!page.hasMore || page.list.length === 0) {
        return events;
      }

      offset += page.list.length;
    }
  });

async function fetchAutumnEventsPage(args: {
  customerId: string;
  end: number;
  offset: number;
  start: number;
}): Promise<{ list: BillingUsageEvent[]; hasMore: boolean }> {
  const secretKey = await getRequiredEnvValue("AUTUMN_SECRET_KEY");

  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(AUTUMN_EVENTS_LIST_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer_id: args.customerId,
        custom_range: {
          end: args.end,
          start: args.start,
        },
        feature_id: BILLING_USAGE_FEATURE_IDS,
        limit: EVENT_PAGE_LIMIT,
        offset: args.offset,
      }),
    });

    if (response.ok) break;

    if (response.status === 429 && attempt < AUTUMN_MAX_RETRIES) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const delayMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, AUTUMN_MAX_RETRY_DELAY_MS)
        : AUTUMN_RETRY_BACKOFF_MS * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    throw new AppError(
      response.status === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR",
      `Autumn events.list failed with status ${response.status}`,
    );
  }

  const parsed = autumnEventsListResponseSchema.parse(await response.json());

  return {
    hasMore: parsed.has_more ?? parsed.hasMore ?? false,
    list: parsed.list.map((event) => ({
      value: event.value,
      properties: event.properties,
    })),
  };
}
