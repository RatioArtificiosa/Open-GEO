import { dataforseoPostResponse } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  DataforseoChargedTaskError,
  type DataforseoApiResponse,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import {
  parseDataforseoLighthousePayload,
  requestCategories,
  type LighthouseStrategy,
} from "@/server/lib/dataforseoLighthousePayload";
import type { StoredLighthousePayload } from "@/server/lib/lighthouseStoredPayload";
import { copyVendorAsset } from "@/server/lib/vendorAssetCopy";

/**
 * Our copies of this audit's screenshots — **keys, never URLs.**
 *
 * **A vendor URL is not storable here**, and that is the point: there is no field on this
 * shape a caller could put in an `<img src>`. `vendor-image-guard.test.ts` forbids a vendor
 * host reaching client code, and this type makes the omission structural rather than a rule
 * someone has to remember.
 */
export type StoredScreenshots = {
  "final-screenshot"?: { key: string; bytes: number; expiresAt: string };
  "screenshot-thumbnails"?: { key: string; bytes: number; expiresAt: string };
};

/**
 * The audit payload plus whatever screenshots we copied.
 *
 * **`StoredLighthousePayload & { screenshots?: StoredScreenshots }`, and this type exists
 * because the client returns `{ ...data, screenshots }`.** The declared return type was
 * `StoredLighthousePayload`, so **the screenshots were invisible to every consumer and to
 * `tsc` alike** — `data.screenshots` in the test failed to compile, which is the only reason
 * the lie was caught at all. A field added by spreading is still a field, and a return type
 * that does not mention it is a claim the compiler cannot check.
 */
export type LighthouseResultWithScreenshots = StoredLighthousePayload & {
  screenshots?: StoredScreenshots;
};

const LIGHTHOUSE_PATH = "/v3/on_page/lighthouse/live/json";
const REQUEST_TIMEOUT_MS = 60_000;

// One payload read+parse at a time per isolate. This module runs in the
// open-geo-audit worker, and the raw Lighthouse payload (1-10MB, held several
// times over while parsing) is the operation that OOMed the main worker;
// concurrent checks bursting onto one isolate could do the same here. The
// DataForSEO fetches themselves stay concurrent — parsing (well under a
// second each) is cheap against a 30-60s fetch, and workerd streams un-read
// response bodies, so queued siblings don't buffer.
let parseChain: Promise<unknown> = Promise.resolve();
function withParseLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = parseChain.then(fn, fn);
  parseChain = run.catch(() => {});
  return run;
}

/**
 * One billed Lighthouse run, and whatever screenshots we copied while doing it.
 *
 * **`organizationId` is required, not optional.** The copier stamps it onto every copy
 * because `storage-erasure.ts` matches on it to decide what a GDPR request deletes — **so a
 * copy without one would survive every erasure request while looking identical to one that
 * does not.** Requiring it here means the caller cannot forget: the alternative is an
 * optional parameter every caller passes `undefined`.
 */
export async function fetchLighthouseResult(input: {
  url: string;
  strategy: LighthouseStrategy;
  /** The owning tenant. Required so every copy is erasable. */
  organizationId: string;
}): Promise<DataforseoApiResponse<LighthouseResultWithScreenshots>> {
  // Billed, non-idempotent POST: a 5xx does not prove the provider skipped
  // the charge, so never replay it. The response is taken un-consumed (unlike
  // dataforseoPost) so the multi-MB body read happens inside the parse lock,
  // and the timeout is cleared once headers arrive — an armed signal would
  // otherwise cover a body read queued behind the lock past 60s and abort an
  // already-billed call unmetered.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await dataforseoPostResponse(
      LIGHTHOUSE_PATH,
      [
        {
          url: input.url,
          for_mobile: input.strategy === "mobile",
          categories: [...requestCategories],
        },
      ],
      { maxServerErrorRetries: 0, signal: controller.signal },
    );
  } finally {
    clearTimeout(timeout);
  }

  return withParseLock(async () => {
    const body =
      await response.json<DataforseoResponseLike<DataforseoTaskLike>>();
    // Build the metering envelope before parsing. The provider has already
    // charged a successful task, so a malformed payload must carry its
    // billing metadata out to the metered client instead of looking
    // retryable.
    const task = assertOk(body);
    const billing = buildTaskBilling(task);
    try {
      const data = parseDataforseoLighthousePayload(body, input);
      // **Copy the vendor's screenshot before the payload leaves this call** (CL-703). The
      // vendor serves it from a one-day URL, so an audit stored with that URL shows an image
      // today and 404s tomorrow — and §B.5 of the master reference makes "keep the raw answer
      // behind a retention policy" the one mitigation engineering can act on while the licence
      // question is open. `data.screenshots` holds **our** keys or nothing at all: there is no
      // vendor-URL fallback anywhere in this path, because a fallback is the leak.
      const screenshots = await copyScreenshotsFromTask(task, {
        organizationId: input.organizationId,
      });
      return {
        data: screenshots === undefined ? data : { ...data, screenshots },
        billing,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DataforseoChargedTaskError(message, billing);
    }
  });
}

/**
/**
 * Whether a value is a plain object we can read a field from.
 *
 * **A guard, not a cast.** The three `as Record<string, unknown>` assertions it replaced were
 * each flagged `no-unsafe-type-assertion`, and the rule was right every time: the wire type is
 * `unknown`, and claiming it is a record asserts a structure the vendor has not promised.
 * **One guard reads better than three casts and is honest about what it checked.**
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pull the image URL out of one Lighthouse audit entry.
 *
 * **Two shapes, because the vendor sends two.** `final-screenshot` arrives as
 * `details.data` — the same field the *thumbnail* audit uses — and some responses carry the
 * URL directly on the audit. **Both are read, and neither is assumed**, because a wrong guess
 * here does not throw: it finds nothing, the copier never runs, and the integration is a
 * **silent no-op that looks exactly like a working one.** That is the failure this project keeps
 * meeting, and it is why the test asserts *the copier ran* rather than that the payload carries
 * a screenshot field.
 *
 * A returned string is **checked to look like a URL**, so an audit whose `details.data` is a
 * base64 blob or a byte count is not sent to the copier to be rejected there.
 */
function readScreenshotUrl(auditValue: unknown): string | null {
  if (!isRecord(auditValue)) return null;

  for (const candidate of [auditValue.details, auditValue]) {
    if (!isRecord(candidate)) continue;
    for (const key of ["data", "url", "screenshot"]) {
      const value: unknown = candidate[key];
      if (typeof value !== "string" || !value.startsWith("http")) continue;
      return value;
    }
  }
  return null;
}

/**
 * Copy every vendor screenshot this task produced, and return **our** keys.
 *
 * **Returns `undefined` rather than an empty array when there is nothing to copy**, because
 * "the vendor sent no screenshot" and "every screenshot failed to copy" are different
 * situations and the caller stores one of them as an absent field.
 *
 * **A copy failure never throws and never falls back.** The audit has already been billed, so
 * failing here would turn a missing image into a failed audit; and returning the vendor URL
 * would be the leak the whole module exists to prevent. **A missing screenshot is the correct
 * outcome for a missing screenshot.**
 */
async function copyScreenshotsFromTask(
  task: DataforseoTaskLike,
  owner: { organizationId: string },
): Promise<StoredScreenshots | undefined> {
  // **Narrowed with guards rather than asserted.** The result is `unknown` on the wire type,
  // and casting it to a record shape asserts a structure the vendor has not promised — so
  // each step checks what it is instead of claiming it. Two casts here produced three
  // `no-unsafe-type-assertion` errors, and both were **the assertion lying rather than the
  // code being wrong**: `result?.[0]` is not a `Record`, it is `unknown` that happens to be a
  // record today.
  const result: unknown = task.result?.[0];
  if (!isRecord(result)) return undefined;
  if (!isRecord(result.audits)) return undefined;

  const audits = result.audits;

  // **The URL lives at `audits["final-screenshot"].details.data`** — a nested path, not a
  // sibling field, which is what the vendor's Lighthouse JSON actually looks like and what the
  // first version assumed. Reading `audits[audit][audit]` found nothing, the copier never ran,
  // and the test caught it as *"expected `vi.fn()` to be called 1 times, but got 0"* — a
  // **silent no-op that looks exactly like a working integration**, which is the failure mode
  // this whole module is built to avoid.
  const wanted: Array<{ audit: string; field: keyof StoredScreenshots }> = [
    { audit: "final-screenshot", field: "final-screenshot" },
    { audit: "screenshot-thumbnails", field: "screenshot-thumbnails" },
  ];

  const out: StoredScreenshots = {};
  let copied = 0;

  for (const { audit, field } of wanted) {
    const auditValue: unknown = audits[audit];
    const url = readScreenshotUrl(auditValue);
    if (url === null) continue;

    const outcome = await copyVendorAsset(url, owner);
    if (outcome.status === "copied") {
      out[field] = {
        key: outcome.key,
        bytes: outcome.bytes,
        expiresAt: outcome.expiresAt,
      };
      copied += 1;
    } else {
      // **Logged, not swallowed.** A copier that silently copies nothing is a feature that
      // is mysteriously absent, and the log line is the only evidence it ever ran.
      console.warn(
        `[lighthouse] screenshot copy ${outcome.status}: ${
          "reason" in outcome ? outcome.reason : "unknown"
        }`,
      );
    }
  }

  return copied === 0 ? undefined : out;
}
