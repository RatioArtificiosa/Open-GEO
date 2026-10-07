import { z } from "zod";

import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

/**
 * Domain technologies — the tech-slicing lead list's foundation.
 *
 * **Probed, not assumed.** `technologies/technologies/live` and the `/live`-less form both 404,
 * while `technologies_domain/live` answers a structured `40402 "Invalid Path."` — the vendor's own
 * wrong-path error, which is how a family that exists but is misaddressed looks. This exact path
 * answers `20000`.
 *
 * **`target` is a plain string here.** `llm_mentions/search_mentions` in the same API family wants
 * an array of `{domain}` or `{keyword}` objects. Two endpoints, same idea, different spelling —
 * generalising from one to the other is how a fabricated route got written earlier in this project.
 *
 * **The response carries contacts.** `emails`, `phone_numbers` and `social_graph_urls` arrive with
 * the technology stack, so a filter like "runs Shopify but not Klaviyo" yields prospects with a way
 * to reach them, in the same call that identifies them. That is the audit-to-outreach step, and it
 * is why this client exposes a slicer rather than only a fetcher.
 */

const TECHNOLOGIES_PATH =
  "/v3/domain_analytics/technologies/domain_technologies/live";

function firstResult(task: DataforseoTaskLike): Record<string, unknown> | null {
  const first = task.result?.[0];
  return isRecord(first) ? first : null;
}

/** A technology entry: the vendor nests a name under a category key. */
const technologySchema = z.object({
  name: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
});

export const domainTechnologiesRowSchema = z.object({
  domain: z.string(),
  domain_rank: z.number().nullish(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  country_iso_code: z.string().nullish(),
  technologies: z.record(z.string(), z.array(technologySchema)).nullish(),
  /** Contact points. Absent far more often than present — treat a miss as a miss, not a failure. */
  emails: z.array(z.string()).nullish(),
  phone_numbers: z.array(z.string()).nullish(),
  social_graph_urls: z.array(z.string()).nullish(),
});

export type DomainTechnologiesRow = z.infer<typeof domainTechnologiesRowSchema>;

/** Every technology name in a row, flattened across the category buckets the vendor groups them in. */
export function technologyNames(row: DomainTechnologiesRow): string[] {
  const groups = row.technologies ?? {};
  const names: string[] = [];
  for (const entries of Object.values(groups)) {
    for (const entry of entries ?? []) {
      if (typeof entry.name === "string") names.push(entry.name.toLowerCase());
    }
  }
  return names;
}

/**
 * Keep the rows whose stack contains every name in `required`.
 *
 * **All, not any.** A slicer that returns domains matching *one* technology answers a different
 * question than the one a lead list asks — "runs Shopify and does not run Klaviyo" is a prospect
 * list, "runs Shopify or Klaviyo" is a report. `excluded` is applied after `required`, so a caller
 * can express the gap they sell into without a second pass.
 */
export function sliceByTechnology(
  rows: DomainTechnologiesRow[],
  options: { required?: string[]; excluded?: string[] },
): DomainTechnologiesRow[] {
  const required = (options.required ?? []).map((name) => name.toLowerCase());
  const excluded = (options.excluded ?? []).map((name) => name.toLowerCase());
  return rows.filter((row) => {
    const present = technologyNames(row);
    const hasAll = required.every((name) => present.includes(name));
    if (!hasAll) return false;
    return !excluded.some((name) => present.includes(name));
  });
}

/**
 * Read the technology stack for one domain. One `target` per call: the vendor accepts a single
 * string, and batching it into a loop here would hide the per-request price from the caller.
 */
export async function fetchDomainTechnologies(input: {
  target: string;
  limit?: number;
}): Promise<DataforseoApiResponse<DomainTechnologiesRow[]>> {
  const target = input.target.trim();
  if (target.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "fetchDomainTechnologies needs a target domain; the vendor's target is a plain string here",
    );
  }

  const response = await dataforseoPost(TECHNOLOGIES_PATH, [
    { target, limit: input.limit ?? 10 },
  ]);
  const task = assertOk(response);

  const rows = z
    .array(domainTechnologiesRowSchema)
    .safeParse(firstResult(task)?.items ?? []);
  if (!rows.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO domain_technologies returned an invalid shape",
    );
  }

  return { data: rows.data, billing: buildTaskBilling(task) };
}
