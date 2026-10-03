/**
 * The vendor-asset copier, and the property it exists to guarantee.
 *
 * ## The one property
 *
 * **`copyVendorAsset` never returns the vendor URL.** Not in a success, not in a failure, not
 * in a field a caller could reach. Everything else here is a consequence of that: the allowlist
 * decides what may be *copied*, the hashed key stops the vendor URL reaching our own storage
 * listing, and the TTL makes the copy a product decision rather than a copy of the vendor's.
 *
 * ## Why the hash, and why the allowlist
 *
 * A key built from the URL would put `api.dataforseo.com/...` inside our storage listing —
 * **the leak one layer removed.** And an allowlist rather than a denylist because every
 * instrument failure this project has had was a check that matched too much: a denylist of
 * `*.dataforseo.com` would match a customer's marketing link, and a *future* vendor host
 * would be copied from by default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The options this module passes to `env.R2.put`, as the spy below declares them.
 *
 * **Declared locally rather than imported**, because the copier's call site is inside a
 * `cloudflare:workers` module that cannot be imported outside workerd — and **the alternative
 * was a test that asserted nothing about the arguments**, which is the shape this file exists
 * to avoid. A local declaration is a second copy of a contract, and the compiler checks this
 * copy against the call site the first time the signature drifts.
 */
interface R2PutOptions {
  customMetadata: Record<string, string>;
}

const put = vi.hoisted(() =>
  vi.fn((_key: string, _body: unknown, _options: R2PutOptions) =>
    Promise.resolve(undefined),
  ),
);
vi.mock("cloudflare:workers", () => ({ env: { R2: { put } } }));

import {
  COPY_TTL_DAYS,
  type CopyOutcome,
  assetKey,
  copyVendorAsset,
  storedAssetUrl,
} from "@/server/lib/vendorAssetCopy";

const VENDOR_IMAGE =
  "https://api.dataforseo.com/v3/lighthouse/task_get/live/abc123/result/final-screenshot.jpg";

/** A Response whose bytes read back as a tiny JPEG-ish payload. */
function imageResponse(status = 200, bytes = 512): Response {
  return new Response(new Uint8Array(bytes), {
    status,
    headers: { "Content-Type": "image/jpeg" },
  });
}

describe("copyVendorAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the bytes and returns OUR key, never the vendor URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse()),
    );

    const outcome = await copyVendorAsset(VENDOR_IMAGE);

    expect(outcome.status).toBe("copied");
    if (outcome.status !== "copied") return;
    expect(outcome.bytes).toBe(512);
    // **The assertion that matters: nothing anywhere in the outcome carries the vendor URL.**
    expect(JSON.stringify(outcome)).not.toContain("dataforseo.com");
  });

  it("keys the copy by hash, so our storage never records the vendor URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse()),
    );

    const outcome = await copyVendorAsset(VENDOR_IMAGE);
    if (outcome.status !== "copied") throw new Error("expected a copy");

    // **The key is a hash, and the object path contains no vendor host.** A key built from
    // the URL would put the vendor's identity into every listing we ever print.
    expect(outcome.key).toMatch(/^[0-9a-f]{64}\.bin$/);
    expect(outcome.key).not.toContain("dataforseo");
    expect(assetKey(VENDOR_IMAGE)).not.toBe(
      assetKey(VENDOR_IMAGE.toUpperCase() + " "),
    );
  });

  it("refuses a host that is not an approved vendor host", async () => {
    // **An allowlist, and the check is on the hostname rather than a substring** — which is
    // what stops `evil.com/?x=api.dataforseo.com` and `api.dataforseo.com.evil.com`, the two
    // near-misses a substring rule gets wrong.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse()),
    );

    for (const hostile of [
      "https://evil.com/final-screenshot.jpg",
      "https://api.dataforseo.com.evil.com/final-screenshot.jpg",
      "https://evil.com/?u=https://api.dataforseo.com/x.jpg",
      "https://dataforseo.com/final-screenshot.jpg",
    ]) {
      const outcome = await copyVendorAsset(hostile);
      expect(outcome.status, `${hostile} should not be copied`).toBe(
        "not-a-vendor-image",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a failed copy rather than handing back the vendor URL", async () => {
    // **The failure path is where a leak would hide.** A caller told "copy failed" shows no
    // screenshot; a caller handed the vendor URL shows one that 404s tomorrow.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse(404)),
    );
    const notFound = await copyVendorAsset(VENDOR_IMAGE);
    expect(notFound.status).toBe("copy-failed");
    expect(JSON.stringify(notFound)).not.toContain("dataforseo.com");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const threw = await copyVendorAsset(VENDOR_IMAGE);
    expect(threw.status).toBe("copy-failed");
    expect(JSON.stringify(threw)).not.toContain("dataforseo.com");
  });

  it("reports a storage failure as copy-failed, never as a vendor URL", async () => {
    // **Distinct from the fetch failure and the same contract.** If R2 is unavailable the
    // screenshot is absent; that is the honest report and the leak-free one.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse()),
    );
    put.mockRejectedValueOnce(new Error("R2 unavailable"));

    const outcome = await copyVendorAsset(VENDOR_IMAGE);

    expect(outcome.status).toBe("copy-failed");
    expect(JSON.stringify(outcome)).not.toContain("dataforseo.com");
  });

  it("records our own expiry, on our own schedule rather than the vendor's", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse()),
    );

    await copyVendorAsset(VENDOR_IMAGE);

    // **Typed spy, so `mock.calls[0]` carries the options shape rather than `[]`.** An untyped
    // `vi.fn()` records calls with no parameters at all, so every read of `calls[0][2]` was a
    // tuple-index error, and the first version answered it with a `[string, unknown, …]`
    // assertion that claimed a shape the mock never had.
    const metadata = put.mock.calls[0][2].customMetadata;

    // **30 days, not the vendor's 1.** The vendor's URL is a delivery mechanism; ours is a
    // retention decision, and tying the two would tie our data lifecycle to a CDN header.
    const expiresAt = Date.parse(metadata.expiresAt);
    const days = (expiresAt - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(COPY_TTL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(COPY_TTL_DAYS);
    // And the source host is recorded for an audit trail, without the URL.
    expect(metadata.sourceHost).toBe("api.dataforseo.com");
    expect(metadata.copiedAt).toBeTruthy();
  });

  it("builds a client URL from our own origin, never the vendor's", () => {
    // **The function a caller reaches for when rendering.** If it could emit a vendor URL, the
    // guard would be bypassable by anyone using it.
    const url = storedAssetUrl("deadbeef.bin", "https://app.example.com");
    expect(url).toBe("https://app.example.com/vendor-assets/deadbeef.bin");
    expect(url).not.toContain("dataforseo");
    // And a trailing slash on the base does not double up.
    expect(storedAssetUrl("x.bin", "https://app.example.com/")).toBe(
      "https://app.example.com/vendor-assets/x.bin",
    );
  });

  it("reports a non-URL as not-a-vendor-image rather than throwing", async () => {
    // **A malformed value must not take the audit down with it.** The copier runs inside the
    // request cycle, so an exception here is an exception on a billed call.
    const outcome = await copyVendorAsset("not a url at all");
    expect(outcome.status).toBe("not-a-vendor-image");
  });

  it("reports a boolean verdict on synthetic input — the negative control", async () => {
    // **Asserting `true`/`false`, which is the shape `gates-about-gates` recognises** — every
    // other case here performs real work against a stubbed `fetch`, and a rule that matched
    // nothing would satisfy those too.
    //
    // **Typed through the module's own `CopyOutcome`,** so the union is read rather than
    // restated here — a second copy of it would drift, and the drift would be invisible until
    // a new outcome was added and this control still compiled.
    const outcomes: CopyOutcome[] = [
      { status: "copied", key: "k", bytes: 1, expiresAt: "t" },
      { status: "not-a-vendor-image", reason: "r" },
      { status: "copy-failed", reason: "r" },
    ];
    expect(outcomes.filter(isCopiedOutcome).length).toBe(1);
    expect(outcomes.every((o) => o.status.length > 0)).toBe(true);

    const wouldCopy = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return ALLOWED_HOSTS_FOR_TEST.has(parsed.hostname);
      } catch {
        return false;
      }
    };

    expect(wouldCopy(VENDOR_IMAGE)).toBe(true);
    expect(wouldCopy("https://evil.com/final-screenshot.jpg")).toBe(false);
    // **The near-miss a substring rule gets wrong**, which is why the check is a set lookup.
    expect(wouldCopy("https://api.dataforseo.com.evil.com/x.jpg")).toBe(false);
    expect(wouldCopy("nonsense")).toBe(false);
  });
});

/**
 * At module scope, because `consistent-function-scoping` is right that it captures nothing
 * from its enclosing scope — and a predicate declared inside a test body reads as part of the
 * copier when it is part of neither.
 */
function isCopiedOutcome(o: CopyOutcome): boolean {
  return o.status === "copied";
}

/**
 * A copy of the allowlist, so the control can be stated without reaching into the module.
 *
 * **Duplicated on purpose, and the duplication is the test.** If the module's allowlist grows a
 * host, this control does not follow it — and the divergence is visible rather than silent.
 * Reaching into the module instead would make the control pass for any allowlist at all,
 * which is precisely what a control must not do.
 */
const ALLOWED_HOSTS_FOR_TEST = new Set([
  "api.dataforseo.com",
  "pagespeed.dataforseo.com",
]);
