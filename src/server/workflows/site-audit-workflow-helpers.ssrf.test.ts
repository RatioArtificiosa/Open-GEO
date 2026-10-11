/**
 * `crawlPage`, and the SSRF guard that has to sit in front of the fetch.
 *
 * ## Why this is a separate file from the rest of the crawlPage cases
 *
 * The rest of `site-audit-workflow-helpers.test.ts` describes throttling, retries and
 * metadata extraction — all of them about a fetch that is already allowed to happen.
 * These three are about a fetch that must not: they assert that the resolution guard
 * runs **before** the request, and the reason to separate them is that the guard's cost
 * (two DoH lookups per host) is invisible in the other file once it is shared.
 *
 * More than that: **the first version of the SSRF work was a guard nobody called.**
 * `assertCrawlableTarget` and `resetCrawlDnsBudget` were exported with tests, both were
 * correct, and the crawl still fetched whatever the frontier handed it, because no
 * production path invoked either. A guard that no caller can reach is a guard that
 * passes every test it has — which is why these cases assert on the *wiring* (does a
 * request leave the worker at all?) rather than on the resolver, whose own behaviour is
 * covered in `url-policy.ssrf.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { resetCrawlDnsBudget } from "@/server/lib/audit/url-policy";
import { crawlPage } from "@/server/workflows/site-audit-workflow-helpers";

const PAGE_HTML =
  "<html><head><title>A page</title></head><body><h1>A page</h1></body></html>";

/** A public A and AAAA pair, so the guard has something to admit. */
const PUBLIC_DNS_ANSWER = {
  Status: 0,
  Answer: [
    { type: 1, data: "93.184.216.34" },
    { type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" },
  ],
};

/**
 * The URL a `fetch` call was made with, from either a live argument or a recorded one.
 *
 * `fetch` accepts `string | URL | Request`, and `String(value)` on a `Request` yields
 * `[object Object]` — an assertion built on that can pass for entirely the wrong reason.
 * `no-base-to-string` is right to flag the shortcut, and this narrows properly instead.
 *
 * **One function for both the mock's argument and the recorded call.** The first version
 * of this file had `isDnsLookup(input)` in the mock and `isDnsLookup(call)` in the
 * assertions — two call shapes over one name, so `isDnsLookup(input)` read `input[0]`
 * off a string, got `undefined`, threw, and **the refusal case passed for the wrong
 * reason**: a thrown argument inside the guard's own fetch is indistinguishable from a
 * refused target. Only the positive control, which needs the opposite outcome to be
 * reachable, exposed it.
 */
function requestUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  if (value !== null && typeof value === "object" && "url" in value) {
    return String(value.url);
  }
  throw new Error("fetch was not called with a string, URL, or Request");
}

/** The `URLSearchParams` of a live `fetch` argument, whatever form it arrived in. */
function searchParams(input: unknown): URLSearchParams {
  return new URL(requestUrl(Array.isArray(input) ? input[0] : input))
    .searchParams;
}

/**
 * Is this a DoH lookup, from a live argument or a recorded call?
 *
 * **One function for both, and that is the point.** The first version had
 * `isDnsLookup(input)` in the mock and `isDnsLookup(call)` in the assertions — two
 * call shapes over one name, so the mock's call read `input[0]` off a string, got
 * `undefined`, threw, and **the refusal case passed for the wrong reason**: a throw
 * inside the guard's own fetch is indistinguishable from a refused target. Only the
 * positive control, which needs the opposite outcome reachable, exposed it.
 */
function isDnsLookup(value: unknown): boolean {
  // **`call[0]` when handed a recorded call.** A mock's argument is the request itself,
  // while `mock.calls` is an array of argument tuples — and the two are indistinguishable
  // at runtime, which is exactly how the earlier version went wrong.
  const target: unknown = Array.isArray(value) ? value[0] : value;
  const url = new URL(requestUrl(target));
  return (
    url.hostname === "cloudflare-dns.com" &&
    url.searchParams.has("name") &&
    url.searchParams.has("type")
  );
}

beforeEach(() => {
  // **The resolution cache is per-invocation and keyed by host**, so one case's verdict
  // would otherwise be served to the next. Every case here visits a distinct host, which
  // is the arrangement that keeps the assertions about that host honest.
  resetCrawlDnsBudget();
});

// ------------------------------------------------------- the SSRF guard, at the fetch

/**
 * **The wiring case, and the reason it is separate from the resolver's own tests.**
 *
 * `url-policy.ssrf.test.ts` proves `assertCrawlableTarget` refuses a host that resolves
 * to a private address. It cannot prove anything about *this file*: a guard nobody
 * calls passes every test it has. The first version of the SSRF work exported
 * `assertCrawlableTarget` and `resetCrawlDnsBudget` and **called neither from any
 * production path** — both were tested, both were correct, and the crawl still fetched
 * whatever the frontier handed it.
 *
 * So the assertion is on the observable consequence: a refused target produces no
 * network call and a recorded page that says why, rather than no page at all.
 */
describe("refuses a target whose answer is private", () => {
  /**
   * A DoH reply pointing `host` at `address`, and everything else at the public
   * answer. **Page fetches still get a real page**, or the positive control below
   * would assert on a page whose body was a DNS response.
   */
  function stubDns(points: Record<string, string>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (!isDnsLookup(input)) {
        return Promise.resolve(
          new Response(PAGE_HTML, {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        );
      }
      const address = points[searchParams(input).get("name") ?? ""];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            Status: 0,
            Answer: address
              ? [
                  { type: 1, data: address },
                  { type: 28, data: address },
                ]
              : PUBLIC_DNS_ANSWER.Answer,
          }),
          {
            status: 200,
            headers: { "content-type": "application/dns-json" },
          },
        ),
      );
    });
  }

  it("makes no request and records the refusal, instead of fetching the address", async () => {
    // **The metadata IP, reached by name.** `isCrawlableUrl` is synchronous, so it sees
    // only literals; a hostname whose *answer* is 169.254.169.254 passes it cleanly,
    // and the fetch then leaves from inside Cloudflare's own edge, where the
    // instance's credentials live.
    stubDns({ "evil.example.com": "169.254.169.254" });

    const page = await crawlPage(
      "https://evil.example.com/secret",
      0,
      false,
      createCrawlThrottle(Date.now() + 90_000),
    );

    // **Two calls, both of them DNS.** Not "a request returned an error" — none.
    // An error response is still a request that left the worker, and for an SSRF
    // that is the entire harm, which is why the count is asserted exactly.
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(requestUrl(call[0])).toContain("cloudflare-dns.com");
    }

    // **And the refusal is a page row.** A dropped URL with no row is a URL the
    // report never mentions, which is how a crawl covers less than it claims.
    expect(page).not.toBeNull();
    expect(page?.fetchClass).toBe("blocked");
    expect(page?.statusCode).toBe(0);
    expect(page?.url).toBe("https://evil.example.com/secret");
    void calls;
  });

  it("still fetches a host whose answer is public — the positive control", async () => {
    // Without this, a resolver that refused every host would pass the case above.
    const fetchMock = stubDns({});

    const page = await crawlPage(
      "https://www.example.com/page",
      0,
      false,
      createCrawlThrottle(Date.now() + 90_000),
    );

    // Two DoH lookups and one page fetch. Counting the raw total here is the point:
    // it shows the guard really ran for this fetch, not only that the fetch worked.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestUrl(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "https://www.example.com/page",
    );
    expect(page?.fetchClass).toBe("ok");
    expect(page?.title).toBe("A page");
  });

  it("fails closed when the lookup cannot run, so a broken resolver is not an open door", async () => {
    // **The C1 shape.** `resolveAddressRecords` used to return an empty list on every
    // error path and every caller read that as "nothing private, so it is fine". A
    // DNS timeout attributable to an attacker-controlled blocker admitted the host
    // *because the check could not run*.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.reject(new Error("resolver unreachable")),
    );

    const page = await crawlPage(
      "https://unknown.example.com/page",
      0,
      false,
      createCrawlThrottle(Date.now() + 90_000),
    );

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(page?.fetchClass).toBe("blocked");
    expect(page?.statusCode).toBe(0);
  });
});
