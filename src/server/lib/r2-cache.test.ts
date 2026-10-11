/**
 * `r2-cache.ts` — the two objects that decide what a GDPR erasure can reach.
 *
 * ## Why this file had none
 *
 * The module is six short functions, which is exactly how a compliance-critical module
 * ends up unverified: it reads as too small to need a test, and the failure it holds is
 * invisible at the write site. `setCached` accepted `organizationId` **inside**
 * `metadata: Record<string, string> = {}` — an optional field defaulting to empty — so
 * a call site that forgot it compiled, ran, and produced an object no erasure sweep could
 * ever match. Four of the six call sites had forgotten, and nothing said so until an
 * external audit read the R2 prefix list.
 *
 * **The default value was the defect.** An optional field is a decision not to require
 * one, and here the consequence was a tenant's keyword research surviving their own
 * deletion request for the full cache TTL.
 *
 * ## What these cases are for
 *
 * | case | what breaking it costs |
 * |---|---|
 * | `setCached` refuses a missing tenant | **an unerasable object is written** |
 * | `setCached` stamps the tenant | the sweep matches nothing, **the object survives** |
 * | the reference cache carries no tenant | one tenant's erasure **deletes a global list** |
 * | the two subtrees are disjoint | a sweep in the wrong subtree misses everything |
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **The R2 binding is asserted against `env.R2.put` directly**, because the whole point
 * of the module is which key and which `customMetadata` reach the bucket. A mock of
 * `put` that returns a value but records nothing cannot express any of that.
 */
const R2Put = vi.hoisted(() =>
  vi.fn(
    async (
      _key: string,
      _body: unknown,
      _options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) => undefined,
  ),
);

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      put: R2Put,
      get: vi.fn(async () => null),
    },
  },
}));

// Imported AFTER the mock so `env` resolves to the stub above. The import order is the
// contract, not a style choice: the module reads `env.R2` at call time, not at load time,
// but the hoisted `vi.mock` still has to be registered before the module graph is built.
const {
  CACHE_ROOT_PREFIX,
  REFERENCE_CACHE_ROOT_PREFIX,
  setCached,
  setReferenceCached,
} = await import("@/server/lib/r2-cache");

/** The customMetadata of the last object written, by its cache key. */
async function lastMetadata() {
  const call = R2Put.mock.calls.at(-1);
  if (!call) throw new Error("setCached wrote nothing");
  return {
    key: call[0],
    customMetadata: call[2]?.customMetadata ?? {},
  };
}

beforeEach(() => {
  R2Put.mockClear();
});

describe("the R2 payload cache", () => {
  it("stamps the organizationId on the object, because that is the only field the erasure sweep matches on", async () => {
    await setCached("keyword:research:digest", { rows: [] }, 3600, "org_acme");

    const { key, customMetadata } = await lastMetadata();
    expect(key).toBe("dataforseo-cache/keyword:research:digest");
    expect(customMetadata.organizationId).toBe("org_acme");
    // And the soft-TTL marker is still there — the erasure read path and the sweep both
    // depend on it, and a stamp added *instead of* an existing field is a silent regression.
    expect(Date.parse(customMetadata.expiresAt ?? "")).toBeGreaterThan(
      Date.now(),
    );
  });

  it("refuses to write an object with no tenant, instead of writing one no erasure can reach", async () => {
    // **The contract, and the negative control for the whole C2 change.**
    //
    // The old signature was `metadata: Record<string, string> = {}`, so a caller could
    // omit the tenant, the write succeeded, and the object matched no sweep. Throwing
    // makes the omission loud at the call site instead of silent for the TTL's lifetime.
    //
    // Called with the tenant omitted at runtime, which is what the old optional
    // `metadata` field allowed: no type error, a successful write, an unerasable object.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      setCached("keyword:research:digest", { rows: [] }, 3600, ""),
    ).rejects.toThrow(/organizationId/);
    // **And nothing was written.** A throw that still persists would leave the unerasable
    // object behind while reporting a failure.
    expect(R2Put).not.toHaveBeenCalled();
  });

  it("puts tenant payloads under the root prefix the erasure sweep lists", async () => {
    // The other half of C2: writing to a subtree nobody sweeps is the same defect as
    // writing with no stamp. The sweep in `storage-erasure.ts` lists
    // `CACHE_ROOT_PREFIX`, so these two strings have to stay equal.
    await setCached("serp:live:digest", { items: [] }, 600, "org_acme");

    expect((await lastMetadata()).key).toBe(
      "dataforseo-cache/serp:live:digest",
    );
    expect(CACHE_ROOT_PREFIX).toBe("dataforseo-cache/");
  });

  it("keeps extra metadata alongside the tenant stamp, since the AI-search copier adds fields", async () => {
    await setCached(
      "ai-search:prompt-response:digest",
      { status: "success" },
      600,
      "org_acme",
      { modelSlug: "chatgpt" },
    );

    const { customMetadata } = await lastMetadata();
    expect(customMetadata.modelSlug).toBe("chatgpt");
    expect(customMetadata.organizationId).toBe("org_acme");
  });
});

describe("the R2 reference cache", () => {
  it("writes to a different subtree, outside everything an erasure reaches", async () => {
    // The Google Business category list is free, global and identical for every
    // caller. Sweeping it would let one tenant delete a list everyone reads, so it
    // lives under its own root — and this case is the assertion that the two roots
    // are genuinely disjoint rather than a prefix of one another.
    await setReferenceCached("local:business-categories:digest", [], 86400);

    const { key } = await lastMetadata();
    expect(key.startsWith(REFERENCE_CACHE_ROOT_PREFIX)).toBe(true);
    expect(key.startsWith(CACHE_ROOT_PREFIX)).toBe(false);
  });

  it("stamps no organizationId, because no organization owns the payload", async () => {
    // **The mirror image of the tenant stamp, and the reason these are two functions**
    // rather than two arguments to one. A stamp here would drag a global vendor table
    // into one tenant's erasure blast radius, and the signature has to make that
    // impossible rather than merely discouraged.
    await setReferenceCached("local:business-categories:digest", [], 86400);

    const { customMetadata } = await lastMetadata();
    expect(customMetadata.organizationId).toBeUndefined();
    // Still expires, so the reference table is not written once and kept forever.
    expect(Date.parse(customMetadata.expiresAt ?? "")).toBeGreaterThan(
      Date.now(),
    );
  });
});
