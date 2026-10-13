/**
 * The category's domain comparison, the most expensive endpoint this product calls.
 *
 * ## Why it moved out of `market-tools.ts`
 *
 * That file held three tools and has a shared line budget every one of them pays
 * into. This is the one whose price is worth a header of its own — $0.12 per request
 * plus $0.0012 per domain, the highest in the product — and the one whose handler
 * carries the ETV-era explanation in its text, because a window straddling
 * 2026-11-01 compares two formulas and must say so rather than read as growth.
 *
 * ## What the money depends on
 *
 * Two dates and a set of category codes. Every date rule is checked before the
 * request: the same month twice, a date before 2020-10-01, and a future date are
 * all **billed** rejections at the vendor — a charge for nothing. Local refusal is
 * cheaper, which is why the schema is strict.
 */
import { z } from "zod";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { describeMetricsMovement } from "@/server/features/market-analysis/metric-movement";
import { DFS_LABS } from "@/shared/dataforseo-pricing";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { resolveLabsMarketSelector } from "@/server/lib/market";
import {
  creditsFor,
  dryRunInputSchema,
  dryRunResponse,
  wantsToSpend,
} from "@/server/mcp/dry-run";

/**
 * failed by the tool, so the price is in the description, in the schema, and in the response as
 * the request-fee floor. The distinct per-domain part is stated rather than estimated, because the
 * number of domains returned is not knowable before the call.
 *
 * ## Movement is computed from the two months, not from the vendor's difference block
 *
 * The reference's own description of that block does not pin its sign, and its sample contradicts
 * itself — see `metric-movement.ts`. Direction therefore comes from `metrics_history`, the two
 * months the caller asked about, which are unambiguous.
 *
 * ## Every date rule is checked before the request
 *
 * The same month twice, a date before 2020-10-01, or a future date are all **billed** rejections
 * at the vendor. They are refused locally instead, which is why the schema is strict and the
 * client's guard names the rule it broke.
 */
const domainMetricsInputSchema = {
  projectId: projectIdSchema,
  categoryCodes: z
    .array(z.number().int())
    .min(1)
    .max(5)
    .describe(
      "Criterion IDs to compare, from get_domain_categories. This endpoint takes at most 5, not the 20 its sibling allows.",
    ),
  firstDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "First month to compare, as yyyy-mm-dd. The month is what matters; the day is ignored by the vendor. Must be 2020-10-01 or later, and on a different month from secondDate.",
    ),
  secondDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      "Second month to compare, as yyyy-mm-dd. It may be earlier than firstDate; the pair is treated as two points, not a range.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum domains to return, fewest-traffic last. Defaults to 25. The per-domain part of the price scales with what comes back.",
    ),
  topCategoriesCount: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Also collect domains from this many top categories beyond those requested. Cannot be less than the number of categoryCodes.",
    ),
  includeSubdomains: z
    .boolean()
    .optional()
    .describe(
      "Include subdomains alongside the main domain. The vendor defaults to true; set false for main domains only.",
    ),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe(
      "Country-level DataForSEO Labs location code. Defaults to the project's market.",
    ),
  languageCode: z
    .string()
    .optional()
    .describe(
      "Language code for the location. Defaults to the location's own.",
    ),
  ...dryRunInputSchema,
} as const;

type DomainMetricsArgs = z.infer<z.ZodObject<typeof domainMetricsInputSchema>>;

export const getCategoryDomainMetricsTool = {
  name: "get_category_domain_metrics",
  config: {
    title: "Compare domains in categories over two months",
    description:
      "Returns the domains ranking in the given product categories with their estimated traffic at two points in time, and whether each grew or fell between them. Use it to see who owns a category's demand and whether that is shifting. This is the most expensive endpoint this product calls: about $0.12 per request plus $0.0012 per domain returned. Both dates are required, must be different months, and must be 2020-10-01 or later.",
    inputSchema: domainMetricsInputSchema,
    outputSchema: z
      .object({
        categoryCodes: z.array(z.number()),
        fromMonth: z.string().nullable(),
        toMonth: z.string().nullable(),
        /** The request fee, which is charged whatever comes back. The per-domain part is separate. */
        requestCostUsd: z.number(),
        perDomainCostUsd: z.number(),
        domains: z.array(
          z.looseObject({
            domain: z.string().nullable(),
            organicEtv: z.number().nullable(),
            etvChange: z.number().nullable(),
            /**
             * Whether the window straddles 2026-11-01, the ETV formula switch.
             *
             * In the schema as a **required** boolean rather than an optional one: a
             * consumer has to be able to see "this change is a formula artifact"
             * without having to reason about an absent field, and omitting it means
             * a caller reads a number they cannot interpret.
             */
            spansCutover: z.boolean(),
            /**
             * Null when the window straddles the cutover as well as when a month is
             * missing -- two formulas apart there is no direction to report.
             */
            growing: z.boolean().nullable(),
          }),
        ),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: DomainMetricsArgs, context) => {
    const market = resolveLabsMarketSelector(args, context.project);
    const limit = args.limit ?? 25;

    if (!wantsToSpend(args.dry_run)) {
      return dryRunResponse({
        subject: "this call",
        estimatedCredits: creditsFor(
          DFS_LABS.heavyHistorical.perRequest +
            DFS_LABS.heavyHistorical.perUnit * limit,
        ),
        unitSentence:
          "USD " +
          DFS_LABS.heavyHistorical.perRequest +
          " per request plus USD " +
          DFS_LABS.heavyHistorical.perUnit +
          " per domain, DataForSEO Labs",
        meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
        structured: {},
      });
    }
    const client = createDataforseoClient(context.billing);

    const items = await client.domain.domainMetricsByCategories({
      categoryCodes: args.categoryCodes,
      locationCode: market.locationCode,
      languageCode: market.languageCode,
      firstDate: args.firstDate,
      secondDate: args.secondDate,
      topCategoriesCount: args.topCategoriesCount,
      includeSubdomains: args.includeSubdomains,
      limit,
    });

    const domains = items.map((item) => {
      const movement = describeMetricsMovement(item.metrics_history);
      return {
        domain: item.domain ?? null,
        organicEtv: item.organic_etv ?? null,
        etvChange: movement?.etvChange ?? null,
        spansCutover: movement?.spansCutover ?? false,
        growing: movement?.growing ?? null,
        fromMonth: movement?.fromMonth ?? null,
        toMonth: movement?.toMonth ?? null,
      };
    });

    const requestCostUsd = DFS_LABS.heavyHistorical.perRequest;
    const perDomainCostUsd = DFS_LABS.heavyHistorical.perUnit;
    const straddling = domains.filter((domain) => domain.spansCutover).length;
    const grew = domains.filter((domain) => domain.growing === true).length;
    const measurable = domains.filter(
      (domain) => domain.growing !== null,
    ).length;
    // **"Lacking a reading" means a month with no ETV, not "no direction".**
    //
    // The first version counted `domains.length - measurable`, and since a straddling
    // window also has `growing: null` (two formulas apart there is no direction to
    // report), a domain with *both* months on record was described as lacking one. It
    // has both — it just straddles the boundary. The two counts are different claims
    // and conflating them made the tool contradict its own next clause.
    const missingReading = domains.filter(
      (domain) => domain.etvChange === null,
    ).length;

    return mcpResponse({
      // **A straddling window is named, not folded into the growth count.**
      //
      // Two months either side of 2026-11-01 are two ETV formulas, so `etvChange` there is
      // the difference between the formulas rather than between the traffic. Counting those
      // domains as "grew" would put a vendor model change into the customer's growth numbers,
      // which is the one thing this product's whole ETV-versioning rule exists to prevent —
      // and the tool's text is where a reader would find out.
      text: `${domains.length} domain${domains.length === 1 ? "" : "s"} in these categories, about $${requestCostUsd.toFixed(2)} + $${perDomainCostUsd.toFixed(4)} each. ${grew} of the ${measurable} with both months on record grew between them${missingReading > 0 ? `; ${missingReading} lack a reading for one of the months and are reported without a direction` : ""}${straddling > 0 ? `; ${straddling} of these windows straddle 2026-11-01, the day the vendor changed the ETV formula, so their etvChange compares two formulas and carries no direction — do not read it as traffic growth` : ""}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/market`,
      ),
      structuredContent: {
        categoryCodes: args.categoryCodes,
        fromMonth: domains[0]?.fromMonth ?? null,
        toMonth: domains[0]?.toMonth ?? null,
        requestCostUsd,
        perDomainCostUsd,
        domains,
      },
    });
  }),
};
