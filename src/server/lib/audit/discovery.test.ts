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

    const result = await fetchLlmsTxt(ORIGIN);

    expect(requestedUrl(fetchMock.mock.calls[0])).toBe(
      "https://acme.com/llms.txt",
    );
    expect(result.status).toBe("found");
    // **Asserted in two steps, not with `expect.stringContaining`.** An
    // asymmetric matcher returns `any`, and an `any` inside an object literal is
    // an unsafe assignment the lint rule is right to reject — the type system
    // cannot check the assertion, so neither can anyone reading it.
    if (result.status !== "found") throw new Error("expected found");
    expect(result.body).toContain("- [Docs](/docs)");
  });

  it("distinguishes an absent file from an unreachable host", async () => {
    // **The distinction the whole tagged result exists for.** A 404 is the site
    // saying "there is no such file", which is a fixable fact about their markup.
    // A refused connection says nothing about their markup at all. Reporting the
    // second as the first tells a customer their site is undescribed when the
    // truth is that our network failed.
    fetchMock.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    const absent = await fetchLlmsTxt(ORIGIN);

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const unreachable = await fetchLlmsTxt(ORIGIN);

    expect(absent).toEqual({ status: "absent" });
    expect(unreachable.status).toBe("unreachable");
    if (unreachable.status !== "unreachable")
      throw new Error("expected unreachable");
    expect(unreachable.reason).toContain("ECONNREFUSED");
  });

  it("treats a 410 as absent and a 5xx as unreachable", async () => {
    // 410 means "gone on purpose", which is a fact about the site. A 5xx means the
    // server is having a bad day, which is not.
    fetchMock.mockResolvedValueOnce(new Response("", { status: 410 }));
    expect(await fetchLlmsTxt(ORIGIN)).toEqual({ status: "absent" });

    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    const serverError = await fetchLlmsTxt(ORIGIN);
    expect(serverError.status).toBe("unreachable");
    if (serverError.status !== "unreachable")
      throw new Error("expected unreachable");
    expect(serverError.reason).toContain("503");
  });

  it("never reads the body of a 404, which would be an HTML error page", async () => {
    // **The bug this guards.** Reading it would hand the checker a page of HTML,
    // which reports no title and no links — a fabricated finding against a site
    // that simply does not publish the file.
    fetchMock.mockResolvedValue(
      new Response("<html>Not found</html>", { status: 404 }),
    );

    expect(await fetchLlmsTxt(ORIGIN)).toEqual({ status: "absent" });
  });

  it("strips newlines from a fetch failure before it reaches a report", async () => {
    // The reason string is rendered in a customer-facing report, and a proxy
    // returning HTML would otherwise put a forged line into it.
    fetchMock.mockRejectedValue(new Error("upstream said\n\nERROR: forged"));

    const result = await fetchLlmsTxt(ORIGIN);
    if (result.status !== "unreachable")
      throw new Error("expected unreachable");
    expect(result.reason).not.toMatch(/[\r\n]/);
    expect(result.reason).toContain("forged");
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

  it("caps an oversized body while reading, not after buffering it", async () => {
    // `text()` buffers the whole response before any trim applies, so capping
    // afterwards limits what we *return* and not what we *hold*. A server
    // answering /llms.txt with a gigabyte would be read into a Worker before the
    // cap ever applied; the streamed reader stops and cancels at the limit.
    fetchMock.mockResolvedValue(new Response("y".repeat(512 * 1024)));

    const result = await fetchLlmsTxt(ORIGIN);
    if (result.status !== "found") throw new Error("expected found");
    expect(result.body.length).toBe(125 * 1024);
  });

  it("reads a body delivered in several chunks", async () => {
    // A real response arrives piecewise. Joining them is the reader's job and a
    // test that only ever sees one chunk would not notice it failing to.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("# Acme\n"));
        controller.enqueue(new TextEncoder().encode("\n- [Docs](/docs)\n"));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const result = await fetchLlmsTxt(ORIGIN);
    if (result.status !== "found") throw new Error("expected found");
    expect(result.body).toBe("# Acme\n\n- [Docs](/docs)\n");
  });

  it("cancels the stream once the cap is reached, so the socket closes", async () => {
    // **This is the difference between capping and not capping.** Releasing the
    // lock hands the stream back with the connection still open and the origin
    // still sending; cancelling tells it we are done. A server that keeps pushing
    // megabytes at a Worker that has already stopped reading is a resource cost
    // that a mutation to `releaseLock()` would reintroduce silently — which is
    // why the cancel is observed rather than assumed.
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // More than the cap, and it never ends on its own: only a cancel stops it.
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));

    const result = await fetchLlmsTxt(ORIGIN);
    if (result.status !== "found") throw new Error("expected found");

    expect(cancelled).toBe(true);
    expect(result.body.length).toBe(125 * 1024);
  });
});
