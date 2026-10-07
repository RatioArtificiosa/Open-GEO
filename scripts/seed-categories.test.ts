/**
 * The taxonomy parser, and the one rule that matters about it.
 *
 * The file is the vendor's, and it is the only source of category **names** — the API returns
 * criterion IDs and nothing else. So a line the parser cannot read is not a cosmetic problem: it
 * is a category that will appear in a customer's profile as a bare number, with nothing anywhere
 * saying why. Hence the rule these tests pin: a malformed line is **reported with its line
 * number and the seed refuses to run**, rather than being skipped so the ingest looks clean.
 */
import { describe, expect, it } from "vitest";
import { parseCategoryCsv } from "./category-csv";

const HEADER = "Criterion ID,Category";

describe("parseCategoryCsv", () => {
  it("reads the vendor's format", () => {
    const { rows, malformed } = parseCategoryCsv(
      [
        HEADER,
        '"10021","/Apparel"',
        '"10937","/Apparel/Apparel Accessories/Bags & Packs"',
      ].join("\n"),
    );
    expect(malformed).toEqual([]);
    expect(rows).toEqual([
      { criterionId: 10021, path: "/Apparel" },
      {
        criterionId: 10937,
        path: "/Apparel/Apparel Accessories/Bags & Packs",
      },
    ]);
  });

  it("keeps a comma that belongs to the category name", () => {
    // The second field is quoted and the hierarchy uses `&` and `,` freely, so splitting on
    // commas would truncate a real name and silently ingest a wrong one.
    const { rows } = parseCategoryCsv(
      `${HEADER}\n"10500","/Business/Printing, Copying & Mailing"`,
    );
    expect(rows[0]?.path).toBe("/Business/Printing, Copying & Mailing");
  });

  it("skips the header and blank lines without calling them malformed", () => {
    const { rows, malformed } = parseCategoryCsv(
      `${HEADER}\n\n"10021","/Apparel"\n\n`,
    );
    expect(rows).toHaveLength(1);
    expect(malformed).toEqual([]);
  });

  it("reports a malformed line with its number instead of dropping it", () => {
    const { rows, malformed } = parseCategoryCsv(
      [
        HEADER,
        '"10021","/Apparel"',
        '"not-a-number","/Broken"',
        '"10022",""',
      ].join("\n"),
    );
    expect(rows).toHaveLength(1);
    // Two, and the line numbers are the file's own — so a reader can open the CSV and look.
    expect(malformed).toHaveLength(2);
    expect(malformed[0]?.line).toBe(3);
    expect(malformed[0]?.text).toContain("not-a-number");
    expect(malformed[1]?.line).toBe(4);
  });
});
