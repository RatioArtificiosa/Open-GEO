import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { resetCrawlDnsBudget } from "@/server/lib/audit/url-policy";
import { crawlPage } from "@/server/workflows/site-audit-workflow-helpers";
import { at } from "@/shared/index-reads";

const PAGE_URL = "https://example.com/page";
const PAGE_HTML =
  "<html><head><title>A page</title></head><body><h1>A page</h1></body></html>";

/**
 * A DoH answer good enough for `assertCrawlableTarget` to admit the host.
 *
 * **A public address, because that is what every case below means.** Each describes a
 * page fetch to `example.com`; with the SSRF guard in front of the fetch those cases
 * now also resolve a hostname, and a guard that refused it would stop the whole file
 * for a reason unrelated to any case in it. The refusing side has its own describe.
 */
const PUBLIC_DNS_ANSWER = {
  Status: 0,
  Answer: [
    { type: 1, data: "93.184.216.34" },
    { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" },
  ],
};

/**
 * Is this a DoH lookup rather than a page fetch?
 *
 * **Distinguished by destination and parameters, never by call order.** The cases
 * below count `fetch` calls, and the SSRF guard adds two of them; a router keyed on
 * position would couple every count to whether the guard happened to run.
 */
function isDnsLookup(input: unknown): boolean {
  const url = new URL(String(input));
  return (
    url.hostname === "cloudflare-dns.com" &&
    url.searchParams.has("name") &&
    url.searchParams.has("type")
  );
}

/** The DNS reply the guard needs, as a fresh `Response` per call. */
function dnsResponse(): Response {
  return new Response(JSON.stringify(PUBLIC_DNS_ANSWER), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

/**
 * The page fetches a spy recorded, with the DoH lookups filtered out.
 *
 * The SSRF guard resolves the host before the fetch, which adds two `fetch` calls per
 * distinct host per invocation. Counting the raw total would make every existing
 * call-count assertion describe the guard's DNS cost rather than the page fetching it
 * was written about. The guard's own cost is asserted explicitly in its describe.
 */
function pageFetches(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => !isDnsLookup(url));
}

/**
 * Answer each page fetch with the next reply, repeating the last one. Every call
 * builds a fresh Response: a body can only be read (or cancelled) once.
 *
 * **DoH lookups are answered separately**, so the reply queue still describes only
 * page fetches.
 */
function stubFetch(...replies: Array<{ status: number; retryAfter?: string }>) {
  let index = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    if (isDnsLookup(input)) return Promise.resolve(dnsResponse());
    // `Math.min(index++, length - 1)` is bounded by the stub's own reply list, so
    // the index is always present. `at()` rather than a bare index: an undefined
    // reply makes `reply.status` throw, which the mock would surface as a
    // TypeError inside the crawl rather than as the assertion about the
    // retry-after behaviour.
    const reply = at(
      replies,
      Math.min(index++, replies.length - 1),
      "the stubbed fetch replies",
    );
    return Promise.resolve(
      new Response(PAGE_HTML, {
        status: reply.status,
        headers: {
          "content-type": "text/html",
          ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
        },
      }),
    );
  });
}

function crawl() {
  return crawlPage(
    PAGE_URL,
    0,
    false,
    createCrawlThrottle(Date.now() + 90_000),
  );
}

beforeEach(() => {
  // **The resolution cache is per-invocation and keyed by host**, so a case that
  // resolves `example.com` leaves the verdict cached for the next one. Every case in
  // this file crawls the same host, which is precisely the pollution the C1 tests
  // warn about: one hostname shared between two assertions is served by the earlier
  // resolution. Resetting is the test's way of starting a fresh invocation.
  resetCrawlDnsBudget();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("crawlPage", () => {
  it("waits out the server's Retry-After and keeps the retried page", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      { status: 429, retryAfter: "5" },
      { status: 200 },
    );

    const crawled = crawl();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pageFetches(fetchMock)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const page = await crawled;
    expect(pageFetches(fetchMock)).toHaveLength(2);
    expect(page?.fetchClass).toBe("ok");
    expect(page?.title).toBe("A page");
    // Recovered, but the crawl window should still slow down after it.
    expect(page?.rateLimited).toBe(true);
  });

  it("holds every other fetch in the chunk while one URL's 429 pause runs", async () => {
    vi.useFakeTimers();
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      // The DoH lookups are recorded separately: the assertion below is about the
      // chunk's *page* fetches being held, and the guard's own two lookups per host
      // would otherwise make the first entry a DNS query.
      if (isDnsLookup(input)) return Promise.resolve(dnsResponse());
      // eslint-disable-next-line @typescript-eslint/require-await -- returns a Promise<Response>; the guard branch resolves directly
      fetched.push(new Request(input).url);
      // Only the first request to the first URL is refused.
      const refused = fetched.length === 1;
      return new Response(PAGE_HTML, {
        status: refused ? 429 : 200,
        headers: {
          "content-type": "text/html",
          ...(refused ? { "retry-after": "5" } : {}),
        },
      });
    });
    const throttle = createCrawlThrottle(Date.now() + 90_000);

    const first = crawlPage(`${PAGE_URL}/first`, 0, false, throttle);
    await vi.advanceTimersByTimeAsync(0);
    const second = crawlPage(`${PAGE_URL}/second`, 0, false, throttle);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetched).toEqual([`${PAGE_URL}/first`]);

    await vi.advanceTimersByTimeAsync(3_000);
    const pages = await Promise.all([first, second]);
    expect(fetched).toHaveLength(3);
    expect(pages.map((page) => page?.fetchClass)).toEqual(["ok", "ok"]);
  });

  it("records a page the site keeps rate limiting, without calling it blocked", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "1" });

    const crawled = crawl();
    await vi.advanceTimersByTimeAsync(30_000);
    const page = await crawled;

    expect(pageFetches(fetchMock)).toHaveLength(4);
    expect(page?.fetchClass).toBe("rate_limited");
  });

  it("recovers concurrent pages without a burst after sixty seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      // DoH lookups are not page starts: the guard resolves all five hosts up front,
      // and counting those would put the assertion about a cooldown-shaped burst of
      // *page* fetches onto the guard's DNS cost instead.
      if (isDnsLookup(input)) return Promise.resolve(dnsResponse());
      starts.push(Date.now());
      return new Response(PAGE_HTML, {
        status: Date.now() < 60_000 ? 429 : 200,
        headers: { "content-type": "text/html", "retry-after": "60" },
      });
    });
    const throttle = createCrawlThrottle(90_000);
    const pages = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        crawlPage(`${PAGE_URL}/${i}`, 0, false, throttle),
      ),
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(starts).toEqual([0]);
    await vi.runAllTimersAsync();
    expect((await pages).map((page) => page?.fetchClass)).toEqual(
      Array(5).fill("ok"),
    );
    expect(starts).toEqual([0, 60_000, 62_000, 64_000, 66_000, 68_000]);
  });

  it("defers the refused URL when its cooldown exceeds the chunk deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "600" });
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    expect(await crawlPage(PAGE_URL, 0, false, throttle)).toBeNull();
    expect(
      await crawlPage(`${PAGE_URL}/unvisited`, 0, false, throttle),
    ).toBeNull();
    expect(throttle.stopped).toBe(false);
    expect(pageFetches(fetchMock)).toHaveLength(1);
  });

  it("records a final 429 when the requested wait exceeds the audit's cooldown budget", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "3600" });
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    expect((await crawlPage(PAGE_URL, 0, false, throttle))?.fetchClass).toBe(
      "rate_limited",
    );
    expect(throttle.stopped).toBe(true);
    expect(pageFetches(fetchMock)).toHaveLength(1);
  });

  it("does not retry a 403 — bot protection is not a speed limit", async () => {
    const fetchMock = stubFetch({ status: 403 });

    const page = await crawl();

    expect(pageFetches(fetchMock)).toHaveLength(1);
    expect(page?.fetchClass).toBe("blocked");
  });

  it("preserves extracted metadata and nested values when releasing the HTML", async () => {
    // The metadata is parsed out of a page body, so the fetch is stubbed per-URL
    // rather than per-call: the SSRF guard's DoH lookups need a **dns-json** reply,
    // and answering them with HTML makes `.json()` throw — which fails closed as
    // `blocked`. `mockResolvedValue` on one value cannot tell the two apart.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        if (isDnsLookup(input)) return Promise.resolve(dnsResponse());
        return Promise.resolve(
          new Response(
            `<html><head>
            <title>Example &amp; café 🌱</title>
            <meta name="description" content="Example description &amp; more">
            <meta name="robots" content="noindex">
            <meta property="og:title" content="Example social title 🌱">
            <meta property="og:description" content="Example description">
            <meta property="og:image" content="/social.png">
            <link rel="canonical" href="/canonical">
            <link rel="alternate" hreflang="en" href="/en">
            <script type="application/ld+json">{}</script>
          </head><body><h1>Hello</h1><h2>World</h2>
            <img src="/photo.png" alt="Example photo 🌱"><img src="/missing.png">
            <img alt="">
            <a href="/next" rel="nofollow">More &amp; more 🌱</a>
            <a href="https://other.example/">External</a>
          </body></html>`,
            {
              headers: {
                "content-type": "text/html",
                "x-robots-tag": "nofollow",
                link: '<https://example.com/header>; rel="canonical"',
              },
            },
          ),
        );
      }),
    );

    const page = await crawlPage(
      "https://example.com/",
      2,
      true,
      createCrawlThrottle(Date.now() + 90_000),
    );

    expect(page).toMatchObject({
      url: "https://example.com/",
      statusCode: 200,
      fetchClass: "ok",
      redirectUrl: null,
      title: "Example & café 🌱",
      metaDescription: "Example description & more",
      canonicalUrl: "https://example.com/canonical",
      robotsMeta: "noindex",
      xRobotsTag: "nofollow",
      headerCanonicalUrl: "https://example.com/header",
      ogTitle: "Example social title 🌱",
      ogDescription: "Example description",
      ogImage: "/social.png",
      h1Count: 1,
      h2Count: 1,
      h3Count: 0,
      headingOrder: [1, 2],
      isHtml: true,
      imagesTotal: 3,
      imagesMissingAlt: 1,
      images: [
        { src: "/photo.png", alt: "Example photo 🌱" },
        { src: "/missing.png", alt: null },
        { src: null, alt: "" },
      ],
      links: [
        {
          targetUrl: "https://example.com/next",
          anchor: "More & more 🌱",
          isInternal: true,
          isNofollow: true,
        },
        {
          targetUrl: "https://other.example/",
          anchor: "External",
          isInternal: false,
          isNofollow: false,
        },
      ],
      hasStructuredData: true,
      hreflangTags: ["en"],
      isIndexable: false,
      crawlDepth: 2,
      inSitemap: true,
    });
    expect(page?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page?.htmlBytes).toBeGreaterThan(0);
  });

  it("does not retain large source HTML in queued crawl results", () => {
    // A dedicated V8 process makes GC available without depending on the test
    // runner's heap. Exercise the real reader/parser with separate streamed
    // bodies; keeping just their titles used to retain every 1 MiB document.
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { crawlPage } from ${JSON.stringify(new URL("./site-audit-workflow-helpers.ts", import.meta.url).href)};
          import { createCrawlThrottle } from ${JSON.stringify(new URL("../lib/audit/crawl-throttle.ts", import.meta.url).href)};
          const throttle = createCrawlThrottle(Date.now() + 90_000);
          globalThis.fetch = async (input) => {
            // The SSRF guard resolves the host first, and an HTML reply to a DoH
            // query fails json() -- which fails closed, so this case would measure
            // the memory of a refused page instead of a fetched one.
            const url = new URL(String(input));
            if (url.hostname === "cloudflare-dns.com") {
              return new Response(
                JSON.stringify({
                  Status: 0,
                  Answer: [{ type: 1, data: "93.184.216.34" }, { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }],
                }),
                { status: 200, headers: { "content-type": "application/dns-json" } },
              );
            }
            const html = '<title>Example memory regression 🌱</title>' +
              '<meta name="description" content="A small description">' +
              '<script>' + 'x'.repeat(1024 * 1024) + '</script>';
            const bytes = new TextEncoder().encode(html);
            let offset = 0;
            return new Response(new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 65536));
                offset += 65536;
              },
            }), { headers: { "content-type": "text/html" } });
          };
          const collect = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            globalThis.gc();
            globalThis.gc();
            const { heapUsed, external } = process.memoryUsage();
            return heapUsed + external;
          };
          await crawlPage("https://example.com/warmup", 0, true, throttle);
          const before = await collect();
          const pages = [];
          for (let i = 0; i < 50; i++) {
            pages.push(await crawlPage("https://example.com/" + i, 0, true,
              createCrawlThrottle(Date.now() + 90_000)));
          }
          const retained = (await collect()) - before;
          assert.equal(pages.length, 50);
          assert.equal(pages[49].title, "Example memory regression 🌱");
          assert.ok(retained < 16 * 1024 * 1024,
            "Queued results retained " + retained + " bytes of source HTML");
        `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 25_000);
});
