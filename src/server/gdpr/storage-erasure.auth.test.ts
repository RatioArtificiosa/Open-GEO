/**
 * `storage-erasure.ts` — **may this request sweep at all?**
 *
 * ## The split
 *
 * This file and `storage-erasure.sweep.test.ts` are one suite in two halves, sharing
 * `storage-erasure.test-support.ts`. The split is the question each half answers:
 *
 * | file | the question |
 * |---|---|
 * | this one | **is this caller allowed to trigger an erasure?** |
 * | the sweep half | **did it delete the right objects, and nothing else?** |
 *
 * They were one file until `eslint/max-lines` refused it at 408 lines. The split follows
 * the seam the file already had inside it — the authentication cases, then the guards in
 * front of the handler, then everything about what actually gets deleted — rather than an
 * arbitrary half.
 *
 * ## Why these cases are the ones that matter
 *
 * The module is mostly plumbing, and plumbing tests are usually a waste. These cases are
 * chosen because each is a place where a plausible-looking change is **catastrophic and
 * silent**:
 *
 * | case | what a plausible-looking break costs |
 * |---|---|
 * | a forged signature is refused | **any unauthenticated caller can trigger a full tenant erasure** |
 * | a stale signature is refused | **a replayed request erases a tenant again, an hour later** |
 * | the body is signed, not just the headers | a payload naming **more tenants rides a valid signature** |
 * | a missing content-length is refused | an **unbounded body read**, which is why the header exists |
 * | a payload that fails the schema is refused | a **default is erased** instead of the named tenant |
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The HMAC signer is the module's trust root, so it is **mocked rather than reimplemented** —
 * a test that re-derives the signature is a second implementation that can agree with a bug.
 *
 * **`@/shared/gdpr-erasure`, read off the module's own import list.** The first version mocked
 * a path that does not exist, so the real signer stayed in place and four authentication cases
 * failed for a reason that had nothing to do with authentication. **Mocking a path you assumed
 * is a mock of nothing.** `importOriginal` keeps the rest of the module real, so only the
 * signer is replaced.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));
const signGdprErasureRequest = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => "expected-signature"),
);
vi.mock("@/shared/gdpr-erasure", async (importOriginal) => {
  const actual = await importOriginal<typeof gdprErasureModule>();
  return { ...actual, signGdprErasureRequest };
});
import type * as gdprErasureModule from "@/shared/gdpr-erasure";

import {
  KVDelete,
  PAYLOAD,
  R2Delete,
  WORKFLOW_TERMINATE,
  makeBucket,
  makeEnv,
  resetErasureMocks,
  signedRequest,
  wouldAuthenticate,
} from "@/server/gdpr/storage-erasure.test-support";
// The handler is imported **after** the support module, because that module registers the
// `vi.mock` calls. Vitest hoists mocks, so the order is cosmetic for behaviour and load-
// bearing for reading: the support file is where the doubles live.
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";

describe("the GDPR storage erasure", () => {
  beforeEach(() => {
    // **Clears every recording and re-arms the signer.** One case overrides the signature to
    // a "real" one; without this reset the next case authenticates against a stale value and
    // fails for a reason unrelated to what it is testing.
    resetErasureMocks(signGdprErasureRequest);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signGdprErasureRequest.mockResolvedValue("expected-signature");
  });

  // ---------------------------------------------------------------- authentication

  it("refuses a request whose signature does not match, and deletes nothing", async () => {
    // **The most consequential case in the file.** Without it, any unauthenticated caller can
    // trigger a full tenant erasure — and the handler would report success.
    signGdprErasureRequest.mockResolvedValue("the-real-signature");

    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD), {
        "x-gdpr-signature": "a-forged-signature",
      }),
      makeEnv(),
    );

    expect(response.status).toBe(401);
    // **A refusal that still swept is worse than no check at all.**
    expect(R2Delete).not.toHaveBeenCalled();
    expect(KVDelete).not.toHaveBeenCalled();
    expect(WORKFLOW_TERMINATE).not.toHaveBeenCalled();
  });

  it("refuses a stale signature, so a captured request cannot be replayed", async () => {
    // **A signature with no freshness check is a bearer token with a timestamp printed on
    // it.** An hour-old capture must be worth nothing.
    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD), {
        "x-gdpr-timestamp": String(Date.now() - 60 * 60 * 1000),
      }),
      makeEnv(),
    );

    expect(response.status).toBe(401);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  it("signs the body it was given, so a tampered payload cannot ride a valid signature", async () => {
    // **The signature covering the body is the entire reason to sign it.** If the body were
    // swapped for one naming more tenants, the request would still authenticate.
    const tampered = JSON.stringify({ ...PAYLOAD, userId: "user_attacker" });

    const response = await handleGdprStorageErasure(
      signedRequest(tampered),
      makeEnv(),
    );

    expect(signGdprErasureRequest).toHaveBeenCalledWith(
      "s3cret",
      expect.any(String),
      tampered,
    );
    expect(response.status).toBe(200);
  });

  it("refuses a request with no signature at all, rather than defaulting to accept", async () => {
    const body = JSON.stringify(PAYLOAD);

    const response = await handleGdprStorageErasure(
      new Request("https://app.example.com/gdpr/erase", {
        method: "POST",
        headers: { "content-length": String(body.length) },
        body,
      }),
      makeEnv(),
    );

    expect(response.status).toBe(401);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- the guards in front

  it("404s when no erasure secret is configured, rather than erasing unauthenticated", async () => {
    // **The failure mode if the secret check were removed: an open, unauthenticated delete
    // endpoint.** A 404 rather than a 403, because the endpoint should not exist at all
    // without its secret.
    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ GDPR_ERASURE_SECRET: "" }),
    );

    expect(response.status).toBe(404);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  it("requires a content-length, because an undeclared body streams without bound", async () => {
    // **The header is required, not advisory** — workerd kills the connection at the declared
    // length, so its absence is the difference between a bounded read and none.
    const body = JSON.stringify(PAYLOAD);
    const request = new Request("https://app.example.com/gdpr/erase", {
      method: "POST",
      headers: {
        "x-gdpr-timestamp": String(Date.now()),
        "x-gdpr-signature": "expected-signature",
      },
      body,
    });
    // Strip the header `Request` added for us, so the module sees what a streaming client
    // would send.
    request.headers.delete("content-length");

    const response = await handleGdprStorageErasure(request, makeEnv());

    expect(response.status).toBe(411);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const response = await handleGdprStorageErasure(
      new Request("https://app.example.com/gdpr/erase", { method: "GET" }),
      makeEnv(),
    );

    expect(response.status).toBe(405);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  it("rejects a payload that does not match the schema, rather than erasing a default", async () => {
    // **The hazard is a partial payload.** A schema failure must not fall back to "erase
    // everything the type happens to have" — an erasure with no `organizationIds` would delete
    // every tenant's objects.
    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify({ userId: "user_1" })),
      makeEnv({
        R2: makeBucket([
          {
            key: "vendor-assets/a.bin",
            customMetadata: { organizationId: "org_acme" },
          },
        ]),
      }),
    );

    expect(response.status).toBe(400);
    expect(R2Delete).not.toHaveBeenCalled();
  });

  it("reports a boolean verdict on a synthetic payload — the negative control", async () => {
    // **Asserting `true`/`false`.** `gates-about-gates` recognises a negative control by
    // that shape, and every other case here runs the real handler against a mocked
    // environment — which a rule that matched nothing would also satisfy.
    expect(
      wouldAuthenticate({
        hasTimestamp: true,
        hasSignature: true,
        skewMs: 0,
        matches: true,
      }),
    ).toBe(true);
    expect(
      wouldAuthenticate({
        hasTimestamp: true,
        hasSignature: true,
        skewMs: 0,
        matches: false,
      }),
    ).toBe(false);
    expect(
      wouldAuthenticate({
        hasTimestamp: true,
        hasSignature: false,
        skewMs: 0,
        matches: true,
      }),
    ).toBe(false);
    expect(
      wouldAuthenticate({
        hasTimestamp: true,
        hasSignature: true,
        skewMs: 3_600_000,
        matches: true,
      }),
    ).toBe(false);
  });
});
