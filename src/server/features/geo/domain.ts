/**
 * Domain normalisation for the GEO feature.
 *
 * One copy, shared by the service, the series reads and the MCP tools. A second
 * implementation is how "HTTPS://WWW.Acme.com/x" and "acme.com" end up as two
 * monitored targets, and the failure is invisible: both appear in the list and
 * one of them never fills.
 *
 * `trim()` on the result matters: a pasted `"acme.com "` would otherwise be its
 * own target, distinct from `"acme.com"`.
 */
export function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}
