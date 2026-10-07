/**
 * Reading the vendor's category taxonomy CSV.
 *
 * Separate from the seed script so it can be imported without running it: `scripts/seed-categories.ts`
 * calls `main()` at module scope, so importing it to test the parser would seed the database first.
 *
 * The file is the **only** source of category names — the API returns criterion IDs and nothing
 * else — so a line this cannot read is not cosmetic. It is a category that would appear in a
 * customer's profile as a bare number with nothing explaining why, which is why the parser returns
 * malformed lines with their line numbers instead of skipping them.
 */

export type CategoryRow = { criterionId: number; path: string };

export type ParsedCategoryCsv = {
  rows: CategoryRow[];
  malformed: Array<{ line: number; text: string }>;
};

/**
 * Parse `Criterion ID,Category`, both fields quoted, category as a slash-path.
 *
 * Written by hand rather than through a CSV library: every row in the shipped vintage is two
 * quoted fields, and the one subtlety that matters is that the second field contains commas,
 * `&` and slashes freely — see the tests, which pin a name of the form
 * `/Business/Printing, Copying & Mailing`.
 */
export function parseCategoryCsv(csv: string): ParsedCategoryCsv {
  const rows: CategoryRow[] = [];
  const malformed: Array<{ line: number; text: string }> = [];
  const lines = csv.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (index === 0 && /^"?Criterion ID"?/i.test(line)) continue;
    const match = /^"?(\d+)"?,\s*"?(.*?)"?$/.exec(line);
    const id = match ? Number.parseInt(match[1], 10) : Number.NaN;
    const path = match?.[2]?.trim() ?? "";
    if (Number.isNaN(id) || path.length === 0) {
      malformed.push({ line: index + 1, text: line.slice(0, 120) });
      continue;
    }
    rows.push({ criterionId: id, path });
  }
  return { rows, malformed };
}
