import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * The DataForSEO base-URL override, and the contract that makes it safe to use.
 *
 * **The operational fact this file exists for:** the live DataForSEO account held
 * **$1** when this was written. One mis-shaped request costs real money, and a
 * full end-to-end run — one patrol, one nightly capture, one audit — costs far
 * more than the account held. `DATAFORSEO_BASE_URL` points the whole client at
 * the sandbox, which validates every request exactly as production does (auth,
 * envelope, task limits, rate gates) and returns canned rows **at zero cost**.
 *
 * The whole point of that is that it must fail *loudly* when misconfigured: a
 * sandbox run that silently falls back to production spends the $1 on a
 * benchmark. So the assertions below are about the mistakes, not the happy path.
 */

vi.mock("@/server/lib/runtime-env", () => ({
  // **Both getters, or the mock is a missing-variable error.** The transport
  // reads the API key first, so a mock supplying only `getOptionalEnvValue`
  // fails with "Missing required environment variable: DATAFORSEO_API_KEY"
  // rather than with anything about the base URL. This is `concurrency.test.ts`'s
  // documented shape, and it is the same failure twice.
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { DATAFORSEO_SANDBOX_URL, dataforseoPost } from "./core";

const PATH = "/v3/dataforseo_labs/google/bulk_traffic_estimation/live";

/**
 * The URL a fetch actually went to, from the one call `dataforseoPost` makes.
 *
 * `String(calls[0]?.[0])` trips `no-base-to-string`: `fetch` is stubbed with
 * `vi.fn()` so its argument is typed as the loose `RequestInfo | URL`, and the
 * linter cannot know it holds a string. Asserting the argument **is a string**
 * both narrows the type and fails a test that stops fetches by URL — which is the
 * only thing this helper is for.
 */
function calledUrl(): string {
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls).toHaveLength(1);
  const url: unknown = calls[0]?.[0];
  // Narrowing by assertion rather than by cast, because `no-unsafe-type-assertion`
  // bans the narrowing assertion this would otherwise need — and because asserting
  // the *type* is a real check: the day `dataforseoPost` stops building a URL
  // string, this file fails with "expected 'object' to be 'string'" instead of
  // with a confusing comparison against "[object Object]".
  if (typeof url !== "string") {
    throw new Error(`fetch was called with a non-string URL: ${typeof url}`);
  }
  return url;
}

const { getOptionalEnvValue } = await import("@/server/lib/runtime-env");

describe("DATAFORSEO_BASE_URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getOptionalEnvValue).mockClear();
  });

  it("uses production when the variable is unset", async () => {
    // **The default is production, deliberately.** An operator who forgets to set
    // this spends real money; an operator who forgets to *unset* it gets fixture
    // data. The second is the more visible mistake, so it is the one this leans on.
    vi.mocked(getOptionalEnvValue).mockResolvedValueOnce(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await dataforseoPost(PATH, [{}]);

    expect(calledUrl()).toBe(`https://api.dataforseo.com${PATH}`);
  });

  it("uses the sandbox host when the variable names it", async () => {
    vi.mocked(getOptionalEnvValue).mockResolvedValueOnce(
      DATAFORSEO_SANDBOX_URL,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await dataforseoPost(PATH, [{}]);

    expect(calledUrl()).toBe(`${DATAFORSEO_SANDBOX_URL}${PATH}`);
  });

  it("reads the variable by name, so a typo cannot silently pick production", async () => {
    // A mis-typed variable name is the failure this guards: `getOptionalEnvValue`
    // returns undefined for a name that is not set, which is indistinguishable
    // from "not set on purpose". Asserting the *name* means the call site and the
    // documented name stay in lockstep.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await dataforseoPost(PATH, [{}]);

    expect(vi.mocked(getOptionalEnvValue)).toHaveBeenCalledWith(
      "DATAFORSEO_BASE_URL",
    );
  });

  it("rejects a value with no scheme instead of falling back", async () => {
    // **The load-bearing one.** A bare host (`sandbox.dataforseo.com`) is a
    // plausible copy-paste, and treating it as "not set" would run the
    // benchmark against production with the $1 still in the account. The only
    // safe behaviours are the documented ones; anything else throws.
    vi.mocked(getOptionalEnvValue).mockResolvedValueOnce(
      "sandbox.dataforseo.com",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await expect(dataforseoPost(PATH, [{}])).rejects.toThrow(
      /must be an absolute http\(s\) URL/,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects an empty string rather than treating it as production", async () => {
    // `DATAFORSEO_BASE_URL=` in a `.env` is an empty value, and `getOptionalEnvValue`
    // already skips empty strings — so this documents the other side: an empty
    // value must not reach the override branch at all.
    vi.mocked(getOptionalEnvValue).mockResolvedValueOnce("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await dataforseoPost(PATH, [{}]);

    expect(calledUrl()).toBe(`https://api.dataforseo.com${PATH}`);
  });

  it("lets an explicit baseUrl argument win over the env var", async () => {
    // Precedence: argument → env var → production. The argument is the narrowest
    // declaration and is what the test stubs use (`concurrency.test.ts` runs the
    // whole gate against a local server) and what `serp-location-validate.ts`
    // pins to the sandbox so a location check never bills regardless of the
    // ambient setting.
    vi.mocked(getOptionalEnvValue).mockResolvedValueOnce(
      DATAFORSEO_SANDBOX_URL,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );

    await dataforseoPost(PATH, [{}], { baseUrl: "http://127.0.0.1:1" });

    expect(calledUrl()).toBe(`http://127.0.0.1:1${PATH}`);
  });
});
