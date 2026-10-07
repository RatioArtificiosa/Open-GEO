/**
 * The taxonomy read: criterion IDs to names, from the seeded table.
 *
 * The naming rule — and why an unresolved category is kept rather than dropped — lives in
 * `./category-names.ts`. This module only does the lookup, and it is separate from that one
 * because importing it reaches `cloudflare:workers` through the schema barrel.
 */
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { categoryTaxonomy } from "@/db/schema";

/**
 * Read the names for a set of criterion IDs.
 *
 * IDs with no row are simply absent from the returned map, which is what lets the caller
 * distinguish "named" from "not in our taxonomy" rather than from an empty string.
 */
export async function findCategoryNames(
  ids: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  // `inArray` with an empty list generates `in ()`, which SQLite rejects. The guard is not an
  // optimisation: it is the difference between an empty profile and a failed request.
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      criterionId: categoryTaxonomy.criterionId,
      path: categoryTaxonomy.path,
    })
    .from(categoryTaxonomy)
    .where(inArray(categoryTaxonomy.criterionId, unique));

  return new Map(rows.map((row) => [row.criterionId, row.path]));
}
