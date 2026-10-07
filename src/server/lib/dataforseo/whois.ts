import { z } from "zod";

import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * WHOIS overview — domain intelligence, under `domain_analytics` rather than `backlinks`.
 *
 * **Probed, not assumed:** `/v3/domain_analytics/whois/overview/live` answers 20000, while
 * `backlinks/whois/overview/live` and the `/live`-less form both 404. The row this client serves had
 * the family wrong, and one free sandbox call settled it before any code existed.
 *
 * **There is no `domain` parameter.** `filters` is the interface, which is unusual enough to be worth
 * stating at the top of the file: a caller looking for `{ domain }` will not find it, and adding one
 * would be inventing an API.
 *
 * **The default sort is a hazard, so it is made explicit here.** The vendor orders by
 * `metrics.organic.count` descending, which means an *unfiltered* call returns the largest domains on
 * the internet — useful for nobody and billed the same. The filter is therefore effectively required,
 * and this module asks for one rather than letting an empty call succeed quietly.
 */

const WHOIS_PATH = "/v3/domain_analytics/whois/overview/live";

/**
 * The vendor's default, written down so a caller can see what they are not choosing.
 * `metrics.organic.count` descending — the largest domains first.
 */
export const WHOIS_DEFAULT_ORDER_BY = [
  "metrics.organic.count",
  "desc",
] as const;

/** A filter triple: `[field, operator, value]`, as DataForSEO's own filter grammar spells it. */
const whoisFilterSchema = z.tuple([
  z.string(),
  z.string(),
  z.union([z.string(), z.number()]),
]);

const whoisMetricsSchema = z
  .object({
    organic: z
      .object({
        count: z.number().nullish(),
        etv: z.number().nullish(),
      })
      .nullish(),
    paid: z.object({ count: z.number().nullish() }).nullish(),
  })
  .nullish();

/**
 * One WHOIS row. Two fields carry meaning that a bare type cannot:
 *
 * - **`registered: false` means expired, not absent.** The domain exists and was once registered;
 *   rendering it as "no data" throws away the signal.
 * - **`registrar: null` means unknown**, which is different from a registrar name that is empty for
 *   another reason. Null is the honest value and is left as null.
 */
const whoisOverviewRowSchema = z.object({
  domain: z.string(),
  registered: z.boolean().nullish(),
  registrar: z.string().nullish(),
  created: z.string().nullish(),
  expired: z.string().nullish(),
  updated: z.string().nullish(),
  metrics: whoisMetricsSchema,
  backlinks_info: z.record(z.string(), z.unknown()).nullish(),
});

type WhoisOverviewRow = z.infer<typeof whoisOverviewRowSchema>;

type WhoisOverviewQuery = {
  filters?: Array<[string, string, string | number]>;
  limit?: number;
  /** Overrides {@link WHOIS_DEFAULT_ORDER_BY}. Stated rather than defaulted, on purpose. */
  orderBy?: Array<[string, "asc" | "desc"]>;
};

/**
 * Read WHOIS rows. **A filter is required**, because the vendor's default sort means an unfiltered
 * call returns the largest domains on the internet — an expensive way to learn nothing.
 *
 * `offset_token` is deliberately not accepted here. The vendor requires it to be sent with identical
 * parameters, and this module cannot verify that a caller has done so; the labs clients resolve the
 * same conflict by refusing the combination outright.
 */
export async function fetchWhoisOverview(
  query: WhoisOverviewQuery,
): Promise<DataforseoApiResponse<WhoisOverviewRow[]>> {
  const filters = query.filters ?? [];
  if (filters.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "fetchWhoisOverview needs at least one filter: the vendor's default sort returns the " +
        "internet's largest domains, so an unfiltered call is billed and useless",
    );
  }

  const parsedFilters = z.array(whoisFilterSchema).safeParse(filters);
  if (!parsedFilters.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      "fetchWhoisOverview expects filters as [field, operator, value] triples",
    );
  }

  const body = {
    filters: parsedFilters.data,
    limit: query.limit ?? 10,
    order_by: query.orderBy ?? WHOIS_DEFAULT_ORDER_BY,
  };

  const response = await dataforseoPost(WHOIS_PATH, [body]);
  const task = assertOk(response);

  const items = z
    .array(whoisOverviewRowSchema)
    .safeParse(
      z.record(z.string(), z.unknown()).safeParse(task.result?.[0] ?? {}).data
        ?.items ?? [],
    );
  if (!items.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO whois/overview returned an invalid shape",
    );
  }

  return { data: items.data, billing: buildTaskBilling(task) };
}
