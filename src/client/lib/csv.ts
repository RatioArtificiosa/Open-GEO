import Papa from "papaparse";

export type CsvValue = string | number | boolean | null | undefined;

export type ExportValue = string | number | boolean;

export function buildCsv(headers: string[], rows: CsvValue[][]): string {
  const normalizedRows = rows.map((row) =>
    row.map((value) => normalizeExportValue(value ?? "")),
  );

  return Papa.unparse(
    {
      fields: headers,
      data: normalizedRows,
    },
    {
      quotes: true,
      newline: "\n",
    },
  );
}

export function normalizeExportValue(value: CsvValue): ExportValue {
  const normalized =
    typeof value === "number" ? roundExportNumber(value) : value;
  return sanitizeCsvValue(normalized ?? "");
}

function roundExportNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Prevent CSV/TSV injection (formula injection) by prefixing dangerous
// characters with a single quote. See OWASP guidance:
// https://owasp.org/www-community/attacks/CSV_Injection
function sanitizeCsvValue(
  value: string | number | boolean,
): string | number | boolean {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  // **A regex rather than a prefix-character index read.** This is a prefix
  // test, and a regex says what it means without an index at all — `value[0]`
  // is `string | undefined` under `noUncheckedIndexedAccess`, and
  // `["=", "+"].includes(undefined)` was false for the wrong reason rather than
  // for the right one.
  //
  // **`-` is in the set, and it was missing when CodeRabbit flagged this.** The
  // CWG spreadsheet-podance guidance lists `=`, `+`, `-` and `@` as the four
  // leading characters a CSV cell must escape, and a `-SUM(A1:A2)` payload
  // evaluates in Excel, Sheets and LibreOffice exactly like the `=` form. An
  // attacker who can place a keyword or a domain into a report gets the same
  // formula execution either way.
  if (/^[=+\-@\t\r\n]/.test(value)) {
    return `'${value}`;
  }

  return value;
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
