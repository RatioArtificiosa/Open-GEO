import { describe, expect, it } from "vitest";
import {
  buildDemandTable,
  type AiKeywordRow,
  type GoogleKeywordRow,
} from "./demandTable";

/**
 * The AI Demand Explorer table.
 *
 * This is the one place the product *combines* Google's and AI's demand figures,
 * and the whole file exists to explain why that is safe here and unsafe in the
 * three places that refuse to do it. The ban is on **addition**; a ratio is
 * dimensionless and means something checkable.
 *
 * So the tests are mostly about the division-by-zero cases, which is where a
 * naive implementation reaches for `Infinity` or 0 and gets the sign of the
 * product's own thesis backwards.
 */

const ai = (keyword: string, aiSearchVolume: number | null): AiKeywordRow => ({
  keyword,
  aiSearchVolume,
});
const google = (
  keyword: string,
  searchVolume: number | null,
  extra: Partial<GoogleKeywordRow> = {},
): GoogleKeywordRow => ({
  keyword,
  searchVolume,
  keywordDifficulty: null,
  intent: null,
  ...extra,
});

describe("buildDemandTable", () => {
  it("computes AI demand per real Google search", () => {
    const table = buildDemandTable({
      aiRows: [ai("car insurance", 5000)],
      googleRows: [google("car insurance", 1000)],
    });
    expect(table.rows[0]?.aiToGoogle).toBe(5);
  });

  it("reports a Google zero as unbounded, not as zero and not as null", () => {
    // This is the product's thesis in one row: nobody searches it on Google and
    // AI engines ask about it constantly. `Infinity` would render as a number,
    // `0` would say the opposite of the truth, and `null` would read as "we
    // could not measure" when in fact we measured both sides.
    const table = buildDemandTable({
      aiRows: [ai("ai only", 900)],
      googleRows: [google("ai only", 0)],
    });
    const row = table.rows[0];
    expect(row?.aiToGoogle).toBe("infinite");
    expect(row?.aiToGoogleNote).toMatch(/strongest possible result/i);
    expect(row?.opportunity).toMatch(/cheapest win/i);
  });

  it("sorts an unbounded row above every finite ratio", () => {
    // If `infinite` sorted last, the single best row on the table would be at
    // the bottom — which is exactly what a naive `Infinity` comparison does.
    const table = buildDemandTable({
      aiRows: [ai("strong", 500), ai("unbounded", 10), ai("middling", 500)],
      googleRows: [
        google("strong", 10),
        google("unbounded", 0),
        google("middling", 100),
      ],
    });
    expect(table.rows.map((r) => r.keyword)).toEqual([
      "unbounded",
      "strong",
      "middling",
    ]);
  });

  it("treats an AI zero as a finding, in the opposite direction", () => {
    // Google searches it, AI engines do not ask. A real finding, and the one no
    // classic SEO tool surfaces.
    const table = buildDemandTable({
      aiRows: [ai("legacy", 0)],
      googleRows: [google("legacy", 500)],
    });
    expect(table.rows[0]?.aiToGoogle).toBe(0);
    expect(table.rows[0]?.aiToGoogleNote).toMatch(/reverse opportunity/i);
  });

  it("distinguishes an unknown Google volume from a measured zero", () => {
    // The distinction the whole no-zero-filling rule exists for: `null` means we
    // do not know, `0` means we know and the answer is nothing.
    const unknown = buildDemandTable({
      aiRows: [ai("k", 100)],
      googleRows: [google("k", null)],
    });
    expect(unknown.rows[0]?.aiToGoogle).toBeNull();
    expect(unknown.rows[0]?.aiToGoogleNote).toMatch(/unknown is not a zero/i);
  });

  it("explains a missing ratio rather than leaving a silent null", () => {
    // A row whose ratio is null argues, on its face, against the product's own
    // thesis. It has to say why it is empty.
    const table = buildDemandTable({
      aiRows: [],
      googleRows: [google("no ai data", 100)],
    });
    expect(table.rows[0]?.aiToGoogle).toBeNull();
    expect(table.rows[0]?.aiToGoogleNote).toMatch(/no AI demand was returned/i);
    expect(table.missing).toEqual(["no ai data"]);
  });

  it("joins on the normalised keyword, not on exact casing", () => {
    // Both clients lower-case server-side and return their own form. A naive
    // `===` join silently drops every row whose casing differs, and the result
    // reads as "no AI data" rather than "join bug".
    const table = buildDemandTable({
      aiRows: [ai("Car Insurance", 400)],
      googleRows: [google("  car insurance  ", 100)],
    });
    expect(table.rows[0]?.aiToGoogle).toBe(4);
    expect(table.missing).toEqual([]);
  });

  it("carries intent and difficulty through untouched", () => {
    const table = buildDemandTable({
      aiRows: [ai("k", 100)],
      googleRows: [
        google("k", 100, { intent: "commercial", keywordDifficulty: 42 }),
      ],
    });
    expect(table.rows[0]?.intent).toBe("commercial");
    expect(table.rows[0]?.keywordDifficulty).toBe(42);
  });

  it("never presents the ratio as something addable", () => {
    // The summary is the one place a reader skims, so the prohibition lives
    // there too. A test asserts the sentence is present.
    const table = buildDemandTable({
      aiRows: [ai("k", 100)],
      googleRows: [google("k", 50)],
    });
    expect(table.summary).toMatch(/never added to anything/i);
  });

  it("reports a table where nothing could be compared", () => {
    const table = buildDemandTable({ aiRows: [], googleRows: [] });
    expect(table.summary).toMatch(/no keyword could be compared/i);
  });

  it("sorts unrankable rows last", () => {
    const table = buildDemandTable({
      aiRows: [ai("known", 500), ai("unknown", null)],
      googleRows: [google("known", 100), google("unknown", 100)],
    });
    expect(table.rows.at(-1)?.keyword).toBe("unknown");
  });
});
