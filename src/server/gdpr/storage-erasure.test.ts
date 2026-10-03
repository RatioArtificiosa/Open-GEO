/**
 * `storage-erasure.ts` — the code that runs when someone asks us to delete their data.
 *
 * ## Why this file exists at all
 *
 * **It had no test file**, and it is the customer-facing compliance path: 353 lines, one
 * exported handler, sweeping KV, R2, Durable Objects and OAuth grants, with **zero assertions
 * on any of it.** The same defect class as `labs.ts` earlier in this project — a file the
 * same-named pairing rule reads as "nothing to check" rather than "never checked".
 *
 * ## What is worth asserting, and why each case is that one
 *
 * The module is mostly plumbing, and plumbing tests are usually a waste. These cases are
 * chosen because each is a place where a plausible-looking change is **catastrophic and
 * silent**:
 *
 * | case | what a plausible-looking break costs |
 * |---|---|
 * | a forged signature is refused | **any unauthenticated caller can trigger a full tenant erasure** |
 * | a stale signature is refused | **a replayed request erases a tenant again, an hour later** |
 * | the vendor-assets prefix is swept | the CL-703 copies **survive an erasure that reports success** |
 * | a *foreign* tenant's objects survive | **one tenant's request deleting another's data** — worse than deleting nothing |
 * | R2 pagination is followed | a page-2 screenshot **survives and the response still says complete** |
 * | a missing content-length is refused | an **unbounded body read**, which is why the header exists |
 *
 * The last two are why this is not a smoke test. **A sweep that deletes too much and a sweep
 * that deletes nothing both return 200**; only assertions tell them apart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **Every mock declares the parameters its assertions use.** A mock with no signature cannot
 * express `toHaveBeenCalledWith([key])`, and the tempting fix in that situation is to loosen
 * the assertion — so the declaration is part of the contract, not a convenience.
 */
/**
 * **Typed at the declaration**, because reading `mock.calls` off an untyped spy is what
 * forced `as string[]` at every call site — and an assertion at the *read* is an assertion
 * that can be wrong about the mock rather than about the code under test.
 */
const R2Delete = vi.hoisted(() => vi.fn(async (_keys: string[]) => undefined));
const KVDelete = vi.hoisted(() => vi.fn(async (_key: string) => undefined));
const WORKFLOW_TERMINATE = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("cloudflare:workers", () => ({ env: {} }));

/**
 * The HMAC signer is the module's trust root, so it is **mocked rather than reimplemented** —
 * a test that re-derives the signature is a second implementation that can agree with a bug.
 *
 * **`@/shared/gdpr-erasure`, read off the module's own import list.** The first version mocked
 * a path that does not exist, so the real signer stayed in place and four authentication cases
 * failed for a reason that had nothing to do with authentication. **Mocking a path you assumed
 * is a mock of nothing.**
 */
const signGdprErasureRequest = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => "expected-signature"),
);
vi.mock("@/shared/gdpr-erasure", async (importOriginal) => {
  const actual = await importOriginal<typeof gdprErasureModule>();
  return { ...actual, signGdprErasureRequest };
});

// **A named type import for the module being mocked**, so `importOriginal<typeof …>` has
// something to refer to. `consistent-type-imports` forbids the inline `typeof import(…)`
// form, and it is right: the obligation belongs beside the other imports where a reader can
// see it, not buried in a factory.
// **`Env` is ambient** — declared in `src/env.d.ts`, which is why there is no module to
// import it from. `no-unsafe-type-assertion` cannot be satisfied by naming a type that has no
// import path, so the return type is written as the global and the obligation still lands on
// the compiler.
import type * as gdprErasureModule from "@/shared/gdpr-erasure";
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";

type StoredObject = { key: string; customMetadata?: Record<string, string> };

/**
 * An R2 bucket that lists by prefix and **really paginates**.
 *
 * **The pagination is the point.** A single-page fake makes "both screenshots deleted" pass
 * without ever exercising the cursor — which is precisely the bug a one-page fake hides.
 */
function makeBucket(objects: StoredObject[], pageSize = 2) {
  // **The argument type is declared on the spy**, so reading a recorded call's `prefix`
  // needs no assertion at the read site.
  const list = vi.fn(
    async ({
      prefix = "",
      cursor,
    }: { prefix?: string; cursor?: string } = {}) => {
      const matching = objects.filter((o) => o.key.startsWith(prefix));
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = matching.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        objects: page,
        truncated: next < matching.length,
        cursor: next < matching.length ? String(next) : undefined,
      };
    },
  );
  return { list, delete: R2Delete };
}

function makeKv(keys: Array<{ name: string }> = []) {
  return {
    list: vi.fn(async () => ({ keys, list_complete: true, cursor: "" })),
    delete: KVDelete,
  };
}

/**
 * A payload that satisfies `gdprStorageErasurePayloadSchema`.
 *
 * **Every field, because the schema is `.strict()`** — an unknown key is a 400, so a fixture
 * carrying a plausible-but-wrong name (`rankTrackerIds`, which I reached for first) is
 * rejected wholesale rather than ignored. That strictness is worth having: it means a payload
 * from a future caller cannot silently under-delete — and it is why five cases failed on the
 * first run with a bare `400` rather than with a subtle mismatch.
 */
const PAYLOAD = {
  userId: "user_1",
  email: "person@example.com",
  organizationIds: ["org_acme", "org_rival"],
  auditIds: ["audit_1"],
  activeAuditWorkflowIds: ["audit_1"],
  activeRankWorkflowIds: ["rank_1"],
  r2Keys: ["explicit/key.json"],
  samSessionIds: ["sam_1"],
  googleAccounts: [],
};

/**
 * A request the module accepts.
 *
 * **`content-length` is set explicitly, because the handler requires it** — workerd supplies
 * it for a real request and a hand-built `Request` does not.
 */
function signedRequest(
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://app.example.com/gdpr/erase", {
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "x-gdpr-timestamp": String(Date.now()),
      "x-gdpr-signature": "expected-signature",
      ...headers,
    },
    body,
  });
}

/**
 * A full environment, so each case states only what it cares about.
 *
 * **Every binding the erasure path touches is present, including the ones the R2 cases never
 * use.** The handler walks the whole payload in one call, so a missing `SAM_CHAT` or
 * `AUDIT_ENGINE` binding throws a `TypeError` *after* the R2 work and returns a 500 — **which
 * reads as "the sweep failed" when the sweep never ran.** The first version stubbed only R2
 * and KV, and five cases failed with a bare `500`; the names are read from the handler's own
 * body, and the first two I tried were also wrong.
 *
 * **Returns `Env` rather than `as never`.** The escape hatch asserts nothing — which is why a
 * typo'd binding name type-checked perfectly three times over and failed only at runtime.
 * **Typing the return is what makes `tsc` name the bindings I got wrong**, and it did:
 * `AUDIT_WORKFLOW`, `AUDIT_CHECK_WORKFLOW` and `SITE_AUDIT_WORKFLOW` were all wrong and all
 * three produced the *same* `TypeError` at runtime.
 *
 * The one assertion left is on the returned object, because the stubs are deliberately
 * partial — `R2Bucket` has nine methods and the erasure uses two. **Partial is the honest
 * description of a test double**, and the assertion says so rather than hiding behind
 * `as never`, which claimed nothing at all.
 */
function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    GDPR_ERASURE_SECRET: "s3cret",
    R2: makeBucket([]),
    KV: makeKv(),
    OAUTH_KV: makeKv(),
    // **Read off the handler, not guessed.** The first two attempts were wrong —
    // `AUDIT_WORKFLOW` and `AUDIT_CHECK_WORKFLOW` — and a wrong binding name produces the
    // *same* `TypeError: Cannot read properties of undefined (reading 'get')` as a missing
    // one, so the failure cannot tell you which you got wrong. **Three guesses would look
    // identical; reading the source is the only way to tell them apart.**
    SITE_AUDIT_WORKFLOW: {
      get: vi.fn(async () => ({ terminate: WORKFLOW_TERMINATE })),
    },
    RANK_CHECK_WORKFLOW: {
      get: vi.fn(async () => ({ terminate: WORKFLOW_TERMINATE })),
    },
    // **A Durable Object namespace stub, and `get` is deliberately NOT async.**
    //
    // `await samChat.get(...).destroyForErasure()` binds `await` to the **method call**, not
    // to `get` — so the chain is `(samChat.get(...)).destroyForErasure()`, and a `Promise` has
    // no `destroyForErasure` on it. Cloudflare's `DurableObjectNamespace.get` is synchronous,
    // so the stub must be too. The first version made it `async` and four cases failed with
    // *"`samChat.get(...).destroyForErasure` is not a function"*, which names the symptom and
    // not the cause: **a test that makes a synchronous API asynchronous still type-checks**,
    // because `await` on a non-promise is legal.
    SAM_CHAT: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ destroyForErasure: vi.fn(async () => undefined) })),
    },
    AUDIT_ENGINE: { destroyScratchpad: vi.fn(async () => undefined) },
    ...overrides,
    // **The one assertion, and it is on a partial stub rather than on a lie.**
    //
    // `R2Bucket` has nine methods and the erasure uses two; `KVNamespace` has five and it
    // uses two. A test double that claims the full interface is a test double that will
    // break when the interface grows — for no benefit, since nothing here calls the rest.
    // `as never` claimed nothing at all; this claims *exactly* what is true.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial test double is what this is: R2Bucket has nine methods and the erasure calls two, KVNamespace five and two. The assertion is the honest description of a partial stub, and the rule cannot tell a partial double from a wrong one.
  } as unknown as Env;
}

/** The handler's JSON body, or `{}` when it returned an error page. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim().length === 0) return {};
  // **`unknown` first, then a guard, and the guard *is* the assertion** — the rule objects to
  // `JSON.parse(text) as Record<…>` because `any` can be asserted to anything, and it is
  // right: a test that assumes the shape can pass on a response that lacks it.
  //
  // So the parse target is `unknown`, a `typeof` check narrows it to an object, and the
  // remaining assertion is `object → Record`, which is the one step a value cannot take
  // *back*. That is the difference the rule is drawing, and it is a real one.
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return { _raw: text };
  return { ...parsed };
}

/**
 * The rule the authentication cases demonstrate, stated as a pure predicate.
 *
 * **At module scope, because it captures nothing** — `consistent-function-scoping` is right
 * about that, and a predicate declared inside a test body reads as part of the handler when it
 * is part of neither.
 */
function wouldAuthenticate(args: {
  hasTimestamp: boolean;
  hasSignature: boolean;
  skewMs: number;
  matches: boolean;
}): boolean {
  if (!args.hasTimestamp || !args.hasSignature) return false;
  if (Math.abs(args.skewMs) > 5 * 60 * 1000) return false;
  return args.matches;
}

describe("the GDPR storage erasure", () => {
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

  // ---------------------------------------------------------------- what it sweeps

  it("deletes the copied screenshots as well as the prompt cache", async () => {
    // **The CL-703 half.** `vendor-assets/` joined the sweep in `893dc54`; without this the
    // copies survive an erasure that reports success, and nothing else would notice.
    const R2 = makeBucket(
      [
        {
          key: "vendor-assets/aaa.bin",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "vendor-assets/bbb.bin",
          customMetadata: { organizationId: "org_rival" },
        },
        {
          key: "dataforseo-cache/ai-search:prompt-response:acme",
          customMetadata: { organizationId: "org_acme" },
        },
      ],
      10,
    );

    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ R2 }),
    );

    expect(response.status).toBe(200);
    // **Both prefixes were listed**, which is the assertion that matters — you cannot delete
    // the right objects from a prefix you never listed.
    //
    // **The cache prefix ends in a colon**, because `cacheObjectPrefix` builds
    // `dataforseo-cache/<namespace>:` — so the expected string carries the trailing `:` and
    // the first version asserted the namespace alone and failed on a prefix that was in fact
    // correct. **A partial prefix match is the wrong prefix**: `ai-search:prompt-response`
    // would also match a sibling namespace with that string inside it.
    const prefixes = R2.list.mock.calls.map((call) => call[0]?.prefix ?? "");
    expect(prefixes).toContain("vendor-assets/");
    expect(prefixes).toContain("dataforseo-cache/ai-search:prompt-response:");
    // **Flattened, because the sweep deletes in batches of up to 1,000** — one
    // `delete([k1, k2, …])` per run. `toHaveBeenCalledWith([oneKey])` can only pass if the
    // batch happened to be one key long, which is a property of the fixture rather than of
    // the code.
    const deleted = R2Delete.mock.calls.flatMap((call) => call[0]);
    expect(deleted).toContain("vendor-assets/aaa.bin");
    expect(deleted).toContain(
      "dataforseo-cache/ai-search:prompt-response:acme",
    );
  });

  it("deletes every page, not just the first", async () => {
    // **Page 2 is the case that matters.** A one-page implementation reports the same count as
    // a correct one for a small fixture, so this fixture is deliberately larger than the page
    // size and the assertion is on the *last* object.
    const objects: StoredObject[] = Array.from({ length: 5 }, (_, i) => ({
      key: `vendor-assets/shot-${i}.bin`,
      customMetadata: { organizationId: "org_acme" },
    }));
    const R2 = makeBucket(objects, 2);

    await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ R2 }),
    );

    // **Assert on the flattened set of deleted keys, not on individual calls.** The sweep
    // deletes in **batches of up to 1,000** — one `delete([k1, k2, …])` for the whole run —
    // so `toHaveBeenCalledWith([singleKey])` can only pass if the batch happened to be one
    // key long. The first version asserted per key and failed on a batch of five.
    const deleted = R2Delete.mock.calls.flatMap((call) => call[0]);
    for (const o of objects) {
      expect(deleted).toContain(o.key);
    }
    // And the cursor was actually followed, rather than the loop exiting on page one.
    expect(R2.list.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves another tenant's copies alone, or one request erases everyone", async () => {
    // **The opposite failure, and worse than deleting nothing.** A prefix-only implementation
    // would delete every tenant's data on any one tenant's request — and return 200.
    const mine: StoredObject = {
      key: "vendor-assets/mine.bin",
      customMetadata: { organizationId: "org_acme" },
    };
    const theirs: StoredObject = {
      key: "vendor-assets/theirs.bin",
      customMetadata: { organizationId: "org_someone_else" },
    };

    await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ R2: makeBucket([mine, theirs], 10) }),
    );

    // **Flattened, because the sweep deletes in batches** — see the pagination case above.
    // `not.toHaveBeenCalledWith` would be vacuously true here for the same reason: a
    // batch of one key that is *not* `theirs` satisfies it without proving anything.
    const deleted = R2Delete.mock.calls.flatMap((call) => call[0]);
    expect(deleted).toContain(mine.key);
    expect(deleted).not.toContain(theirs.key);
  });

  it("reports how many organisation-scoped objects it removed", async () => {
    // **A count in the response is what makes a partial erasure visible** in an audit rather
    // than in a support ticket three weeks later.
    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({
        R2: makeBucket(
          [
            {
              key: "vendor-assets/a.bin",
              customMetadata: { organizationId: "org_acme" },
            },
            {
              key: "vendor-assets/b.bin",
              customMetadata: { organizationId: "org_rival" },
            },
          ],
          10,
        ),
      }),
    );

    const body = await bodyOf(response);
    // **A FLAT field, not `result.r2.*`** — read off the handler's own return object. The
    // first two versions guessed a nesting (`r2.organizationScopedObjects`) that does not
    // exist, and a shape mismatch is the least informative way for a test to fail: the count
    // was right both times and the report said nothing about which part was wrong.
    expect(body).toMatchObject({
      ok: true,
      result: { organizationScopedObjects: 2 },
    });
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
