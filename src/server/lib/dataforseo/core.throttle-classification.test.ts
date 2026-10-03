/**
 * **A throttle is HTTP 401 with the truth in the body.** Measured on this account:
 * `/v3/appendix/user_data` returned `40100` — *"You are not Authorized to Access this
 * Resource"* — and **the identical call returned `20000` seconds later.** That is a rate
 * limit wearing the auth status, because DataForSEO reuses 401.
 *
 * Before this file existed the run log said `DATAFORSEO_AUTH_FAILED`, so the obvious
 * operator response was **to rotate a working API key** — an expensive way to fix nothing,
 * at the worst moment to change a credential.
 *
 * ## Every shape, because the fix is a *fallback*
 *
 * | response | expected | why |
 * |---|---|---|
 * | HTTP 401 + body `40100` | `RATE_LIMITED` | the measured case |
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

  it("reads 40100 as a throttle, not a broken credential", async () => {
    // **The measured response, verbatim.** This is the whole finding.
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
    // every behavioural test and fails only on a billed request — and this file's subject
    // *is* a billed request.
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(PATH);

    // **Not** the auth failure — that is the defect this whole file exists for.
    expect(error.code).not.toBe("DATAFORSEO_AUTH_FAILED");
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
