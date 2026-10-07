/**
 * Turning the vendor's criterion IDs into names.
 *
 * ## The rule this module exists to hold
 *
 * `categories_for_domain` returns `categories: [10007]` and no labels. The labels come from
 * `category_taxonomy`, which is seeded from a **dated** CSV the vendor republishes. So the two can
 * disagree in one direction: a response can name a criterion the committed taxonomy has never
 * heard of.
 *
 * When that happens, **the category is kept and its name is `null`**. Dropping it would understate
 * a customer's category profile with nothing on screen to say so, and inventing a label from the
 * number would be worse. This is the repository's `0`-is-not-`null` rule applied to a lookup: an
 * unresolvable category is a fact about our taxonomy's vintage, not an absence of the category.
 *
 * Pure by construction, and in its own module on purpose: the database read next door reaches
 * `cloudflare:workers` through the schema barrel, so a test of *this* logic must not have to load
 * it.
 */

export type NamedCategory = {
  criterionId: number;
  /** The vendor's slash-path, or null when the committed taxonomy does not have this id. */
  name: string | null;
};

/** Anything carrying the vendor's `categories` array. */
type WithCategories = { categories?: number[] | null };

/**
 * Attach names to each item, keeping every category the vendor named.
 *
 * An item with several categories gets all of them, in the vendor's order, so a caller that shows
 * only the first is making that choice rather than inheriting one.
 */
export function attachCategoryNames<T extends WithCategories>(
  items: T[],
  nameById: Map<number, string>,
): Array<T & { categoryNames: NamedCategory[] }> {
  return items.map((item) => ({
    ...item,
    categoryNames: (item.categories ?? []).map((criterionId) => ({
      criterionId,
      name: nameById.get(criterionId) ?? null,
    })),
  }));
}

/** Every criterion ID an item list refers to, so the lookup is one query. */
export function collectCriterionIds(items: WithCategories[]): number[] {
  return items.flatMap((item) => item.categories ?? []);
}
