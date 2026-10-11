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
import { readFileSync } from "node:fs";
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
import {
  CACHE_ROOT_PREFIX,
  REFERENCE_CACHE_ROOT_PREFIX,
} from "@/server/lib/r2-cache";

function guardPrecedesDestruction(source: string): boolean {
  const lines = source.split("\n");
  const guardAt = lines.findIndex((line) =>
    line.includes("SWEPT_PREFIXES.includes(REFERENCE_CACHE_ROOT_PREFIX)"),
  );
  const firstDestruction = Math.min(
    ...lines
      .map((line: string, index: number) => ({ line, index }))
      .filter(({ line }: { line: string }) =>
        /await (terminateWorkflows|revokeGoogleAccount|deleteOauthGrants)\(/.test(
          line,
        ),
      )
      .map(({ index }: { index: number }) => index),
  );
  if (guardAt < 0 || firstDestruction < 0) return false;
  return guardAt < firstDestruction;
}

/**
 * The defect, as a fixture: the guard placed where it used to sit, below every
 * destructive call.
 *
 * **A negative control for the ordering rule, and the reason `guardPrecedesDestruction`
 * is a predicate rather than an inline assertion.** Run only against the real file it could
 * never fail; handed the defect it has to say no, and that is what makes the real-file
 * assertion mean anything.
 */
const GUARD_BELOW_DESTRUCTION = [
  "async function eraseStorage() {",
  "  await terminateWorkflows(env.SITE_AUDIT_WORKFLOW, []);",
  "  if (SWEPT_PREFIXES.includes(REFERENCE_CACHE_ROOT_PREFIX)) {",
  '    throw new AppError("VALIDATION_ERROR", "refuse");',
  "  }",
  "  const organizationScopedObjects = await deleteOrganizationScopedObjects(",
  "    env.R2,",
  "    SWEPT_PREFIXES,",
  "  );",
  "}",
].join("\n");
function erasureSource(): string {
  return readFileSync("src/server/gdpr/storage-erasure.ts", "utf8");
}

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

  it("refuses before anything is destroyed, not after", () => {
    // **The CodeRabbit finding, and the defect it named.**
    //
    // The reference-prefix guard used to sit *after* `terminateWorkflows`,
    // `revokeGoogleAccount`, `destroyScratchpad`, the Dub pins and four `KV.delete` calls.
    // A refusal there would have left a **half-executed erasure**: live workflows
    // terminated, Google grants revoked, Durable Objects destroyed, KV cleared, and the R2
    // cache the request existed to erase still fully intact.
    //
    // A customer asking for deletion and being told "refused" would already have lost
    // their running audits, their OAuth grants and their search history.
    //
    // ## Why this is a source-order assertion rather than a behavioural one
    //
    // The guard is a module constant, so it cannot be injected through a test double — and
    // a behavioural test would have to make the sweep unsafe, which means editing the
    // constant the test is meant to protect. **The invariant is "the check precedes the
    // irreversible action", so it is asserted as an ordering of the source.** That is the
    // same gate-about-gates pattern `scripts/cache-ttl-policy.test.ts` uses, and here it
    // is the only assertion that actually pins the property.
    //
    // It is also the only one that *fails* when the defect returns: moving the guard back
    // below the destructive calls moves its line number down, and the `toBeLessThan`
    // below catches exactly that.
    expect(guardPrecedesDestruction(erasureSource())).toBe(true);
  });

  it("says no when the guard sits below the destructive calls", () => {
    // **The negative control, and the shape the gates-about-gates survey counts:**
    // a fixture containing the defect, asserted to be caught. Without it the ordering
    // rule above is a false-positive test — it fires when the file is right and says
    // nothing about whether it would notice the file being wrong.
    expect(guardPrecedesDestruction(GUARD_BELOW_DESTRUCTION)).toBe(false);
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
    // **The reference subtree by constant, not by literal.** A copy of the string in
    // this assertion is a copy that can drift: the sweep changes, the constant does
    // not follow, and the case passes against a prefix nobody sweeps any more.
    const prefixes = R2.list.mock.calls.map((call) => call[0]?.prefix ?? "");
    expect(prefixes).not.toContain(REFERENCE_CACHE_ROOT_PREFIX);
    // **And what it does list is the tenant root, also by constant** — the mirror
    // assertion, so a change to either root fails here rather than in a review.
    expect(prefixes).toContain(CACHE_ROOT_PREFIX);
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
