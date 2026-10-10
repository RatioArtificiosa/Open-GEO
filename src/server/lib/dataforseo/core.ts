import { AppError } from "@/server/lib/errors";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";
import { demoResponseFor } from "@/server/lib/dataforseo/demo-fixtures";
import {
  gateFor,
  RateGate,
  Semaphore,
  withRateSlot,
} from "@/server/lib/dataforseo/gates";
import type { ErrorCode } from "@/shared/error-codes";
// Type-only: erased at compile, so no runtime cycle with envelope.ts (which
// imports DataforseoErrorClassifier from here the same way).
import type {
  DataforseoResponseLike,
  DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

const API_BASE = "https://api.dataforseo.com";

/**
 * The sandbox host: the same request surface, the same auth, canned results, and
 * **zero cost**.
 *
 * `serp-location-validate.ts` has used it since the beginning to check whether a
 * location/language pair is accepted before committing to a real task. This
 * constant generalises it, because the sandbox is how the whole client can be
 * exercised without spending money — CI, a self-hoster's first run, and the
 * benchmark in §"why this file" below.
 */
export const DATAFORSEO_SANDBOX_URL = "https://sandbox.dataforseo.com";

/**
 * The env var that points the DataForSEO client at a host other than production.
 *
 * ## Why this exists
 *
 * The DataForSEO live account had **$1** in it when this was written. A single
 * mis-shaped request costs real money, and a whole end-to-end run — one patrol,
 * one nightly capture, one audit — costs many more than the account held. The
 * sandbox validates every request exactly as production does (auth, envelope,
 * task limits, rate gates) and returns canned rows, so the entire request path
 * can be exercised for free.
 *
 * ## What it is for, and what it is not for
 *
 * **For:** throughput and concurrency benchmarks, CI smoke tests, a self-hoster's
 * first run, validating a new endpoint's request shape.
 *
 * **Not for:** validating business logic. The sandbox returns **fixture rows**,
 * so volume, difficulty and ranking numbers are not real. A capture run against
 * the sandbox stores sandbox rows; the *shape* is right and the *figures* are not.
 *
 * ## Why an env var and not a code branch
 *
 * The alternative is a sandbox flag threaded through the client factory, the
 * section fetchers, the nightly captures and the tests, which is a change in
 * every file that touches the vendor. Reading one env var at the single seam —
 * `requestDataforseo` and `dataforseoPostResponse`, the only two places a host is
 * composed — means nothing else needs to know.
 *
 * ## It defaults to production, deliberately
 *
 * An unset variable means `api.dataforseo.com`. There is no `DEMO`-style
 * implicit switch: an operator who forgets to set this spends real money, and an
 * operator who forgets to unset it gets fixture data, which is the more visible
 * of the two mistakes.
 */
const SANDBOX_BASE_URL_ENV = "DATAFORSEO_BASE_URL";

/**
 * The base URL for DataForSEO calls, resolved per request.
 *
 * Read as a function, and async, because the Cloudflare Worker environment is
 * only available inside a request: a `const baseUrl = env.X` at module scope is
 * evaluated during Worker startup, where the env bindings do not exist yet. The
 * two call sites are the only places a host is composed.
 */
async function dataforseoBaseUrl(): Promise<string> {
  const override = await getOptionalEnvValue(SANDBOX_BASE_URL_ENV);
  // An empty string, or a value with no scheme, is a mistake worth failing on:
  // silently falling back to production after a partial env config is how a
  // sandbox run spends real money.
  if (override === undefined || override === "") return API_BASE;
  if (!/^https?:\/\//.test(override)) {
    throw new Error(
      `${SANDBOX_BASE_URL_ENV} must be an absolute http(s) URL, got "${override}". ` +
        `Unset it to use production (${API_BASE}), or set it to the sandbox ` +
        `(${DATAFORSEO_SANDBOX_URL}) to run at zero cost.`,
    );
  }
  return override;
}
const MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH = 1600;
// Safety ceiling on any live call (Lighthouse is the slowest, ~tens of seconds).
const DATAFORSEO_REQUEST_TIMEOUT_MS = 60_000;
// Retry idempotent reads on transient 5xx. Total attempts = retries + 1; the
// shared request-timeout signal still caps overall wall time.
const DATAFORSEO_MAX_RETRIES = 2;
const DATAFORSEO_RETRY_BACKOFF_MS = 250;

/**
 * Translates a DataForSEO HTTP/task failure into a product-specific AppError
 * (e.g. "billing issue"). Returns null when the failure isn't one this
 * classifier recognises, so the caller can fall back to a generic error. See
 * {@link createDataforseoBillingClassifier}.
 */
export type DataforseoErrorClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => AppError | null;

function formatDataforseoErrorPayload(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  return text.length > MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH
    ? `${text.slice(0, MAX_DATAFORSEO_ERROR_PAYLOAD_LENGTH)}... [truncated]`
    : text;
}

function formatDataforseoRequestPath(url: RequestInfo): string {
  const rawUrl = typeof url === "string" ? url : url.url;
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

/**
 * The single authenticated `fetch` used by every DataForSEO call. Throws on
 * non-2xx; task-level failures (which return HTTP 200) are handled downstream
 * by {@link assertOk}. An optional classifier maps recognised HTTP failures to
 * product errors.
 */
function createAuthenticatedFetch(
  classify?: DataforseoErrorClassifier,
  maxServerErrorRetries = DATAFORSEO_MAX_RETRIES,
) {
  return async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const apiKey = await getRequiredEnvValue("DATAFORSEO_API_KEY");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${apiKey}`);
    // Resolve the signal once so retries share the overall request timeout
    // rather than restarting a fresh 60s budget on each attempt.
    const signal =
      init?.signal ?? AbortSignal.timeout(DATAFORSEO_REQUEST_TIMEOUT_MS);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { ...init, headers, signal });
      } catch (error) {
        // Both abort flavours mean "we ran out of time", and neither carries a
        // useful name of its own: the shared budget above rejects with
        // TimeoutError, while Lighthouse passes its own AbortController
        // deadline via init.signal and rejects with AbortError. Classify them
        // so callers get a provider-degradation error instead of an anonymous
        // internal one. Deliberately not retried: a call that ran past the
        // deadline may already be billed by DataForSEO, and because this is not
        // a DataforseoChargedTaskError the customer is metered nothing for it,
        // so replaying would be spend we eat twice.
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          const path = formatDataforseoRequestPath(url);
          const timeoutError = new AppError(
            "UPSTREAM_UNAVAILABLE",
            `DataForSEO request timed out on ${path}`,
            { provider: "dataforseo", providerPath: path },
          );
          timeoutError.name = "DataForSEOTimeoutError";
          throw timeoutError;
        }
        throw error;
      }
      if (response.ok) return response;

      // Transient upstream 5xx on an idempotent read -> back off and retry.
      if (response.status >= 500 && attempt < maxServerErrorRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, DATAFORSEO_RETRY_BACKOFF_MS * (attempt + 1)),
        );
        continue;
      }

      const rawText = await response.text();
      const path = formatDataforseoRequestPath(url);
      const classified = classify?.(response.status, rawText, path);
      if (classified) throw classified;

      /**
       * **The body's own verdict, because a non-2xx can still carry it.**
       *
       * DataForSEO's convention is to answer a *logical* failure with **HTTP 200** and put
       * the outcome in `status_code`; `assertOk` reads that and classifies correctly. This
       * is the only path that cannot, because `doFetch` throws before the body is parsed:
       * `classify` is the one hook that sees a status code extracted from an error body.
       *
       * Falls through when there is no body code — `classify` returns null, and the HTTP
       * ladder below decides, which is right for a genuine transport failure with no
       * envelope. **A body that cannot be read must reach the ladder**, because a vendor's
       * bad day must not become our wrong classification.
       */
      const bodyStatusCode = readBodyStatusCode(rawText);
      if (bodyStatusCode !== null) {
        const fromBody = classify?.(bodyStatusCode, rawText, path);
        if (fromBody) throw fromBody;
      }

      const code: ErrorCode =
        response.status >= 500
          ? "UPSTREAM_UNAVAILABLE"
          : response.status === 429
            ? "RATE_LIMITED"
            : response.status === 401
              ? "DATAFORSEO_AUTH_FAILED"
              : "INTERNAL_ERROR";
      const error = new AppError(
        code,
        `DataForSEO HTTP ${response.status} on ${path}`,
        {
          provider: "dataforseo",
          providerStatus: String(response.status),
          providerPath: path,
          responseBody: formatDataforseoErrorPayload(rawText),
        },
      );
      error.name = "DataForSEOHttpError";
      // UPSTREAM_UNAVAILABLE is non-reportable, and the error handlers only log
      // what they capture, so warn here to keep the provider's failure rate
      // visible in Workers Observability. Warn, not error: there is nothing in
      // the app to fix.
      if (code === "UPSTREAM_UNAVAILABLE")
        console.warn("dataforseo.upstream-http-failed", {
          path,
          status: response.status,
        });
      throw error;
    }
  };
}

/**
 * The `status_code` in a DataForSEO response body, or null when there isn't a readable one.
 *
 * **Parsed rather than trusted, and never throws.** The body on an error path is whatever
 * the vendor sent — an HTML error page from a proxy, an empty string, a shape we have not
 * seen. Every one of those means "no verdict from the body", which is `null`, and the
 * caller's HTTP ladder then decides. **A helper that can throw on a malformed body would
 * turn a vendor's bad day into ours.**
 *
 * `tryBuildTaskBilling` in `envelope.ts` is the precedent: the same shape, the same
 * reason, and Zod rather than a regex — because a regex on JSON is a guess about quoting.
 */
function readBodyStatusCode(rawText: string): number | null {
  if (rawText.length === 0 || rawText[0] !== "{") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  // **Narrowed, not asserted.** `in` plus a typeof check is the type guard; the two casts
  // this replaces were the failure mode `envelope.ts` warns about in its own comment -
  // "arrives from the wire untyped and optional" - where an assertion is a claim the
  // compiler cannot check and the vendor can break.
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("status_code" in parsed)) return null;
  const statusCode: unknown = parsed.status_code;
  return typeof statusCode === "number" ? statusCode : null;
}

type DataforseoRequestOptions = {
  /** Maps a recognised access / billing HTTP failure to a product error. */
  classify?: DataforseoErrorClassifier;
  /**
   * Set 0 for billed, non-idempotent calls (business task_post, Lighthouse):
   * a 5xx does not prove the provider skipped the charge, so those must never
   * be replayed. Defaults to retrying idempotent reads on transient 5xx.
   */
  maxServerErrorRetries?: number;
  /**
   * Points one call at a host other than the resolved default.
   *
   * **Precedence: this option, then `DATAFORSEO_BASE_URL`, then production.**
   * An explicit argument wins because it is the narrowest declaration and is what
   * the test stubs use — `concurrency.test.ts` runs the whole gate against a
   * local server, and `serp-location-validate.ts` pins its own call to the
   * sandbox so a location check never bills regardless of the ambient setting.
   *
   * Prefer the env var for anything real: an argument has to be threaded through
   * a client factory, a section fetcher and every capture, and the env var
   * reaches all of them from one place.
   */
  baseUrl?: string;
  signal?: AbortSignal;
};

async function requestDataforseo<TTask extends DataforseoTaskLike>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  options: DataforseoRequestOptions,
): Promise<DataforseoResponseLike<TTask> | null> {
  // Demo mode short-circuits here, before auth and before the network, so a
  // self-hoster with no DataForSEO account still sees a populated product.
  // Interception sits at the single request seam rather than in each fetch
  // module, which means a new endpoint is demo-able for free. An un-fixtured
  // path returns null and the real call proceeds — demo mode must never turn a
  // working path into an error.
  const demo = await demoResponseFor(path);
  if (demo) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixtures are our own code and are validated by demo-fixtures.test.ts against the real envelope shape
    return demo as DataforseoResponseLike<TTask>;
  }

  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries,
  );
  // The vendor's own ceilings, enforced at the one seam every call passes
  // through. Placed here — after the demo short-circuit, before the network —
  // for three reasons: demo mode stays free and instant, a new endpoint is
  // bounded without touching its module, and the bound applies to `task_get`
  // polling exactly as it does to a live call, which matters because polling is
  // the term that actually exhausts the account budget.
  //
  // Waiting here is deliberate and it is what the limits module is for: a
  // customer-visible request must not fail because a sibling fan-out is running.
  // `options.signal` still governs the wait, so a cancelled request stops
  // queueing rather than sitting in line for a slot it will never use.
  const gate = gateFor(path);
  const send = async (): Promise<Response> =>
    doFetch(`${options.baseUrl ?? (await dataforseoBaseUrl())}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
  const response =
    gate instanceof Semaphore
      ? await gate.run(send)
      : gate instanceof RateGate
        ? await withRateSlot(gate, send, options.signal)
        : await send();
  const text = await response.text();
  if (text === "") return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the task type is the caller's claim about the payload; billing metadata and item fields are validated downstream (envelope.ts + section Zod schemas)
  return JSON.parse(text) as DataforseoResponseLike<TTask>;
}

/**
 * POST `tasks` (the standard array-of-task-payloads body) to a DataForSEO
 * endpoint and return the parsed response envelope. The task type parameter is
 * the caller's claim about the payload shape — fields we act on are validated
 * downstream (billing metadata in envelope.ts, items via the section fetchers'
 * Zod schemas). Auth is read per-call from the Worker env.
 */
export function dataforseoPost<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("POST", path, tasks, options);
}

/**
 * POST like {@link dataforseoPost} but return the UN-CONSUMED Response
 * (headers only) — the same auth, retry policy, and HTTP-error ladder apply.
 * For the one endpoint whose body is too big to read eagerly: Lighthouse
 * gates its multi-MB body reads behind a parse lock in the audit worker, and
 * passes its own `signal` so the timeout can be cleared once headers arrive.
 */
export async function dataforseoPostResponse(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions & { signal?: AbortSignal } = {},
): Promise<Response> {
  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries,
  );
  // Resolved before the call rather than inline in the template, because an
  // `await` inside a template literal reads like part of the string and is the
  // first thing a reader has to unpick. The host is the only thing that awaits.
  const baseUrl = await dataforseoBaseUrl();
  return doFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(tasks),
    signal: options.signal,
  });
}

/** GET a DataForSEO endpoint (task_get collection, appendix/locations data). */
export function dataforseoGet<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("GET", path, undefined, options);
}
