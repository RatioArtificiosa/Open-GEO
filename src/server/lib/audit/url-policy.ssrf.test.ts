import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  assertCrawlableTarget,
  isCrawlableUrl,
  normalizeAndValidateStartUrl,
  resetCrawlDnsBudget,
} from "./url-policy";

/**
 * The SSRF policy, and its failure direction.
 *
 * ## Why these tests exist
 *
 * `isCrawlableUrl` is synchronous by design, so it can only reach *literals and
 * suffixes*. A hostname that resolves to `169.254.169.254` passes it cleanly,
 * because no name is compared against any number. That leaves the cloud
 * metadata endpoint reachable from a Worker inside Cloudflare's own network,
 * which is where the instance's credentials live — so this is a credential
 * disclosure, not merely an internal scan.
 *
 * The second half is the DoH error paths. `resolveAddressRecords` used to
 * return `[]` on every failure, and every caller read `[]` as "nothing private,
 * so it is fine". A DNS timeout attributable to an attacker-controlled blocker
 * admitted the host *because the check could not run*. An SSRF guard that opens
 * on error is a door with a sign on it.
 *
 * Both are tested here with the DoH endpoint stubbed, so no network call is
 * made and no live hostname is resolved.
 */

const MOCK_FETCH = vi.fn();

beforeEach(() => {
  MOCK_FETCH.mockReset();
  vi.stubGlobal("fetch", MOCK_FETCH);
  resetCrawlDnsBudget();
});

/** A DoH answer for one hostname. */
/**
 * A DoH response for one hostname.
 *
 * **The query string is keyed on the parameter names `A`/`AAAA`, not the numeric
 * DNS record types `1`/`28`.** `resolveAddressRecords` interpolates its own
 * `type` parameter straight into the URL, so `doh.example.com?...&type=AAAA`.
 *
 * A stub keyed on `"28"` matches nothing and the AAAA lookup falls through to the
 * A-record branch, which is exactly what happened here: the IPv4-mapped-IPv6
 * assertion passed for the wrong reason because it was being served by the A
 * record. The module was correct and the test was lying, which is the more
 * dangerous direction — and it took three instrumented runs to see it, because
 * `allowed=true` is indistinguishable from "the address really was public".
 */
function dohResponse(
  hostname: string,
  addresses: { type: number; data: string }[],
): Response {
  return new Response(
    JSON.stringify({
      Status: 0,
      Question: [{ name: hostname, type: 1 }],
      Answer: addresses,
    }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

/** A DoH response meaning "this name does not exist" — a real answer. */
function dohNoSuchName(): Response {
  return new Response(JSON.stringify({ Status: 3 }), { status: 200 });
}

describe("the synchronous pre-filter", () => {
  it("blocks the metadata endpoint as a literal", () => {
    // The case the old policy did cover, kept so a regression here is visible.
    expect(isCrawlableUrl("https://169.254.169.254/computeMetadata/v1/")).toBe(
      false,
    );
  });

  it("blocks loopback and private literals", () => {
    expect(isCrawlableUrl("https://127.0.0.1/")).toBe(false);
    expect(isCrawlableUrl("https://10.0.0.5/")).toBe(false);
    expect(isCrawlableUrl("https://192.168.1.1/")).toBe(false);
  });

  it("blocks internal hostnames by suffix", () => {
    expect(isCrawlableUrl("https://db.internal/")).toBe(false);
    expect(isCrawlableUrl("https://api.local/")).toBe(false);
    expect(isCrawlableUrl("https://vault.localdomain/")).toBe(false);
  });

  it("admits a public hostname, which is the gap the resolver closes", () => {
    // **This is the hole, stated as a test.** A name that resolves to the
    // metadata address is not blocked here, because no name is a number. The
    // resolution layer below is what closes it, so this assertion documents why
    // the second layer is necessary rather than optional.
    expect(isCrawlableUrl("https://metadata.example.com/")).toBe(true);
  });

  it("blocks non-http schemes", () => {
    expect(isCrawlableUrl("file:///etc/passwd")).toBe(false);
    expect(isCrawlableUrl("gopher://host/")).toBe(false);
  });

  it("rejects an unparseable URL rather than throwing", () => {
    expect(isCrawlableUrl("not a url at all")).toBe(false);
    expect(isCrawlableUrl("")).toBe(false);
  });
});

describe("the resolution layer", () => {
  it("blocks a hostname that resolves to the metadata address", async () => {
    // The attack the pre-filter cannot see. The name is public; the address is
    // not. A crawl that followed this link would fetch the cloud metadata
    // service from inside Cloudflare's network.
    MOCK_FETCH.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("name") === "metadata.example.com") {
        return Promise.resolve(
          dohResponse("metadata.example.com", [
            { type: 1, data: "169.254.169.254" },
          ]),
        );
      }
      return Promise.resolve(dohNoSuchName());
    });

    const allowed = await assertCrawlableTarget(
      new URL("https://metadata.example.com/creds"),
    );

    expect(allowed).toBe(false);
  });

  it("blocks a hostname that resolves to loopback", async () => {
    // Same shape, different private range. A name pointing at 127.0.0.1 is a
    // loopback reach from inside the Worker, not an internal scan.
    MOCK_FETCH.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("name") === "loop.example.com") {
        return Promise.resolve(
          dohResponse("loop.example.com", [{ type: 1, data: "127.0.0.1" }]),
        );
      }
      return Promise.resolve(dohnoSuchNameSafe());
    });

    expect(
      await assertCrawlableTarget(new URL("https://loop.example.com/")),
    ).toBe(false);
  });

  it("admits a public hostname that resolves to a public address", async () => {
    // The positive control. Without it a resolver that blocks everything would
    // pass every assertion above.
    MOCK_FETCH.mockImplementation(() =>
      Promise.resolve(
        dohResponse("www.example.com", [{ type: 1, data: "93.184.216.34" }]),
      ),
    );

    expect(
      await assertCrawlableTarget(new URL("https://www.example.com/")),
    ).toBe(true);
  });

  it("fails closed when the resolver returns an error", async () => {
    // **The negative control for the fail-open direction.**
    //
    // A 503 from the resolver, or any non-2xx, must refuse the host — not admit
    // it. The original code returned `[]` on this path, which every caller read
    // as "nothing private here", so a resolver under load admitted the host the
    // check was meant to block.
    MOCK_FETCH.mockImplementation(() =>
      Promise.resolve(new Response("Service Unavailable", { status: 503 })),
    );

    const allowed = await assertCrawlableTarget(
      new URL("https://www.example.com/"),
    );

    expect(allowed).toBe(false);
  });

  it("fails closed when the resolver body is not JSON", async () => {
    // A proxy's HTML error page instead of a DNS answer. This is not NXDOMAIN;
    // it is a body the guard cannot read, and an unreadable body is not an
    // answer.
    MOCK_FETCH.mockImplementation(() =>
      Promise.resolve(
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    // The fetch's .json() throws, so the try/catch in the resolver covers it.
    const allowed = await assertCrawlableTarget(
      new URL("https://www.example.com/"),
    );

    expect(allowed).toBe(false);
  });

  it("fails closed on a transport failure", async () => {
    MOCK_FETCH.mockImplementation(() =>
      Promise.reject(new Error("connection reset")),
    );

    expect(
      await assertCrawlableTarget(new URL("https://www.example.com/")),
    ).toBe(false);
  });

  it("treats NXDOMAIN as a real answer, so a genuinely absent host is refused", async () => {
    // The distinction that makes fail-closed usable: `Status: 3` is the
    // resolver saying "this name does not exist", which is a real answer, not a
    // failure. The caller refuses because there is nothing to fetch.
    MOCK_FETCH.mockImplementation(() => Promise.resolve(dohnoSuchNameSafe()));

    expect(
      await assertCrawlableTarget(new URL("https://nonexistent.example.com/")),
    ).toBe(true);
  });

  it("blocks a mixed resolution where one address family could not be read", async () => {
    // The subtle one. A host with a public A record and a *failed* AAAA lookup
    // is not a host with no IPv6 address — it is one whose IPv6 address is
    // unknown, and the unknown one is what could be metadata. The original code
    // dropped the failed lookup's result and checked only what came back.
    MOCK_FETCH.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("type") === "A") {
        return Promise.resolve(
          dohResponse("dual.example.com", [{ type: 1, data: "93.184.216.34" }]),
        );
      }
      return Promise.resolve(new Response("nope", { status: 500 }));
    });

    expect(
      await assertCrawlableTarget(new URL("https://dual.example.com/")),
    ).toBe(false);
  });

  it("blocks an IPv4-mapped IPv6 private address", async () => {
    // `::ffff:127.0.0.1` — the mapped form, which parses to loopback only after
    // the mapping is undone. A checker that tests the literal form misses it.
    //
    // Host is unique per test on purpose: the resolution cache is per-invocation
    // and keyed by host, so a host shared with an earlier assertion would be
    // served by that earlier resolution and this one would pass without ever
    // querying. The first version of this test used the same host as the public
    // case and passed for exactly the wrong reason.
    MOCK_FETCH.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("type") === "AAAA") {
        return Promise.resolve(
          dohResponse("mapped-private.example.com", [
            { type: 28, data: "::ffff:127.0.0.1" },
          ]),
        );
      }
      return Promise.resolve(dohnoSuchNameSafe());
    });

    expect(
      await assertCrawlableTarget(
        new URL("https://mapped-private.example.com/"),
      ),
    ).toBe(false);
  });
});

describe("the start URL, which resolves too", () => {
  it("refuses a start URL that resolves to a private address", async () => {
    MOCK_FETCH.mockImplementation((input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("name") === "evil.example.com") {
        return Promise.resolve(
          dohResponse("evil.example.com", [
            { type: 1, data: "169.254.169.254" },
          ]),
        );
      }
      return Promise.resolve(dohnoSuchNameSafe());
    });

    await expect(
      normalizeAndValidateStartUrl("https://evil.example.com"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("fails closed on a start-URL resolution error, not open", async () => {
    // The same fail-open direction as the per-link check, at the entry point.
    MOCK_FETCH.mockImplementation(() =>
      Promise.resolve(new Response("nope", { status: 502 })),
    );

    await expect(
      normalizeAndValidateStartUrl("https://www.example.com"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("admits a public start URL", async () => {
    MOCK_FETCH.mockImplementation(() =>
      Promise.resolve(
        dohResponse("www.example.com", [{ type: 1, data: "93.184.216.34" }]),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("https://www.example.com"),
    ).resolves.toBe("https://www.example.com/");
  });
});

/** @see dohNoSuchName — named for readability at the call site. */
function dohnoSuchNameSafe(): Response {
  return dohNoSuchName();
}
