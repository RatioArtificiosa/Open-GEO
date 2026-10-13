import { at } from "@/shared/index-reads";
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
  // `split"/"` on a non-empty separator always yields at least one element, so
  // the host part is provably present. `at()` rather than `[0]`: an empty result
  // would have keyed a target on "", so two projects would collide on one row
  // and a domain lookup would return the wrong numbers.
  const segments = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/");
  return at(segments, 0, "a url host segment").trim();
}
