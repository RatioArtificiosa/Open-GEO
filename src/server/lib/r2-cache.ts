import { env } from "cloudflare:workers";
import { sortBy } from "remeda";

/**
 * Cache TTL constants in seconds.
 */
export const CACHE_TTL = {
  /** Related keyword research results */
  researchResult: 86400,
} as const;

/**
 * Root prefix for cached vendor payloads that belong to a **tenant**.
 *
 * Exported for one reason: the GDPR erasure sweep has to list this whole subtree.
 * It used to list one namespace — `ai-search:prompt-response` — which meant every
 * *other* namespace's objects (brand lookup, keyword research, SERP rows, domain
 * overview, backlinks) survived an erasure untouched. Listing the root covers
 * namespaces that exist now and ones added later, and `customMetadata.organizationId`
 * is still the only thing that decides deletion, so a whole-subtree sweep cannot
 * delete another tenant's rows.
 */
export const CACHE_ROOT_PREFIX = "dataforseo-cache/";

/**
 * Root prefix for cached vendor **reference** data — payloads with no tenant.
 *
 * A separate subtree, not a second parameter on `setCached`. The Google Business
 * category list is free, global and identical for every caller; stamping it with
 * whichever tenant happened to warm it would make one customer's erasure delete a
 * list everybody else is using, and leaving it in the tenant subtree under no
 * stamp would leave an object there that no sweep can reason about.
 *
 * It is deliberately outside `CACHE_ROOT_PREFIX`, so the erasure sweep never sees
 * it. That is the correct behaviour: it contains no personal data.
 */
export const REFERENCE_CACHE_ROOT_PREFIX = "vendor-reference/";

const CACHE_PREFIX = CACHE_ROOT_PREFIX;

export const AI_SEARCH_PROMPT_CACHE_NAMESPACE = "ai-search:prompt-response";

/**
 * **`cacheObjectPrefix` was removed, deliberately.**
 *
 * It built `dataforseo-cache/<namespace>:` and existed so a caller could list one
 * namespace. The only caller was the GDPR erasure sweep, and listing one namespace is
 * precisely the defect C2 fixes: the prompt cache was erasable and the five other payload
 * kinds were not, because there was a function that handed out the narrow prefix and no
 * equivalent for the others.
 *
 * A cache key is built with `buildCacheKey(namespace, params)`, which already returns the
 * full `namespace:digest` string, so there is nothing left for a prefix helper to do. Leaving
 * it exported would leave the exact tool that produced the bug sitting one import away.
 */

/**
 * Build a deterministic cache key from an endpoint slug and input params.
 * Uses a SHA-256 digest for stability across runtimes.
 */
export async function buildCacheKey(
  prefix: string,
  params: Record<string, unknown>,
): Promise<string> {
  const raw = JSON.stringify(
    Object.fromEntries(sortBy(Object.entries(params), ([key]) => key)),
  );

  return `${prefix}:${await sha256Hex(raw)}`;
}

/**
 * Get a cached JSON value from R2. Returns null on miss or expiry.
 * Callers should validate the shape with Zod before trusting it — schema
 * drift between writes and reads is otherwise silent.
 */
export async function getCached(key: string): Promise<unknown> {
  const obj = await env.R2.get(`${CACHE_PREFIX}${key}`);
  if (!obj) return null;

  const expiresAt = obj.customMetadata?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) return null;

  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

/**
 * Store a JSON value in R2 with a soft TTL via custom metadata.
 *
 * ## `organizationId` is a required argument, not part of `metadata`
 *
 * It is required **positionally** because the module used to accept it inside
 * `metadata: Record<string, string> = {}` and default to empty — and a default
 * empty is exactly the failure this closes. Four call sites were found that
 * cached vendor payloads without stamping a tenant:
 *
 *   • brand-lookup        (brandLookup.ts)
 *   • keyword research    (research.ts)
 *   • SERP rows            (serp.ts)
 *   • local SEO categories
 *
 * Every one of those is a D1-shaped archive of a **DataForSEO response**, which
 * is exactly what `storage-erasure.ts` deletes by prefix sweep under
 * `dataforseo-cache/…` for the tenant named in `customMetadata`. With no stamp,
 * `deleteOrganizationScopedObjects` matches nothing, the object survives every
 * erasure request for the lifetime of the cache TTL, and the tenant's keywords
 * remain readable from R2 after a GDPR delete has been acknowledged.
 *
 * `PromptExplorer` already passed the field — inside the metadata object — and
 * that is the only reason the AI-search prompt cache is erasable.
 *
 * The parameter is required so a new cache writer cannot be added without
 * answering "whose is this?". The alternative — an optional field with a default
 * empty — is the shape that produced the bug, and the comment beside
 * `vendorAssetCopy` already names the outcome: *an object without one survives
 * every erasure request and looks identical to one that does not.*
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttlSeconds: number,
  organizationId: string,
  metadata: Record<string, string> = {},
): Promise<void> {
  if (!organizationId) {
    // Not a guard against a typo so much as against the default: this write is
    // what makes an object erasable, and an erasable object needs an owner.
    throw new Error(
      "setCached needs an organizationId: R2 objects without a tenant cannot be",
    );
  }
  await env.R2.put(`${CACHE_PREFIX}${key}`, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      ...metadata,
      organizationId,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    },
  });
}

/**
 * Get a cached JSON value from the reference subtree. Returns null on miss or expiry.
 */
export async function getReferenceCached(key: string): Promise<unknown> {
  const obj = await env.R2.get(`${REFERENCE_CACHE_ROOT_PREFIX}${key}`);
  if (!obj) return null;

  const expiresAt = obj.customMetadata?.expiresAt;
  if (expiresAt && Date.parse(expiresAt) < Date.now()) return null;

  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

/**
 * Store a tenant-less JSON value in the reference subtree with a soft TTL.
 *
 * There is no `organizationId` parameter because there is no organization: use
 * `setCached` for anything shaped by or derived from one customer's request.
 */
export async function setReferenceCached<T>(
  key: string,
  data: T,
  ttlSeconds: number,
): Promise<void> {
  await env.R2.put(
    `${REFERENCE_CACHE_ROOT_PREFIX}${key}`,
    JSON.stringify(data),
    {
      httpMetadata: { contentType: "application/json" },
      // **No `organizationId` here on purpose.** A stamp would put a global vendor
      // list inside one tenant's erasure blast radius.
      customMetadata: {
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      },
    },
  );
}

/**
 * Compute a deterministic SHA-256 digest for cache keys.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
