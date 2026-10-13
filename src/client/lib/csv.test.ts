import { describe, expect, it } from "vitest";
import { buildCsv } from "./csv";

/** Build one cell and return the raw CSV line, unquoted for comparison. */
function cellLine(payload: string): string {
  const csv = buildCsv(["Value"], [[payload]]);
  return csv.split(String.fromCharCode(10))[1] ?? "";
}

describe("buildCsv", () => {
  it("rounds decimal numbers to at most two places", () => {
    const csv = buildCsv(
      ["Page", "Traffic", "Keywords"],
      [["/tools", 1250.321954, 4]],
    );

    expect(csv).toContain('"1250.32"');
    expect(csv).toContain('"4"');
  });

  it("keeps formula-injection protection for string cells", () => {
    // The leading apostrophe makes the cell inert in a spreadsheet, and the
    // inner quotes are doubled so the CSV value survives a round trip.
    expect(cellLine(`=HYPERLINK("evil")`)).toBe(`"'=HYPERLINK(""evil"")"`);
  });

  // **`-` is a formula prefix and was missing.** The four leading characters a
  // CSV cell must escape are `=`, `+`, `-` and `@`; `-SUM(A1:A2)` evaluates in
  // Excel, Sheets and LibreOffice exactly like the `=` form, so a value that
  // lands in an exported report must be escaped on the `-` path too. CodeRabbit
  // caught the gap after the `noUncheckedIndexedAccess` conversion replaced the
  // membership test with a prefix regex.
  it("escapes every formula-or-signaling leading character", () => {
    for (const payload of [
      "=SUM(A1:A2)",
      "+SUM(A1:A2)",
      "-SUM(A1:A2)",
      "@SUM(A1:A2)",
    ]) {
      expect(cellLine(payload)).toBe(`"'${payload}"`);
    }
  });

  it("leaves a value that does not start with a signaling character alone", () => {
    expect(cellLine("normal value")).toBe('"normal value"');
  });
});
