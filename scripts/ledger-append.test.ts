/**
 * `insertSection` — the guard against a silent corruption.
 *
 * **This helper exists because `String.replace` ate dollar signs**, and the unit test
 * that matters is the one that reproduces that exact failure: a section containing
 * `$$` must survive intact.
 *
 * The real incident: a ledger section documenting the cron review wrote `$$` four
 * times, and the size check reported a **176,000-character** discrepancy. That is not
 * a number a size guard produces by accident, which is the only reason it was caught
 * rather than committed.
 */
import { describe, expect, it } from "vitest";
import { insertSection } from "./ledger-append.mjs";

const ANCHOR = "### Second heading";

const source = () =>
  `### First heading\n\nSome prose.\n\n${ANCHOR}\n\nMore prose.\n`;

describe("insertSection", () => {
  it("inserts before the anchor", () => {
    const section = "### New\n\ntext\r\n";
    const out = insertSection(source(), ANCHOR, section);
    expect(out).toBe(
      `### First heading\n\nSome prose.\n\n${section}${ANCHOR}\n\nMore prose.\n`,
    );
  });

  it("keeps a `$$` intact, which is the bug it exists for", () => {
    // `String.replace` turns `$$` into a single `$` here, so the section would
    // arrive with its template literals mangled and **nothing would fail**.
    const section =
      "### Cost lines\n\n```\nvendor $${x.toFixed(4)} (est. $${y.toFixed(4)})\n```\n\r\n";

    const out = insertSection(source(), ANCHOR, section);

    expect(out).toContain("vendor $${x.toFixed(4)} (est. $${y.toFixed(4)})");
    // **The guard is arithmetic, not textual**: this is what caught the real
    // corruption, and it holds even for a section whose mangling would be invisible
    // to a reader.
    expect(Buffer.byteLength(out) - Buffer.byteLength(source())).toBe(
      Buffer.byteLength(section),
    );
  });

  it("refuses a missing anchor rather than appending somewhere arbitrary", () => {
    expect(() => insertSection(source(), "### Nowhere", "x")).toThrow(
      /anchor not found/,
    );
  });

  it("refuses an ambiguous anchor, so a section cannot be inserted twice", () => {
    // `replace` with a pattern would have substituted at both occurrences.
    const twice = source() + source();
    expect(() => insertSection(twice, ANCHOR, "x")).toThrow(/more than once/);
  });

  it("refuses a section carrying a forbidden control character", () => {
    // A NUL means the file is corrupt, so writing one is worse than refusing.
    expect(() => insertSection(source(), ANCHOR, "text\u0000more")).toThrow(
      /forbidden control character/,
    );
  });

  it("refuses when the result contains a forbidden character, even from the source", () => {
    // The check runs on the **whole result**, not just the section — so a file that
    // was already carrying one cannot be written back with it still there.
    const dirty = source() + "\u0000";
    expect(() => insertSection(dirty, ANCHOR, "ok")).toThrow(
      /forbidden control character/,
    );
  });

  it("measures in bytes, because the file is bytes", () => {
    // A character-count comparison would pass on a section containing multi-byte
    // text and miss a real discrepancy — which is how a guard can be right about the
    // idea and wrong about the numbers.
    const section = "### Ünïcödé\r\n\r\n";
    const out = insertSection(source(), ANCHOR, section);
    expect(Buffer.byteLength(out) - Buffer.byteLength(source())).toBe(
      Buffer.byteLength(section),
    );
  });
});
