import { describe, expect, it, vi } from "vitest";

// The repository reaches `cloudflare:workers` through `@/db/provider` at import
// time. Mocking it is what lets this file test a **string function** — without
// the stub the suite would need a Worker environment to assert that `null` means
// unknown, which is precisely the coupling that kept this untestable before.
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { parseJsonArray } from "./auditCitabilityPages";

/**
 * The JSON-column rule the citability report depends on.
 *
 * ## Why this is tested alone
 *
 * `parseJsonArray` is one rule — **unreadable means unknown, never empty** — and
 * it was unreachable from every suite in this repository while it was private,
 * because the only caller is mocked wherever the phase is exercised. Changing it
 * from `null` to `[]` would have passed all 2,900+ tests and shipped a silent
 * lie: *every page whose column we cannot read would be reported as a page that
 * declared nothing*, which is a finding about the customer's markup produced by
 * our own gap.
 *
 * Testing it directly is the honest response to that, and it needs nothing but a
 * string — no database, no fixtures, no infrastructure.
 */

describe("parseJsonArray", () => {
  it("parses a JSON array", () => {
    expect(parseJsonArray<string>('["Article","FAQPage"]')).toEqual([
      "Article",
      "FAQPage",
    ]);
  });

  it("parses heading objects", () => {
    const raw = JSON.stringify([
      { level: 1, title: "What is GEO?" },
      { level: 2, title: "How does it work?" },
    ]);

    expect(parseJsonArray<{ level: number; title: string }>(raw)).toEqual([
      { level: 1, title: "What is GEO?" },
      { level: 2, title: "How does it work?" },
    ]);
  });

  it("returns null for a null column, meaning the page was never analysed", () => {
    // A page crawled before the migration has no value in this column at all.
    expect(parseJsonArray(null)).toBeNull();
  });

  it("returns an empty array for an empty column, which is a real answer", () => {
    // **The distinction the whole function exists for.** `[]` means the page was
    // parsed and declared nothing — a finding. `null` means we do not know. A test
    // that asserted both to the same value would pass while the report told a
    // customer their markup was at fault for our migration gap.
    expect(parseJsonArray("[]")).toEqual([]);
    expect(parseJsonArray("[]")).not.toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    // A truncated write or a hand-edited row must not fail the whole phase. One
    // unreadable row out of five hundred costs one page's measurement, not the
    // report.
    expect(parseJsonArray("{not json")).toBeNull();
    expect(parseJsonArray("[1,2")).toBeNull();
    expect(parseJsonArray("")).toBeNull();
  });

  it("returns null for valid JSON that is not an array", () => {
    // An object where an array belongs is a schema change, not data. Reading it
    // as `[]` would claim the page declared nothing, which is a different and
    // wrong statement.
    expect(parseJsonArray('{"level":1}')).toBeNull();
    expect(parseJsonArray('"Article"')).toBeNull();
    expect(parseJsonArray("42")).toBeNull();
    expect(parseJsonArray("null")).toBeNull();
  });

  it("keeps an array of the wrong element shape rather than filtering it", () => {
    // The columns are written and read by the same version of this codebase, so
    // element validation here would be a second place for the two to disagree.
    // Dropping entries would silently reduce a page's measured coverage.
    const raw = JSON.stringify([{ level: 1, title: "A" }, "not-an-object"]);

    const parsed = parseJsonArray<{ level: number; title: string }>(raw);

    expect(parsed).toHaveLength(2);
  });
});
