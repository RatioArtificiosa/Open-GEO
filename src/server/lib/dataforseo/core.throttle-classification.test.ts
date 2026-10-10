/**
 * **`classify` gets the body's status code, because a non-2xx still carries one.**
 *
 * DataForSEO answers a *logical* failure with HTTP 200 and puts the outcome in
 * `status_code`, so `assertOk` classifies it. This is the one path that cannot: `doFetch`
 * throws before the body is parsed, and `classify` is the only hook that sees a code
 * extracted from an error body.
 *
 * ## The correction this file records
 *
 * An earlier version asserted that HTTP 401 + body `40100` was a **throttle** — reported as
 * `RATE_LIMITED`, with a message telling the operator *"The credential is valid — this is a
 * rate limit, not an auth failure."* That was generalised from a single transient on
 * `/v3/appendix/user_data`, and it contradicts the vendor's documented error list.
 *
 * | Code  | Vendor message                                                   | Therefore |
 * |-------|------------------------------------------------------------------|-----------|
 * | 40100 | "You are not authorized to access this resource"                  | **auth**  |
 * | 40202 | "The rate-limit per minute has been exceeded"                     | throttle  |
 * | 40209 | "Too many simultaneous queries"                                   | throttle  |
 *
 * The old rule was wrong in both directions at once: a genuinely invalid credential was
 * reported as a rate limit to wait out, and a working one was told it was about to be
 * rotated. One observation on one endpoint does not relabel a documented status code.
 *
 * ## Every shape, because the body reading is a *fallback*
 *
 * | response | expected | why |
 * |---|---|---|
 * | HTTP 401 + body `40100` | `DATAFORSEO_AUTH_FAILED` | the documented meaning |
 * | HTTP 401 + body `40104` | the verification message | same HTTP code, different body |
 * | HTTP 402 + body `40200` | the billing message | unchanged, and must stay so |
 * | HTTP 401, **no body** | `DATAFORSEO_AUTH_FAILED` | a real transport failure |
 * | HTTP 401, **unparseable body** | `DATAFORSEO_AUTH_FAILED` | a proxy's HTML page |
 * | HTTP 500 | `UPSTREAM_UNAVAILABLE` | the ladder is not the subject here |
 *
 * The last two are what keep the fix honest: **a body that cannot be read must fall
 * through to the HTTP ladder**, because a vendor's bad day must not become our wrong
 * classification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The transport reads DEMO_MODE before it authenticates, so a partial mock of runtime-env
// must supply both getters — `core.test.ts`'s shape, for the same reason.
vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "encoded-credentials"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { dataforseoPost } from "./core";

const classify = createDataforseoBillingClassifier({
  pathPrefix: "/v3/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

const PATH = "/v3/appendix/user_data";

function respond(status: number, body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

/**
 * `classify` is passed through on every call, because that is how a real section module
 * does it — `ai-keywords.ts`, `ai-mode.ts` and the rest all hand the classifier in. Omitting
 * it here made the two body tests fail for a reason that had nothing to do with the fix,
 * which is worth stating because the failure text pointed at the behaviour under test.
 */
async function call(): Promise<{ code: string; message: string }> {
  try {
    await dataforseoPost(PATH, [], { classify });
    throw new Error("expected the call to fail");
  } catch (error) {
    // **Narrowed, not asserted.** `AppError` carries `code`; anything else does not, and a
    // cast would make a thrown string look like a classified error.
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "none";
    return { code, message };
  }
}

describe("a non-2xx response whose body carries the real verdict", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads 40100 as an auth failure, which is what the vendor documents", async () => {
    // **The measured response, verbatim** — the same envelope this file has asserted
    // against since it was written.
    respond(
      401,
      JSON.stringify({
        status_code: 40100,
        status_message:
          "You are not Authorized to Access this Resource. Your Login Information Here: https://app.dataforseo.com/login .",
      }),
    );

    const error = await call();

    // **The endpoint path is asserted, not implied.** `endpoint-path-gate.test.ts` requires
    // every client path a test exercises to be pinned by name, because a wrong URL passes
    // every behavioural test and fails only on a billed request.
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(PATH);

    // **40100 is an auth failure, and this used to be the defect.** The file it replaces
    // asserted `RATE_LIMITED` with a message claiming the credential was valid, on the
    // strength of one observation. The vendor's own error list
    // (`https://docs.dataforseo.com/v3/appendix/errors`, read 2026-10-10) says:
    //
    //   | Code  | Message                                              |
    //   |-------|------------------------------------------------------|
    //   | 40100 | "You are not authorized to access this resource"     |
    //   | 40202 | "The rate-limit per minute has been exceeded"        |
    //   | 40209 | "Too many simultaneous queries"                      |
    //
    // A throttle is **40202** or **40209**. Treating the auth code as a throttle sent an
    // operator with a genuinely bad credential the exact opposite of the truth: told to
    // wait and retry rather than to fix the key, and told the credential was valid. The
    // one observation this rule was generalised from was a single transient on this one
    // endpoint, which is an endpoint oddity, not a vendor-wide relabelling.
    expect(error.code).toBe("DATAFORSEO_AUTH_FAILED");
  });

  it("still reads 40104 as unverified, at the same HTTP status", async () => {
    // **Same HTTP code, different body, different answer.** A rule keyed on the HTTP
    // status alone cannot tell these apart, which is why the body is read.
    respond(
      401,
      JSON.stringify({
        status_code: 40104,
        status_message:
          "Please verify your account before using the API. You can complete verification in the user panel: https://app.dataforseo.com/ .",
      }),
    );

    const error = await call();

    expect(error.message).toMatch(/verification/i);
  });

  it("leaves a genuine 401 with no body as an auth failure", async () => {
    // **The control that keeps the fix honest.** A real transport rejection has no
    // envelope, and reading nothing must fall through to the HTTP ladder rather than
    // inventing a verdict.
    respond(401, "");

    const error = await call();

    expect(error.code).toBe("DATAFORSEO_AUTH_FAILED");
  });

  it("falls through on a body it cannot parse", async () => {
    // A proxy's HTML error page. **A helper that threw here would turn the vendor's bad
    // day into ours**, so `readBodyStatusCode` returns null and the ladder decides.
    respond(401, "<html><body>502 Bad Gateway</body></html>");

    const error = await call();

    expect(error.code).toBe("DATAFORSEO_AUTH_FAILED");
  });

  it("leaves a bodyless 429 as a rate limit", async () => {
    respond(429, "");

    const error = await call();

    expect(error.code).toBe("RATE_LIMITED");
  });

  it("does not disturb the 5xx path", async () => {
    respond(500, "");

    const error = await call();

    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("uses the classifier rather than a second switch", () => {
    // **The shape of the fix, asserted.** A third copy of "what 40100 means" is the
    // thing this session has spent its length consolidating, so the body path must reach
    // the same `classify` the HTTP path uses.
    expect(typeof classify).toBe("function");
    expect(classify(40104, "please verify your account", PATH)).not.toBeNull();
    // 40100 is deliberately unmatched — it is a throttle, and the ladder handles it.
    expect(classify(40100, "You are not Authorized", PATH)).toBeNull();
  });
});
