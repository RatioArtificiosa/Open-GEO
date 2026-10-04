/**
 * robots.txt and sitemap.xml discovery for the site audit crawler.
 */
import robotsParser from "robots-parser";
import { XMLParser } from "fast-xml-parser";
import { isSameOrigin, normalizeUrl } from "./url-utils";

const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
// robots.txt is checkpointed as durable Workflow step state (~1MiB cap, shared
// with the rest of the step's return). RFC 9309 requires parsers to handle at
// least 500 KiB and permits ignoring anything beyond it — Google does exactly
// that — so this cap matches standard crawler behavior while keeping a
// misbehaving server (e.g. HTML at /robots.txt) from blowing the step limit.
const MAX_ROBOTS_TXT_BYTES = 500 * 1024;
// llms.txt is meant to be a short outline, so a quarter of the robots.txt budget
// is generous. Truncated rather than rejected: a long file is still readable, and
// a site that describes itself for 300 KiB should not be reported as undescribed.
const MAX_LLMS_TXT_BYTES = 125 * 1024;
/**
 * The User-Agent every customer-facing fetch identifies itself with.
 *
 * **One constant, because the crawl tells sites who it is and there is no reason
 * for the readiness path to answer to a different name.** Site owners read these
 * in their logs, and a crawler that appears under two identities is harder to
 * block deliberately — which cuts against the whole point of an audit a customer
 * can act on.
 */
const AUDIT_USER_AGENT = "OpenGeo-Audit/1.0";
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;
const SITEMAP_CONCURRENCY = 5;
const SITEMAP_RETRIES = 1;
// Sitemap shards can legally reach 50 MB and SITEMAP_CONCURRENCY of them are
// read at once, so unbounded reads can exhaust Worker memory. Oversized
// shards are skipped whole — truncated XML would not parse anyway, and real
// generators shard far below this.
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

export interface RobotsResult {
  isAllowed: (url: string) => boolean;
  sitemapUrls: string[];
}

/**
 * Fetch the raw robots.txt body (null = missing/unreachable). Kept separate
 * from parsing so Workflows can checkpoint the text as durable step state and
 * re-derive the parsed result deterministically on replay.
 *
 * **Exported because `runAudit` needs the text as well as the parse.** The
 * crawler needs `parseRobotsTxt` for its allow/deny decisions; the readiness
 * report needs the raw directives so it can show the customer the exact line
 * that blocked them. Two consumers of the same fetch, so the fetch is shared
 * rather than written twice — a second robots.txt fetcher would be free to drift
 * on the timeout, the byte cap, or the User-Agent, and **three copies of a
 * User-Agent string is three chances for the crawl to misidentify itself**.
 */
export async function fetchRobotsTxtText(
  origin: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": AUDIT_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;
    return (await response.text()).slice(0, MAX_ROBOTS_TXT_BYTES);
  } catch (error) {
    console.warn("Failed to fetch robots.txt:", error);
    return null;
  }
}

/**
 * What fetching `/llms.txt` produced.
 *
 * ## Why this is a tagged result and not `string | null`
 *
 * **Because the difference is the whole point of the finding, and `null` threw it
 * away.** A site that returns 404 has *decided* not to publish a map for agents —
 * that is a finding the owner can fix in ten minutes. A request we could not
 * complete is a gap in *our* coverage, and telling a customer "your site does not
 * publish an llms.txt" when the truth is "we could not reach it" is a confident
 * wrong answer about their site, produced by our own network.
 *
 * The first version returned `null` for both and carried the distinction in a
 * comment that described intent the code did not implement — and then
 * `runReadiness` had to guess which case it was looking at, so it guessed "the site
 * does not publish one" and **reported a passing network as a defect in the
 * customer's site.** A comment claiming a guarantee is worth exactly nothing
 * against code that does not provide it.
 */
type LlmsTxtFetch =
  /** A usable body was fetched. Possibly empty — an empty file is a real answer. */
  | { status: "found"; body: string }
  /** The server answered, and the answer was "no such file". A finding. */
  | { status: "absent" }
  /**
   * We could not get an answer: a network error, a timeout, a 5xx.
   *
   * **Not a finding about the site.** Nothing is claimed about the customer's
   * markup, because nothing is known about it.
   */
  | { status: "unreachable"; reason: string };

/**
 * Fetch `/llms.txt`, the agent-facing outline a site may publish.
 *
 * ## Why this had to be written
 *
 * `auditLlmsTxt` (CL-300a) has shipped since it was written and **nothing could
 * ever call it**, because no code fetched the file it grades — the sixth instance
 * of that shape in this codebase, and the second time the fix turned out to be
 * free rather than a new dependency.
 *
 * ## The byte cap is enforced while reading, not after
 *
 * `response.text()` buffers the **entire** body into memory before anything can
 * trim it, so slicing afterwards caps what we *return* and not what we *hold*. A
 * server answering `/llms.txt` with a gigabyte would be read into a Worker before
 * the cap ever applied. So the stream is read incrementally and the reader is
 * **cancelled** the moment the limit is reached — which also closes the socket,
 * because a cancelled reader tells the origin we are done rather than letting it
 * keep pushing into a buffer nobody will read. Releasing the lock instead would
 * hand the stream back with the connection still open, and the cost would be
 * invisible until somebody wondered why audits held so many sockets.
 *
 * The limit is deliberately generous for what is meant to be a short outline, and
 * the body is truncated rather than rejected: a long one is still readable, and a
 * page that describes itself for 300 KiB should not be reported as undescribed.
 */
export async function fetchLlmsTxt(origin: string): Promise<LlmsTxtFetch> {
  try {
    const response = await fetch(`${origin}/llms.txt`, {
      headers: { "User-Agent": AUDIT_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });

    // **404 is a decision, not a failure.** So is 410. Everything else non-OK is
    // our problem or the server's, and claims nothing about the customer's markup.
    if (response.status === 404 || response.status === 410) {
      return { status: "absent" };
    }
    if (!response.ok) {
      return {
        status: "unreachable",
        reason: `the server answered ${response.status}`,
      };
    }

    return {
      status: "found",
      body: await readAtMost(response, MAX_LLMS_TXT_BYTES),
    };
  } catch (error) {
    console.warn("Failed to fetch llms.txt:", error);
    return { status: "unreachable", reason: describeFetchFailure(error) };
  }
}

/**
 * Reads at most `limit` bytes from a response and stops reading.
 *
 * **The cap is the reason this is a function.** `text()` has no ceiling, so any
 * caller who forgets to think about this reads whatever the server sends.
 */
async function readAtMost(response: Response, limit: number): Promise<string> {
  const body = response.body;
  // No stream (a synthetic Response in a test, or a runtime without one): fall
  // back to the buffered read. The cap still applies to the result.
  if (body === null) return (await response.text()).slice(0, limit);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) break;
    }
  } finally {
    // **`cancel()`, not `releaseLock()`** — cancelling closes the connection and
    // tells the origin to stop; releasing merely hands the stream back and leaves
    // it open. A body we have decided not to finish is a body we should stop
    // receiving. The catch is because a reader can already be errored, and a
    // cleanup path must not become the thing that throws.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= limit) break;
    const slice = chunk.subarray(0, limit - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * An error phrased for a customer-facing report.
 *
 * **Newlines stripped, because this string is rendered.** A proxy returning an
 * HTML error page would otherwise put arbitrary text — and a forged line — into a
 * report a site owner reads.
 */
function describeFetchFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const single = message.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "the request failed" : single.slice(0, 120);
}

/** Deterministic: same text in, same result out. Null = everything allowed. */
export function parseRobotsTxt(
  origin: string,
  text: string | null,
): RobotsResult {
  if (text === null) {
    return { isAllowed: () => true, sitemapUrls: [] };
  }

  const robots = robotsParser(`${origin}/robots.txt`, text);
  return {
    isAllowed: (url: string) => robots.isAllowed(url) ?? true,
    sitemapUrls: robots.getSitemaps(),
  };
}

/**
 * Fetch and parse a sitemap (supports sitemap index recursion).
 * Returns a flat list of page URLs found.
 */
function isProbablySitemapXml(
  contentType: string | null,
  body: string,
): boolean {
  if (contentType?.toLowerCase().includes("xml")) {
    return true;
  }

  const trimmed = body.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<urlset") ||
    trimmed.startsWith("<sitemapindex")
  );
}

function getSitemapLocations(input: unknown): string[] {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map((entry) => {
      if (isRecord(entry)) {
        const loc = entry["loc"];
        return typeof loc === "string" ? loc : null;
      }
      return null;
    })
    .filter((loc): loc is string => typeof loc === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getParsedSitemapSections(parsed: unknown): {
  sitemap: unknown;
  url: unknown;
} {
  if (!parsed || typeof parsed !== "object") {
    return { sitemap: undefined, url: undefined };
  }

  const root = parsed as {
    sitemapindex?: { sitemap?: unknown };
    urlset?: { url?: unknown };
  };

  return {
    sitemap: root.sitemapindex?.sitemap,
    url: root.urlset?.url,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "name" in error && error.name === "TimeoutError";
}

/** Read a response body up to maxBytes; null when the body exceeds it. */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function fetchSitemapDocumentWithRetry(sitemapUrl: string): Promise<{
  nestedSitemaps: string[];
  pageUrls: string[];
  timedOut: boolean;
}> {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl) {
    return { nestedSitemaps: [], pageUrls: [], timedOut: false };
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    try {
      const response = await fetch(normalizedSitemapUrl, {
        headers: { "User-Agent": "OpenGeo-Audit/1.0" },
        signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
      });

      const finalUrl = normalizeUrl(response.url, normalizedSitemapUrl);
      if (!finalUrl || !isSameOrigin(finalUrl, normalizedSitemapUrl)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      if (!response.ok) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const body = await readBodyCapped(response, MAX_SITEMAP_BYTES);
      if (
        body === null ||
        !isProbablySitemapXml(response.headers.get("content-type"), body)
      ) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const parsed = xmlParser.parse(body) as unknown;
      const sections = getParsedSitemapSections(parsed);
      const nestedSitemaps = getSitemapLocations(sections.sitemap)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);
      const pageUrls = getSitemapLocations(sections.url)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);

      return { nestedSitemaps, pageUrls, timedOut: false };
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === SITEMAP_RETRIES) {
        break;
      }
    }
  }

  return {
    nestedSitemaps: [],
    pageUrls: [],
    timedOut: isTimeoutError(lastError),
  };
}

/**
 * Discover all page URLs from robots.txt + sitemaps for an origin.
 * Also tries the default /sitemap.xml if not listed in robots.txt.
 */
export async function discoverUrls(
  origin: string,
  maxPages = 50,
): Promise<{ urls: string[]; robotsText: string | null }> {
  const robotsText = await fetchRobotsTxtText(origin);
  const robots = parseRobotsTxt(origin, robotsText);

  // Collect sitemap URLs: from robots.txt + default location
  const sitemapSources = new Set(robots.sitemapUrls);
  sitemapSources.add(`${origin}/sitemap.xml`);

  const maxDiscoveredUrls = Math.min(Math.max(maxPages * 20, 500), 50_000);
  const allUrls = new Set<string>();

  const queue: Array<{ url: string; depth: number }> = Array.from(
    sitemapSources,
  )
    .map((url) => normalizeUrl(url, origin))
    .filter((url): url is string => url !== null)
    .filter((url) => isSameOrigin(url, origin))
    .map((url) => ({ url, depth: MAX_SITEMAP_DEPTH }));
  const seenSitemapDocs = new Set<string>();
  let fetchedDocs = 0;
  let failedDocs = 0;
  let timedOutDocs = 0;

  while (queue.length > 0 && allUrls.size < maxDiscoveredUrls) {
    if (fetchedDocs >= MAX_SITEMAP_DOCS) {
      break;
    }
    const batch = queue.splice(0, SITEMAP_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        const normalizedUrl = normalizeUrl(url);
        if (
          !normalizedUrl ||
          !isSameOrigin(normalizedUrl, origin) ||
          depth <= 0 ||
          seenSitemapDocs.has(normalizedUrl)
        ) {
          return;
        }

        seenSitemapDocs.add(normalizedUrl);
        fetchedDocs += 1;

        const result = await fetchSitemapDocumentWithRetry(normalizedUrl);
        if (
          result.pageUrls.length === 0 &&
          result.nestedSitemaps.length === 0
        ) {
          failedDocs += 1;
          if (result.timedOut) {
            timedOutDocs += 1;
          }
          return;
        }

        for (const pageUrl of result.pageUrls) {
          if (!isSameOrigin(pageUrl, origin)) continue;
          if (allUrls.size >= maxDiscoveredUrls) break;
          allUrls.add(pageUrl);
        }

        if (depth <= 1) return;

        for (const nestedUrl of result.nestedSitemaps) {
          if (!isSameOrigin(nestedUrl, origin)) continue;
          if (!seenSitemapDocs.has(nestedUrl)) {
            queue.push({ url: nestedUrl, depth: depth - 1 });
          }
        }
      }),
    );
  }

  if (failedDocs > 0) {
    console.warn(
      `Sitemap discovery completed with partial failures for ${origin}: fetched=${fetchedDocs}, failed=${failedDocs}, timedOut=${timedOutDocs}, discoveredUrls=${allUrls.size}`,
    );
  }

  // Cap at the crawl's page budget: these are seeds, the crawl can never use
  // more — and an uncapped list can blow the ~1MiB Workflow step-state limit.
  return {
    urls: Array.from(allUrls).slice(0, maxPages),
    robotsText,
  };
}
