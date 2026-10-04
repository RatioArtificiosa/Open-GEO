import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLlmsTxt, fetchRobotsTxtText } from "./discovery";

/**
 * The two customer-facing file fetches.
 *
 * **This file exists because neither had a test, and both are the kind of code
 * that fails silently.** Each returns `null` for "no usable body", so a fetch
 * that always threw, one that always timed out, and a site genuinely serving a
 * 404 are *the same value* to every caller. Without a test, a typo in the URL or
 * a broken `AbortSignal` reads as "this site has no robots.txt" — a confident
 * wrong answer about a customer's site, produced by our own bug.
 */

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORIGIN = "https://acme.com";

/**
 * The URL a call was made with.
 *
 * **Narrowed, not stringified.** The `fetch` input is `string | URL | Request`, so
 * `String(x)` on the union risks `[object Object]` for a `Request` — and a test
 * that prints the wrong thing passes or fails for reasons unrelated to the code
 * under test. Reading `.url` off the `URL` branch and off the `Request` branch
 * covers what this codebase actually passes.
 */
function requestedUrl(call: readonly unknown[] | undefined): string | null {
  const input = call?.[0];
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input !== null && typeof input === "object" && "url" in input) {
    const url = input.url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

describe("fetchRobotsTxtText", () => {
  it("asks for the right URL and returns the body", async () => {
    fetchMock.mockResolvedValue(new Response("User-agent: *\nDisallow:\n"));

    const text = await fetchRobotsTxtText(ORIGIN);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestedUrl(fetchMock.mock.calls[0])).toBe(
      "https://acme.com/robots.txt",
    );
    expect(text).toBe("User-agent: *\nDisallow:\n");
  });

  it("identifies itself, so a site owner can see and block the crawl", async () => {
    fetchMock.mockResolvedValue(new Response("User-agent: *\n"));

    await fetchRobotsTxtText(ORIGIN);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({ "User-Agent": "OpenGeo-Audit/1.0" });
  });

  it("returns null for a 404 rather than treating the error page as robots.txt", async () => {
    // **The bug this guards.** Reading the body of a non-OK response would hand the
    // parser a page of HTML, which `robots-parser` would read as *no rules* — and
    // "no rules" means every crawler allowed. A site with a broken robots.txt URL
    // would be reported as fully open to AI crawlers.
    fetchMock.mockResolvedValue(
      new Response("<html>Not found</html>", { status: 404 }),
    );

    expect(await fetchRobotsTxtText(ORIGIN)).toBeNull();
  });

  it("returns null when the request throws, and does not propagate", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    // A throw here would fail the whole audit over one optional file. Every other
    // check is independent of robots.txt.
    expect(await fetchRobotsTxtText(ORIGIN)).toBeNull();
  });

  it("truncates an oversized body instead of holding it all in memory", async () => {
    // A misbehaving server serving megabytes at /robots.txt must not blow the
    // Workflow step's ~1MiB output cap.
    fetchMock.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024)));

    const text = await fetchRobotsTxtText(ORIGIN);

    expect(text?.length).toBe(500 * 1024);
  });
});

describe("fetchLlmsTxt", () => {
  it("asks for the right URL and returns the body", async () => {
    fetchMock.mockResolvedValue(new Response("# Acme\n\n- [Docs](/docs)\n"));

    const text = await fetchLlmsTxt(ORIGIN);

    expect(requestedUrl(fetchMock.mock.calls[0])).toBe(
      "https://acme.com/llms.txt",
    );
    expect(text).toContain("- [Docs](/docs)");
  });

  it("returns null for a 404, which is the common and legitimate case", async () => {
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    // Most sites do not publish one. That is a finding, not a failure, and the
    // report words it that way.
    expect(await fetchLlmsTxt(ORIGIN)).toBeNull();
  });

  it("returns null when the request throws", async () => {
    fetchMock.mockRejectedValue(new Error("ETIMEDOUT"));

    expect(await fetchLlmsTxt(ORIGIN)).toBeNull();
  });

  it("does not follow a redirect, so a 302 to an internal host cannot be reached", async () => {
    // The SSRF guard is `isCrawlableUrl`, which sees one URL at a time. Following
    // redirects would let `/llms.txt` bounce us to an internal address *past* the
    // check — the same reason the crawler uses `redirect: "manual"` per hop.
    fetchMock.mockResolvedValue(new Response("", { status: 302 }));

    await fetchLlmsTxt(ORIGIN);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("uses the same User-Agent as the rest of the crawl", async () => {
    fetchMock.mockResolvedValue(new Response("# Acme"));

    await fetchLlmsTxt(ORIGIN);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(headers).toMatchObject({ "User-Agent": "OpenGeo-Audit/1.0" });
  });

  it("caps an oversized body", async () => {
    fetchMock.mockResolvedValue(new Response("y".repeat(512 * 1024)));

    const text = await fetchLlmsTxt(ORIGIN);

    expect(text?.length).toBe(125 * 1024);
  });
});
