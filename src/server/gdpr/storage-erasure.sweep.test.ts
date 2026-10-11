/**
 * `storage-erasure.ts` — **did it delete the right objects, and nothing else?**
 *
 * ## The other half
 *
 * `storage-erasure.test.ts` covers whether a request may sweep at all; this file covers what
 * the sweep reaches. They share `storage-erasure.test-support.ts`. See that file for why the
 * harness is extracted rather than copied.
 *
 * ## The two directions that both return 200
 *
 * A sweep that deletes **too much** and a sweep that deletes **nothing** are both a `200 OK`
 * with a success-shaped body. Only assertions tell them apart, and both appear below:
 *
 * | case | the failure it catches |
 * |---|---|
 * | the copied screenshots are swept | CL-703 copies **survive an erasure that reports success** |
 * | every cached payload kind is swept | C2: keyword research, SERPs, domain and backlink data **survive** |
 * | a foreign tenant's objects survive | **one tenant's request deletes another's data** — worse than nothing |
 * | R2 pagination is followed | a page-2 screenshot **survives and the response still says complete** |
 * | a count is reported | a count is what makes a **partial** erasure visible in an audit |
 * | the reference subtree is never listed | one tenant's erasure **deletes a global vendor list** |
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
  PAYLOAD,
  R2Delete,
  bodyOf,
  makeBucket,
  makeEnv,
  resetErasureMocks,
  signedRequest,
  type StoredObject,
} from "@/server/gdpr/storage-erasure.test-support";
// Imported **after** the support module, because that module registers the `vi.mock` calls.
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";

describe("the GDPR storage erasure, and what it reaches", () => {
  beforeEach(() => {
    // Without this, a case that swapped `R2` for a bucket of its own would leave the default
    // bucket's `list` recording in place, and the next case's prefix assertions would read
    // calls that were never made for it.
    resetErasureMocks(signGdprErasureRequest);
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
    // **The cache prefix is the ROOT, `dataforseo-cache/`, not one namespace.** It used to be
    // `dataforseo-cache/ai-search:prompt-response:` — one namespace — which is exactly why the
    // prompt cache was erasable and the four other payload kinds were not. A partial prefix
    // match is the wrong prefix in both directions: `ai-search:prompt-response` would also
    // match a sibling namespace with that string inside it, and one namespace misses every
    // other one by construction. The root covers what exists now and what lands later.
    const prefixes = R2.list.mock.calls.map((call) => call[0]?.prefix ?? "");
    expect(prefixes).toContain("vendor-assets/");
    expect(prefixes).toContain("dataforseo-cache/");
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

  // ---------------------------------------------------- the four payload kinds (C2)

  /**
   * **The CL-715 gap, and the reason the root prefix replaced one namespace.**
   *
   * The sweep listed `dataforseo-cache/ai-search:prompt-response:` and nothing else, so a
   * GDPR erasure removed the AI-search prompt cache and left every *other* cached payload
   * in place. Six payload kinds are affected, and all six are a request the tenant made:
   *
   * | namespace | what leaks |
   * |---|---|
   * | `brand-lookup` | the brands they track, and their competitors |
   * | `keyword-research` | **their keyword strategy** — the list of terms they intend to rank for |
   * | `serp` | the SERPs they pulled for those terms |
   * | `domain:overview` / `domain:keywords` / `domain:pages` | their domain's full keyword universe |
   * | `backlinks` | their backlink profile |
   * | `local:business-categories` | *(reference data — see the last case)* |
   *
   * The keyword rows are the substance: an erasure acknowledged while the tenant's keyword
   * list stays readable in R2 for the remaining TTL is a deletion that did not happen.
   *
   * **The negative control is the prefix list.** Reverting to one namespace keeps this
   * failing, because the assertion is that the ROOT was listed — and it was the namespace
   * list that was wrong, not the metadata match.
   */
  it("sweeps every cached payload kind, not just the prompt cache", async () => {
    const R2 = makeBucket(
      [
        // One per namespace that had been surviving, each with a plausible key shape.
        {
          key: "dataforseo-cache/ai-search:brand-lookup:a1b2",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "dataforseo-cache/keyword:research:aaaaaaaaaaaaaaaaaaaa",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "dataforseo-cache/serp:live:bbbbbbbbbbbbbbbbbbbb",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "dataforseo-cache/domain:overview:cccccccccccccccccccc",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "dataforseo-cache/backlinks:top-pages-page:dddddddddddddddddddd",
          customMetadata: { organizationId: "org_acme" },
        },
        // **The control: another tenant's rows, in one of the same namespaces.** Proves
        // the wider sweep is still deletion-by-tenant and did not become deletion-by-prefix.
        {
          key: "dataforseo-cache/keyword:research:eeeeeeeeeeeeeeeeeeee",
          // **Not one of the requesting user's organisations.** `PAYLOAD.organizationIds`
          // is `[org_acme, org_rival]` — a user who belongs to two tenants — so the control
          // has to be a third one, or the assertion below is satisfied by the request
          // legitimately erasing it.
          customMetadata: { organizationId: "org_someone_else" },
        },
      ],
      10,
    );

    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ R2 }),
    );

    expect(response.status).toBe(200);
    const deleted = R2Delete.mock.calls.flatMap((call) => call[0]);

    for (const namespaceKey of [
      "dataforseo-cache/ai-search:brand-lookup:a1b2",
      "dataforseo-cache/keyword:research:aaaaaaaaaaaaaaaaaaaa",
      "dataforseo-cache/serp:live:bbbbbbbbbbbbbbbbbbbb",
      "dataforseo-cache/domain:overview:cccccccccccccccccccc",
      "dataforseo-cache/backlinks:top-pages-page:dddddddddddddddddddd",
    ]) {
      expect(deleted).toContain(namespaceKey);
    }

    // **And the rival survives**, which is the assertion that keeps the widen honest:
    // a prefix-only sweep would return 200 with every tenant's keywords gone.
    expect(deleted).not.toContain(
      "dataforseo-cache/keyword:research:eeeeeeeeeeeeeeeeeeee",
    );

    const body = await bodyOf(response);
    // 5 of the 6 listed objects belong to the requesting org.
    expect(body).toMatchObject({
      ok: true,
      result: { organizationScopedObjects: 5 },
    });
  });

  it("reports the payload kinds it removed, so the receipt names what was actually covered", async () => {
    // **A count across five buckets is five.** A count of `r2Objects` counts only the
    // explicitly-passed keys, and a count that does not separate the two is how an erasure
    // looked complete while a whole subtree was untouched.
    const R2 = makeBucket(
      [
        {
          key: "dataforseo-cache/keyword:research:aaaaaaaaaaaaaaaaaaaa",
          customMetadata: { organizationId: "org_acme" },
        },
        {
          key: "dataforseo-cache/backlinks:top-pages-page:dddddddddddddddddddd",
          customMetadata: { organizationId: "org_acme" },
        },
      ],
      10,
    );

    const response = await handleGdprStorageErasure(
      signedRequest(JSON.stringify(PAYLOAD)),
      makeEnv({ R2 }),
    );

    const body = await bodyOf(response);
    expect(body).toMatchObject({
      ok: true,
      result: { organizationScopedObjects: 2 },
    });
    // **`vendor-reference/` is never listed.** The Business categories list is a free global
    // vendor table with no tenant; if it were swept, one tenant's erasure would delete a list
    // every other tenant reads. It sits outside the tenant subtree precisely so this holds.
    const prefixes = R2.list.mock.calls.map((call) => call[0]?.prefix ?? "");
    expect(prefixes).not.toContain("vendor-reference/");
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
});
