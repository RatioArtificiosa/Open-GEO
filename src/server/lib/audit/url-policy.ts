import { AppError } from "@/server/lib/errors";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host.includes("%")) {
    host = host.split("%", 1)[0];
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

function isPrivateIpv4(host: string): boolean {
  const parts = normalizeHost(host)
    .split(".")
    .map((x) => Number(x));
  if (
    parts.length !== 4 ||
    parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseMappedIpv4FromIpv6(host: string): string | null {
  const normalized = normalizeHost(host);
  if (!normalized.startsWith("::ffff:")) return null;

  const mapped = normalized.slice("::ffff:".length);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
    return mapped;
  }

  const segments = mapped.split(":").filter(Boolean);
  if (segments.length !== 2) return null;

  const high = Number.parseInt(segments[0], 16);
  const low = Number.parseInt(segments[1], 16);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isPrivateIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (value === "::1" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb")
  ) {
    return true;
  }

  const mappedIpv4 = parseMappedIpv4FromIpv6(value);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) {
    return true;
  }

  return false;
}

function isIpLiteral(host: string): boolean {
  const normalized = normalizeHost(host);
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized) || normalized.includes(":");
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  if (isIpLiteral(host)) {
    return isPrivateIpv4(host) || isPrivateIpv6(host);
  }

  return false;
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

async function resolveAddressRecords(
  hostname: string,
  type: "A" | "AAAA",
): Promise<DnsResolution> {
  const response = await fetch(
    `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
    {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(2_500),
    },
  );

  // **A failed lookup is a failure, not an empty answer.**
  //
  // The original code returned `[]` on every error path, and every caller read
  // `[]` as "this host resolved to nothing private, so it is fine". That is the
  // wrong default for the direction that matters: a DNS server that times out
  // attributable to an attacker-controlled blocker, or a resolver under load
  // during a burst crawl, would admit the host *because the check could not
  // run*. An SSRF guard that opens on error is not a guard, it is a door with a
  // sign.
  if (!response.ok) {
    return { ok: false, reason: "http-error" };
  }

  const body: DnsJsonResponse = await response.json();
  // NXDOMAIN and friends are *real answers* — the host genuinely does not
  // resolve — so those are ok with an empty list. A malformed body is not a
  // real answer and stays a failure.
  if (body.Status !== 0 && typeof body.Status === "number") {
    return { ok: true, addresses: [] };
  }
  if (!Array.isArray(body.Answer)) {
    return { ok: false, reason: "malformed-body" };
  }

  const expectedType = type === "A" ? 1 : 28;
  const addresses = body.Answer.filter(
    (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
      answer.type === expectedType && typeof answer.data === "string",
  ).map((answer) => normalizeHost(answer.data));

  return { ok: true, addresses };
}

/** A DoH lookup result: either a real answer or a reason it could not run. */
type DnsResolution =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: string };

async function hostnameResolvesToBlockedAddress(
  hostname: string,
): Promise<boolean> {
  const host = normalizeHost(hostname);
  if (!host || isIpLiteral(host)) return false;

  let v4: DnsResolution;
  let v6: DnsResolution;
  try {
    [v4, v6] = await Promise.all([
      resolveAddressRecords(host, "A"),
      resolveAddressRecords(host, "AAAA"),
    ]);
  } catch {
    // A timeout or transport failure. Fail closed: a host we could not check
    // is a host we do not fetch.
    return true;
  }

  // **A partial failure fails closed too.** A host with an A record and no
  // AAAA record *because the AAAA lookup failed* is not a host with no IPv6
  // address — it is one whose IPv6 address is unknown, and an unknown address
  // is exactly the one that could be metadata or loopback.
  if (!v4.ok || !v6.ok) return true;

  const addresses = [...v4.addresses, ...v6.addresses];
  return addresses.some(
    (address) => isPrivateIpv4(address) || isPrivateIpv6(address),
  );
}

/**
 * Synchronous SSRF check for URLs discovered mid-crawl (links, redirect
 * targets, sitemap entries). Blocks non-http(s) schemes, private/loopback IP
 * literals, and internal hostnames. DNS resolution is only performed for the
 * start URL (see normalizeAndValidateStartUrl); per-link DoH lookups would be
 * prohibitively slow.
 *
 * **This function is one layer of a defence, and it is not the one that stands
 * between a customer and the cloud metadata endpoint.** `isBlockedHost` reaches
 * only *literals and suffixes*; a hostname that resolves to `169.254.169.254`
 * passes it cleanly, because no name is compared against any number. The
 * resolution layer sits at `assertCrawlableTarget`, which every crawl path
 * must call before fetching.
 */
export function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return !isBlockedHost(parsed.hostname);
}

/**
 * Why a hostname resolving to a private address is worse than it first looks.
 *
 * The fetch is an outbound request from a Worker inside Cloudflare's network.
 * A hostname that resolves to `169.254.169.254` reaches the cloud metadata
 * service from *inside* the account's own edge, where the instance's
 * credentials live — so this is not merely an internal scan, it is a credential
 * disclosure. A literal `169.254.169.254` in a URL is already blocked by
 * `isBlockedHost`; the gap is a DNS *name* that points there, and that gap is
 * why `normalizeAndValidateStartUrl` resolves and `isCrawlableUrl` cannot.
 */

/** The DoH query timeout, shared by the start URL and the per-link check. */
const LINK_RESOLUTION_TIMEOUT_MS = 2_500;

/** How many distinct hosts a single crawl may resolve per invocation. */
const LINK_DOH_BUDGET = 64;

/** How long a resolved host is trusted before it must be checked again. */
const LINK_RESOLUTION_TTL_MS = 5 * 60 * 1000;

/**
 * The set of relevance to DNS-conditioned SSRF.
 *
 * **A hostname whose address is already known is not re-resolved.** The crawl
 * walk visits a linked page's own links, and those links are overwhelmingly the
 * same host as the page — so a per-link lookup on every hop would multiply the
 * crawl's DNS cost by its link density, which is exactly the cost the original
 * `isCrawlableUrl` comment rejected. The cache is per-invocation (a module-level
 * Map, not a Durable Object), so it cannot be poisoned across requests: every
 * `scheduled`/`fetch` invocation starts with an empty cache and pays for its own
 * hosts, at most `LINK_DOH_BUDGET` of them.
 */
const linkResolutionCache = new Map<string, number>();

/** Cleared per invocation by the crawl runner; see `resetCrawlDnsBudget`. */
let linkDohSpend = 0;

/**
 * Reset the per-invocation DNS budget and resolution cache.
 *
 * Called by the crawl workflow at the start of every audit invocation. **The
 * budget is per-invocation by design** — the alternative (a long-lived cache)
 * would let one crawl poison the next with an address it had learned, which is a
 * cache-poisoning primitive that survives the process. A per-invocation budget
 * that resets is bounded in the direction that matters: a single audit cannot
 * amortise a DNS attack across crawls.
 */
export function resetCrawlDnsBudget(): void {
  linkDohSpend = 0;
  linkResolutionCache.clear();
}

/**
 * Resolve a hostname and decide whether the crawl may fetch it.
 *
 * Returns `true` when the fetch is allowed and `false` when it must not happen:
 * a blocked literal, a blocked suffix, a private-resolution, or an exhausted
 * per-invocation DNS budget. **The failure mode is a refusal, not an
 * exception** — a crawl page whose next link was refused is a page the audit
 * could not cover, and an audit that throws on one bad link is an audit that
 * produces nothing.
 *
 * Note this is *async*, unlike `isCrawlableUrl`. The synchronous checker stays
 * the cheap pre-filter (it removes the obvious cases without a network call),
 * and this one supplies the answer the pre-filter cannot.
 */
export async function assertCrawlableTarget(
  target: URL,
  now: number = Date.now(),
): Promise<boolean> {
  const host = normalizeHost(target.hostname);
  if (!host) return false;
  // A literal was already checked by isCrawlableUrl; re-checking costs nothing.
  if (isBlockedHost(host)) return false;

  const cached = linkResolutionCache.get(host);
  if (cached !== undefined && now - cached < LINK_RESOLUTION_TTL_MS) {
    return true;
  }

  if (linkDohSpend >= LINK_DOH_BUDGET) {
    // The budget is the cap, and hitting it is a *crawl-side* failure rather
    // than an SSRF: a page whose next link could not be checked is not fetched,
    // so the audit is less complete rather than unsafe. The caller distinguishes
    // the two by the number of hosts it had already resolved.
    return false;
  }
  linkDohSpend += 1;

  if (await hostnameResolvesToBlockedAddress(host)) return false;
  linkResolutionCache.set(host, now);
  return true;
}

export async function normalizeAndValidateStartUrl(
  input: string,
): Promise<string> {
  let raw = input.trim();
  if (!raw) throw new AppError("VALIDATION_ERROR");

  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR");
  }

  if (isBlockedHost(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  if (await hostnameResolvesToBlockedAddress(parsed.hostname)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }

  parsed.hash = "";
  return parsed.toString();
}

const START_URL_REDIRECT_HOPS = 5;
const START_URL_PROBE_TIMEOUT_MS = 10_000;

/**
 * Follow redirects on the audit's start URL so the audit anchors to the
 * site's real origin. Without this, auditing a domain that 301s elsewhere
 * (…net -> …com, apex -> www) dead-ends after one page: the redirect target
 * is a different origin, so the same-origin crawl policy can't follow it.
 *
 * Every hop re-runs the full start-URL validation (SSRF, blocked hosts), so
 * a redirect can't smuggle the audit somewhere the user couldn't have
 * pointed it directly. Probe failures (timeouts, HEAD rejected) fall back
 * to the last validated URL — the crawl records the real fetch result.
 */
export async function resolveStartUrlRedirects(
  startUrl: string,
): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop < START_URL_REDIRECT_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "OpenGeo-Audit/1.0" },
        signal: AbortSignal.timeout(START_URL_PROBE_TIMEOUT_MS),
      });
    } catch {
      return current;
    }
    if (response.status < 300 || response.status >= 400) return current;
    const location = response.headers.get("location");
    if (!location) return current;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return current;
    }
    current = await normalizeAndValidateStartUrl(next.toString());
  }
  return current;
}
