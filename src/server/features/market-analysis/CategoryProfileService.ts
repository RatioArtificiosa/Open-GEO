/**
 * A domain's category profile: the vendor's categories, with names.
 *
 * ## Two sources, joined deliberately at the last moment
 *
 * The metrics come from `categories_for_domain`, which returns **criterion IDs and no labels**.
 * The labels come from `category_taxonomy`, seeded from a vendor CSV that carries a date in its
 * filename because it gets republished. So the join can miss, and when it does the category is
 * **kept with `name: null`** — see `./category-names.ts` — while `unresolvedCount` says how many
 * that happened to.
 *
 * That count is the honest half of this feature. A profile with three unnamed categories is
 * telling the reader that our taxonomy is behind the vendor's, which is information. Silently
 * dropping them, or labelling them `Category 99999`, would both produce a tidier screen and a
 * worse answer.
 */
import {
  attachCategoryNames,
  collectCriterionIds,
  type NamedCategory,
} from "@/server/features/market-analysis/category-names";
import { findCategoryNames } from "@/server/features/market-analysis/category-taxonomy";

type MetricsBlock = {
  etv?: number | null;
  count?: number | null;
} | null;

/** One item as the vendor returns it, narrowed to what this feature reads. */
type CategoryItem = {
  categories?: number[] | null;
  metrics?: {
    organic?: MetricsBlock;
    paid?: MetricsBlock;
  } | null;
};

/** The slice of the client this service needs, so a test can pass a double. */
type CategoriesClient = {
  domain: {
    categoriesForDomain(input: {
      target: string;
      locationCode: number;
      languageCode: string;
      includeClickstreamData?: boolean;
      limit: number;
    }): Promise<CategoryItem[]>;
  };
};

type CategoryProfileEntry = CategoryItem & {
  categoryNames: NamedCategory[];
};

type DomainCategoryProfile = {
  target: string;
  entries: CategoryProfileEntry[];
  /** How many of the vendor's categories this build cannot name. */
  unresolvedCount: number;
};

export async function getDomainCategoryProfile(input: {
  client: CategoriesClient;
  target: string;
  locationCode: number;
  languageCode: string;
  limit: number;
  /** Doubles the vendor's price; the caller opts in, this service never assumes it. */
  includeClickstreamData?: boolean;
}): Promise<DomainCategoryProfile> {
  // Metered calls return the payload, not the envelope: `meter` is what unwraps it. An unmetered
  // read such as the waterfall returns the envelope itself, which is why the two shapes differ.
  const data = await input.client.domain.categoriesForDomain({
    target: input.target,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    includeClickstreamData: input.includeClickstreamData ?? false,
    limit: input.limit,
  });

  const names = await findCategoryNames(collectCriterionIds(data));
  const entries = attachCategoryNames(data, names);
  const unresolvedCount = entries.reduce(
    (total, entry) =>
      total +
      entry.categoryNames.filter((category) => category.name === null).length,
    0,
  );

  return { target: input.target, entries, unresolvedCount };
}
