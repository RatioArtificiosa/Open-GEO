/**
 * Reading a subregion answer, which carries **three** rulers rather than one.
 *
 * The reference states all three calculations, and they answer three different questions:
 *
 * - `interests` — each keyword against **its own highest location**. Locations compare within one
 *   keyword.
 * - `interests_comparison.items` — each keyword against the **highest keyword in that location**.
 *   Keywords compare within one location.
 * - `interests_comparison.absolute_items` — against the **highest across every keyword and every
 *   location**. The only block where two locations' numbers can be read against each other.
 *
 * A table that showed the first as if it were the third would make a small region look like a
 * stronghold, because every keyword has a 100 somewhere. Returning them under three names is the
 * whole job.
 *
 * And `interests_comparison` is **null when one keyword was asked for** — the vendor's answer, not
 * a gap, so it stays null.
 */

type GeoInterest = {
  /** The vendor's `geo_name`, which is the only reliable key: its sample sends a null `geo_id`. */
  geo: string;
  /** Null where the vendor reported 0, which its documentation defines as "not enough data". */
  value: number | null;
};

type KeywordSubregion = {
  keyword: string;
  locations: GeoInterest[];
};

type GeoRow = {
  geo_id?: string | null;
  geo_name?: string | null;
  value?: number | null;
};
type GeoRows = { geo_name?: string | null; values?: number[] | null };

type SubregionLike = {
  keywords?: string[] | null;
  interests?: Array<{
    keyword?: string | null;
    values?: GeoRow[] | null;
  }> | null;
  interests_comparison?: {
    items?: GeoRows[] | null;
    absolute_items?: GeoRows[] | null;
  } | null;
};

function readValue(value: number | null | undefined): number | null {
  return value == null || value === 0 ? null : value;
}

/** Per keyword, with each keyword's own highest location as its 100. */
export function readSubregionInterests(
  input: SubregionLike,
): KeywordSubregion[] {
  return (input.interests ?? []).map((entry) => ({
    keyword: entry.keyword ?? "",
    locations: (entry.values ?? []).map((row) => ({
      geo: row.geo_name ?? "",
      value: readValue(row.value),
    })),
  }));
}

type SubregionComparison = {
  /** Within each location, aligned to the request's keyword order. */
  withinLocation: Array<{ geo: string; values: Array<number | null> }>;
  /** Across every keyword and location — the only cross-location ruler. */
  acrossAllLocations: Array<{ geo: string; values: Array<number | null> }>;
};

/**
 * The two comparison blocks, or null.
 *
 * Null is a real answer: the vendor returns it for a single keyword, because there is nothing to
 * compare. An empty object would render as "no data".
 */
export function readSubregionComparison(
  input: SubregionLike,
): SubregionComparison | null {
  const comparison = input.interests_comparison;
  if (comparison == null) return null;

  const read = (rows: GeoRows[] | null | undefined) =>
    (rows ?? []).map((row) => ({
      geo: row.geo_name ?? "",
      values: (row.values ?? []).map(readValue),
    }));

  return {
    withinLocation: read(comparison.items),
    acrossAllLocations: read(comparison.absolute_items),
  };
}

export const SUBREGION_PER_KEYWORD_CAVEAT =
  "Location scores are shares of that keyword's own strongest location, so they compare places within one keyword — every keyword has a 100 somewhere.";

export const SUBREGION_COMPARISON_CAVEAT =
  "The within-location block compares keywords inside one place; only the across-all-locations block can be read between places. A single keyword has neither.";
