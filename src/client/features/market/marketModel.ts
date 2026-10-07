import { sortBy } from "remeda";
/**
 * The Market Map's display rules.
 *
 * ## The label rule, and why an unnamed category still gets one
 *
 * A category arrives as a criterion ID with a name resolved from the seeded taxonomy, and the
 * taxonomy can be older than the data — so a row can genuinely have no name. The row is **kept**,
 * because dropping it would understate the profile, and it is labelled
 * `Unnamed category (10007)`. That is not an invented name: it names the *state* the row is in, so
 * a reader can see the gap and the criterion ID they would need to look up.
 *
 * ## Sorting is by traffic, and an unmeasured row does not outrank a measured one
 *
 * Rows sort by organic ETV descending. A row with no ETV sorts last rather than as zero, because
 * a profile's biggest category should never be a row nobody measured.
 */

type MarketCategory = {
  criterionIds: number[];
  names: Array<string | null>;
  organicCount: number | null;
  organicEtv: number | null;
  paidCount: number | null;
  paidEtv: number | null;
};

export type MarketRow = MarketCategory & {
  /** The last path segment, or `Unnamed category (id)` when the taxonomy cannot name it. */
  label: string;
  /** The vendor's whole slash-path, for context in a tooltip. Null when unnamed. */
  fullPath: string | null;
  /** True when at least one criterion in this row has no name in our taxonomy. */
  unnamed: boolean;
};

/** The final segment of a slash-path, which is the part a reader recognises. */
export function lastSegment(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function labelFor(category: MarketCategory): {
  label: string;
  fullPath: string | null;
} {
  const named = category.names.find((name): name is string => name !== null);
  if (named != null) return { label: lastSegment(named), fullPath: named };
  const id = category.criterionIds[0];
  return {
    label: id === undefined ? "Unnamed category" : `Unnamed category (${id})`,
    fullPath: null,
  };
}

export function toMarketRows(categories: MarketCategory[]): MarketRow[] {
  // `sortBy` rather than an in-place `sort()`: the lib target has no `toSorted`, and the
  // repository bans mutating sorts outright. The `-1` sentinel puts an unmeasured row last,
  // which is the point of the ordering.
  return sortBy(categories, (category) => -(category.organicEtv ?? -1)).map(
    (category) => ({
      ...category,
      ...labelFor(category),
      unnamed: category.names.some((name) => name === null),
    }),
  );
}

type MarketSummary = {
  categoryCount: number;
  /** How many rows carry at least one unnamed criterion. */
  unnamedCount: number;
  /** The biggest category by organic ETV, or null when nothing was measured. */
  topLabel: string | null;
  /** Total organic ETV across the rows that report one. */
  totalOrganicEtv: number;
};

export function summariseMarket(rows: MarketRow[]): MarketSummary {
  const measured = rows.filter((row) => row.organicEtv !== null);
  return {
    categoryCount: rows.length,
    unnamedCount: rows.filter((row) => row.unnamed).length,
    topLabel: measured[0]?.label ?? null,
    totalOrganicEtv: measured.reduce(
      (total, row) => total + (row.organicEtv ?? 0),
      0,
    ),
  };
}
