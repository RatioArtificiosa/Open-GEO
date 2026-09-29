/**
 * URL identity for the inclusion–citation join.
 *
 * ## Why this module exists
 *
 * The gap query is a `LEFT JOIN ... WHERE citation.url IS NULL` on **exact
 * string equality**. That is correct SQL and the wrong question: the same page
 * arrives spelled several different ways, and every variant the join fails to
 * match becomes a phantom "retrieved but never cited" — the product's headline
 * finding, asserted about a page that was in fact cited.
 *
 * Concretely, a single cited page reaches the archive as any of:
 *
 *   https://acme.com/pricing
 *   https://acme.com/pricing/
 *   https://acme.com/pricing?utm_source=openai
 *   http://acme.com/pricing            (scheme)
 *   https://www.acme.com/pricing        (www)
 *   HTTPS://ACME.com/pricing            (case)
 *
 * The join separates all six, so a page cited with one spelling and retrieved
 * with another is reported as a gap. That is not an edge case: `utm_source=openai`
 * appears in the *documented* ChatGPT payloads (see `citationParser.ts`), so the
 * tracking-parameter case is the normal one, not the rare one.
 *
 * ## What is and is not the same page
 *
 * Normalisation removes: scheme, `www.`, tracking parameters, fragments,
 * default ports, trailing slashes, and case in the host. It **keeps** the path,
 * the non-default port, and every query parameter that is not a known tracker —
 * because `?page=2` and `?id=5` are different pages, and collapsing them would
 * merge a real gap with a real citation.
 *
 * The tracking list is deliberately a *list of names*, not a regex over values.
 * A regex like `utm_*` guesses at values; a name list only discards parameters
 * that are named as tracking, and an unrecognised one is kept — which is the
 * conservative direction, because keeping a parameter can only *prevent* a
 * normalisation, never invent one.
 */

const TRACKING_PARAMS = new Set([
  // Documented in real ChatGPT annotation URLs.
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_source_platform",
  "utm_medium_platform",
  "utm_campaign_platform",
  "utm_creative_format",
  "utm_marketing_tactic",
  // Common referrer and click identifiers.
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "msclkid",
  "twclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "yclid",
  "_ga",
  "_gl",
  "ref",
  "referrer",
  "source",
  "spm",
  "trk",
  "trkCampaign",
]);

/**
 * The canonical identity of a URL.
 *
 * Returns null for input that is not a usable URL, so callers must handle it —
 * a normalised key of `""` would silently match every other empty key and
 * manufacture a gap.
 */
export function normaliseUrlForJoin(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  // A URL with no host is not a page — `mailto:` and `data:` reach here in
  // practice. Returning null keeps them out of the join rather than comparing
  // their whole payload as a "path".
  // `www.` stripped, because it is a vanity subdomain rather than a different
  // site, and a site that serves both spellings would otherwise produce a
  // phantom gap on every page it has ever been indexed under the other way.
  // The docblock promised this from the start and the code did not do it — the
  // test that checks `www` against the canonical form is what found the gap
  // between the two.
  const host = stripWww(parsed.hostname.toLowerCase());
  if (host === "") return null;

  const path = stripTrailingSlash(parsed.pathname);

  const keep: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    if (TRACKING_PARAMS.has(key)) continue;
    keep.push(`${key}=${value}`);
  }
  // Sorted so parameter order does not create a second identity for one page.
  keep.sort();
  const query = keep.length > 0 ? `?${keep.join("&")}` : "";

  // The default port is dropped; a non-default one is kept, because
  // `example.com:8443` is a different service from `example.com`.
  const port =
    parsed.port === "" || isDefaultPort(parsed.protocol, parsed.port)
      ? ""
      : `:${parsed.port}`;

  return `${host}${port}${path}${query}`;
}

function isDefaultPort(protocol: string, port: string): boolean {
  if (protocol === "http:") return port === "80";
  if (protocol === "https:") return port === "443";
  return false;
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.replace(/\/+$/, "");
  }
  return pathname === "/" ? "" : pathname;
}

/**
 * The `www.` vanity prefix, which is a different spelling rather than a
 * different site.
 */
export function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * The domain a URL belongs to, for the "is this one of ours?" question.
 *
 * Distinct from {@link normaliseUrlForJoin}: the join key includes the path
 * because two pages on one domain are two pages, while the ownership check is
 * about the host. Returns null rather than a partial answer.
 */
export function hostOf(raw: string | null | undefined): string | null {
  const key = normaliseUrlForJoin(raw);
  if (key === null) return null;
  const cut = key.search(/[/?]/);
  const host = cut === -1 ? key : key.slice(0, cut);
  return host === "" ? null : host;
}
