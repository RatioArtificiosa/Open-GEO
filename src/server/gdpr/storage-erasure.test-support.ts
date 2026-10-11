/**
 * The harness both erasure test halves run against.
 *
 * ## Why this is a separate file
 *
 * `storage-erasure.test.ts` grew past `eslint/max-lines` once the C2 payload-kind cases
 * landed, and the honest split is the one the file already had inside it: **authentication**
 * cases ("may this request sweep at all?") and **sweep** cases ("did it delete the right
 * objects?"). They need exactly the same doubles — a bucket that really paginates, an env
 * whose bindings are named right, a payload the schema accepts — so the choice was a shared
 * harness or two copies of one.
 *
 * Two copies is the worse option and not only for the duplication: the harness is where the
 * **plausible-but-wrong** names live. `AUDIT_WORKFLOW` and `AUDIT_CHECK_WORKFLOW` were both
 * wrong and both produced the same runtime `TypeError`, and the reason the current names are
 * right is that they were read off the handler's body. A copy of that work is someone else
 * re-guessing.
 *
 * The conventions here follow `src/server/lib/dataforseo/test-support.ts`, which exists for
 * the same reason: a mock whose shape you cannot assert on is a mock that cannot fail.
 */
import { vi } from "vitest";

// **No `vi.mock` calls in here, on purpose.**
//
// Vitest hoists `vi.mock` into the *importing* test file's module graph. Both halves
// register the same two mocks themselves and import these spies from here, so the
// recordings are shared while the registration is local — that split is exactly the
// constraint that "Cannot export hoisted variable" is telling us about, and fighting it
// would mean duplicating the fns instead.

/**
 * The recorded spies.
 *
 * **Plain `vi.fn()` at module scope, not `vi.hoisted`.**
 *
 * Vitest will not let a `vi.hoisted` value cross a helper module — the loader refuses the
 * import with *"Cannot export hoisted variable"*, which is a constraint on where hoisting
 * may happen, not on whether the spy works. Nothing in the `vi.mock` factories registered
 * by the test files references these three, so there is no temporal-dead-zone problem to
 * solve and nothing to hoist past.
 *
 * **Every mock declares the parameters its assertions use.** A mock with no signature cannot
 * express `toHaveBeenCalledWith([key])`, and the tempting fix in that situation is to loosen
 * the assertion — so the declaration is part of the contract, not a convenience.
 *
 * **Typed at the declaration**, because reading `mock.calls` off an untyped spy is what
 * forced `as string[]` at every call site — and an assertion at the *read* is an assertion
 * that can be wrong about the mock rather than about the code under test.
 */
export const R2Delete = vi.fn(
  async (_keys: string[]): Promise<void> => undefined,
);
export const KVDelete = vi.fn(async (_key: string): Promise<void> => undefined);
export const WORKFLOW_TERMINATE = vi.fn(async (): Promise<void> => undefined);

/**
 * Clears every recording between cases, and re-arms the signer.
 *
 * **The signer is passed in, not imported.** It has to be created with `vi.hoisted` in each
 * test file — the `vi.mock` factory that closes over it runs above the module body, so a
 * hoisted declaration is the only one that is initialised in time. Keeping it here instead
 * would put the factory's referent in a module the factory is not registered in.
 */
export function resetErasureMocks(signer: {
  mockResolvedValue: (value: string) => void;
}) {
  vi.clearAllMocks();
  signer.mockResolvedValue("expected-signature");
}

/**
 * An R2 bucket that lists by prefix and **really paginates**.
 *
 * **The pagination is the point.** A single-page fake makes "both screenshots deleted" pass
 * without ever exercising the cursor — which is precisely the bug a one-page fake hides.
 */
export type StoredObject = {
  key: string;
  customMetadata?: Record<string, string>;
};

export function makeBucket(objects: StoredObject[], pageSize = 2) {
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
export const PAYLOAD = {
  userId: "user_1",
  email: "person@example.com",
  // **Two organisations, on purpose.** A user can belong to more than one tenant, and a
  // sweep that only erased one would under-delete quietly. It also means a "foreign tenant"
  // control has to be a *third* id — see the sweep tests.
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
export function signedRequest(
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
export function makeEnv(overrides: Record<string, unknown> = {}): Env {
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
export async function bodyOf(
  response: Response,
): Promise<Record<string, unknown>> {
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
export function wouldAuthenticate(args: {
  hasTimestamp: boolean;
  hasSignature: boolean;
  skewMs: number;
  matches: boolean;
}): boolean {
  if (!args.hasTimestamp || !args.hasSignature) return false;
  if (Math.abs(args.skewMs) > 5 * 60 * 1000) return false;
  return args.matches;
}
