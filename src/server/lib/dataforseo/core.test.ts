import { afterEach, describe, expect, it, vi } from "vitest";

// The transport reads DEMO_MODE (via demo-mode -> getOptionalEnvValue) before
// authenticating, so a partial mock of runtime-env must supply both getters.
// Demo mode is off here, which is the default this suite wants.
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { dataforseoPost } from "@/server/lib/dataforseo/core";
// The URL a mocked `fetch` was called with. `fetch` takes a string, a `URL` or a
// `Request`, and `Request` stringifies to `[object Object]` — so a path assertion built
// on `String(call)` would pass for entirely the wrong reason. `endpoint-path-gate.test.ts`
// re-exports this for exactly that reason.
import { requestUrl } from "./test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DataForSEO transport", () => {
  it("retries a transient 5xx on idempotent reads and returns the parsed envelope", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream failure", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status_code: 20000, tasks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      dataforseoPost("/v3/backlinks/summary/live", []),
    ).resolves.toEqual({ status_code: 20000, tasks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Basic encoded-credentials",
    );
  });

  // The request-deadline abort arrives as a bare DOMException. Left unclassified
  // it escapes as an anonymous INTERNAL_ERROR; retrying it would replay a call
  // DataForSEO may already have billed. Both names are reachable: the shared
  // budget aborts with TimeoutError, Lighthouse's own controller with AbortError.
  it.each(["TimeoutError", "AbortError"])(
    "maps a %s abort to UPSTREAM_UNAVAILABLE without retrying",
    async (name) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("aborted", name));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        dataforseoPost("/v3/serp/google/organic/live/advanced", []),
      ).rejects.toMatchObject({
        code: "UPSTREAM_UNAVAILABLE",
        name: "DataForSEOTimeoutError",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  /**
   * The path this file's requests go to, pinned by name.
   *
   * `endpoint-path-gate.test.ts` requires every client path to be asserted by the
   * **same-named** test file, because a wrong URL passes every behavioural test and fails
   * only on a billed request. It was reported as unasserted when a sibling file exercised
   * the path instead — **the gate was right and the assertion was in the wrong file.**
   *
   * **Self-contained on purpose.** The first version read
   * `vi.mocked(fetch).mock.calls[0]` from whatever ran before it, which is why it failed:
   * the other cases in this file restore their mocks, so there was no call left to read.
   * A test whose subject is "which URL did we send" has to send one itself.
   */
  it("pins the endpoint path its requests use", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await dataforseoPost("/v3/appendix/user_data", []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // `requestUrl` takes the **mock**, not the argument — it unwraps the
    // string/URL/Request union itself, which is the whole reason it exists.
    expect(requestUrl(fetchMock)).toContain("/v3/appendix/user_data");

    vi.unstubAllGlobals();
  });
});
