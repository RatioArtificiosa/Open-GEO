/**
 * Copy a vendor screenshot into our own storage, inside the request cycle.
 *
 * ## Why this module exists at all
 *
 * DataForSEO serves Lighthouse screenshots from a **one-day** URL. Put that URL in a
 * customer's report and the image works today and 404s tomorrow — and in the meantime the
 * report makes requests to a URL the customer never chose, from a vendor they never contracted
 * with. `vendor-image-guard.test.ts` is the gate that stops a raw vendor URL reaching a
 * client; **this is the thing that makes the guard's rule satisfiable**, because without a copy
 * the only alternative is not showing the screenshot at all.
 *
 * ## The posture, not a workaround
 *
 * §B.5 of the master reference records the highest-severity open risk: the vendor's own
 * support agent *could not locate an authoritative Terms of Service page* governing storage,
 * caching, reselling and retention. Its fourth mitigation — the only one engineering can act
 * on — is *"treat all DFS data as ephemeral by default, store aggregates and derived scores
 * rather than raw dumps, and keep the raw-answer archive behind a retention policy."*
 *
 * **So this module IS that step, and it is deliberately the most defensive version of it:**
 *
 * - **our own URL is the only thing that can be stored** — the vendor's never survives the
 *   call, so there is no row anywhere holding a URL that expires;
 * - **our copy expires too, and sooner.** A screenshot is evidence of a moment; a report
 *   claiming to show last quarter's screenshot is showing a reconstruction. `COPY_TTL_DAYS` is
 *   a *feature* limit rather than a copy of the vendor's.
 * - **a failed copy is a feature that does not exist, not a degraded one.** There is no
 *   vendor-URL fallback anywhere in this file, and that is the whole point: a fallback is the
 *   leak.
 *
 * ## Why the copy happens inline rather than in a sweep
 *
 * A background sweep would mean a window in which a raw vendor URL is persisted and a
 * client can reach it. **"Within the request cycle" is the requirement, and a copier that
 * runs later is a copier that runs after the leak.**
 */
import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";

/**
 * How long *our* copy lives.
 *
 * **30 days, and deliberately not the vendor's 1.** The vendor's URL is a delivery mechanism;
 * ours is the product's retention decision, and the two are separate policies. Keeping them
 * equal would tie our data lifecycle to a vendor's CDN cache header, which is not a contract.
 *
 * **It is also shorter than the audit retention**, so a screenshot cannot outlive the audit
 * that produced it — a report whose audit has been purged must not still be showing an image
 * that audit produced.
 */
export const COPY_TTL_DAYS = 30;
const COPY_TTL_SECONDS = COPY_TTL_DAYS * 86_400;

/**
 * Where our copies live.
 *
 * **Exported, and imported by `gdpr/storage-erasure.ts` rather than re-typed there.** A
 * prefix duplicated across the writer and the deleter is a prefix that drifts the first time
 * one of them is renamed — and the deleter would go on deleting nothing while reporting
 * success. **One definition, two readers, and the compiler checks the second.**
 */
export const VENDOR_ASSET_PREFIX = "vendor-assets";

/**
 * The host we will copy from, and the only one.
 *
 * **An allowlist, not a denylist.** A denylist of `*.dataforseo.com` would also match a
 * marketing page a customer links to, and a future vendor host would be copied from by
 * default — **the failure mode of every gate this session was a check that matched too much,
 * so the safe shape here is the one that has to be extended deliberately.**
 */
const ALLOWED_HOSTS = new Set([
  "api.dataforseo.com",
  "pagespeed.dataforseo.com",
]);

export type CopyOutcome =
  /** Copied. `key` is ours and only ours is ever returned. */
  | { status: "copied"; key: string; bytes: number; expiresAt: string }
  /** The URL is not a vendor image URL, so there is nothing to copy. */
  | { status: "not-a-vendor-image"; reason: string }
  /** The vendor URL did not resolve to bytes. */
  | { status: "copy-failed"; reason: string };

/** Our own URL for a stored copy, and the only one a client may be handed. */
export function storedAssetUrl(key: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${VENDOR_ASSET_PREFIX}/${key}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The R2 key for a vendor URL.
 *
 * **Hashed, so the key cannot leak the vendor URL into a listing.** A key built from the URL
 * would put `api.dataforseo.com/...` inside our own storage listing, which is the leak one
 * layer removed — and §B.5's retention posture says our storage should not accumulate the
 * vendor's identity either.
 */
export function assetKey(vendorUrl: string): string {
  return `${sha256Hex(vendorUrl)}.bin`;
}

/**
 * Copy one vendor image into our storage and return *our* key.
 *
 * **Never returns the vendor URL.** That is the property the whole module exists for, and it
 * is why the return type has no field a caller could put in an `<img src>`.
 *
 * **`organizationId` is required, and that is what makes erasure possible.** The GDPR sweeper
 * in `storage-erasure.ts` lists a prefix and deletes the objects whose
 * `customMetadata.organizationId` is in the payload — **so a copy without one is invisible to
 * it, and a prefix sweep added later would still delete nothing.** That is the same defect
 * class as a sweep shipped with nothing invoking it: **a retention policy with no code behind
 * it is a comment.**
 *
 * **Required rather than optional on purpose.** An optional `organizationId` is a parameter
 * every caller passes `undefined`, and the resulting object is unerasable while looking
 * identical to an erasable one.
 */
export async function copyVendorAsset(
  vendorUrl: string,
  owner: { organizationId: string },
): Promise<CopyOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(vendorUrl);
  } catch {
    return { status: "not-a-vendor-image", reason: "not a URL" };
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    // **Reported, not silently skipped.** A screenshot that silently did not copy is a
    // feature that is mysteriously absent, and the first version returned `not-a-vendor-image`
    // for anything unparseable *and* for an unapproved host, which are different problems.
    return {
      status: "not-a-vendor-image",
      reason: `host ${parsed.hostname} is not an approved vendor host`,
    };
  }

  const key = assetKey(vendorUrl);

  let response: Response;
  try {
    response = await fetch(parsed.toString(), { redirect: "follow" });
  } catch (error) {
    return {
      status: "copy-failed",
      reason: `fetch threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      status: "copy-failed",
      reason: `vendor responded ${response.status}`,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const expiresAt = new Date(
    Date.now() + COPY_TTL_SECONDS * 1000,
  ).toISOString();

  try {
    await env.R2.put(`${VENDOR_ASSET_PREFIX}/${key}`, bytes, {
      httpMetadata: { contentType: contentTypeFor(parsed) },
      customMetadata: {
        expiresAt,
        // **The tenant, first — because it is the only field that makes this object
        // erasable.** `storage-erasure.ts` matches on it to decide what a GDPR request
        // deletes, so an object without one survives every erasure request and looks
        // identical to one that does not.
        organizationId: owner.organizationId,
        // **The source host, not the URL.** Enough to answer "which vendor did this come
        // from" for an audit trail without storing an expiring link, and short enough that
        // §B.5's defensive posture holds for our own bucket too.
        sourceHost: parsed.hostname,
        copiedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    // **A storage failure is `copy-failed`, never a vendor URL handed back.** The caller has
    // to see "there is no screenshot" rather than "here is one, for a day".
    return {
      status: "copy-failed",
      reason: `R2 put failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { status: "copied", key, bytes: bytes.byteLength, expiresAt };
}

function contentTypeFor(url: URL): string {
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  // **JPEG is the default because the vendor's `final-screenshot` is a `.jpg`**, and a
  // default of `application/octet-stream` would make a browser download the image instead of
  // rendering it — a copy that works and displays nothing.
  return "image/jpeg";
}
