import { describe, expect, it, vi } from "vitest";

// The module reaches `cloudflare:workers` through `@/db/provider` at import time.
// Mocking it is what lets a **pure rule** be tested — without the stub, asserting
// that these columns are written at all would need a database, which is precisely
// why the rule was untestable before.
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { citabilityColumns, parseJsonArray } from "./auditCitabilityPages";

/**
 * The two rules that connect the crawl to the citability report.
 *
 * ## Why these are tested directly
 *
 * Both were unreachable without a database. `citabilityColumns` ran inside
 * `insertCrawledBatch`'s row mapper, so **two mutations that stopped these columns
 * being written left every suite in the repository green** — the write could stop
 * happening and nothing could see it. That is the mutator earning its place twice
 * in one run: it found not just a missing assertion but a **rule with no seam to
 * assert it through**.
 *
 * These two functions together are that seam. The report is downstream of both, so
 * a regression in either is a wrong number shown to a customer with no error
 * anywhere.
 */

const HTML_PAGE = {
  isHtml: true,
  headings: [
    { level: 1, title: "What is GEO?" },
    { level: 2, title: "How does it work?" },
  ],
  schemaTypes: ["Article"],
};

describe("citabilityColumns", () => {
  it("serialises heading text and schema types for a parsed page", () => {
    const columns = citabilityColumns(HTML_PAGE);

    // Round-tripped rather than compared as strings, because the report reads
    // these back through `parseJsonArray` and a string comparison would pass on a
    // shape the reader cannot use.
    expect(
      parseJsonArray<{ level: number; title: string }>(columns.headingsJson),
    ).toEqual(HTML_PAGE.headings);
    expect(parseJsonArray<string>(columns.schemaTypesJson)).toEqual([
      "Article",
    ]);
  });

  it("writes an empty array for a page with no headings, which is a finding", () => {
    // **Not null.** The page was parsed and declared nothing — a real answer the
    // report scores. Null would say "we never looked", and the two need opposite
    // advice.
    const columns = citabilityColumns({
      isHtml: true,
      headings: [],
      schemaTypes: [],
    });

    expect(columns.headingsJson).toBe("[]");
    expect(columns.schemaTypesJson).toBe("[]");
  });

  it("writes null for a page that was never analysed", () => {
    // A PDF, a redirect, a non-HTML response. We never read its markup, so a value
    // here would be a claim about something we did not look at.
    const columns = citabilityColumns({
      isHtml: false,
      headings: [],
      schemaTypes: [],
    });

    expect(columns.headingsJson).toBeNull();
    expect(columns.schemaTypesJson).toBeNull();
  });

  it("survives a heading containing a quote or a newline", () => {
    // The value is JSON, so it must round-trip — a heading like `He said "hi"` is
    // ordinary on the open web and a naive string join would corrupt it.
    const awkward = [{ level: 1, title: 'He said "hi"\nthen left' }];

    const columns = citabilityColumns({
      isHtml: true,
      headings: awkward,
      schemaTypes: [],
    });

    expect(
      parseJsonArray<{ level: number; title: string }>(columns.headingsJson),
    ).toEqual(awkward);
  });
});
