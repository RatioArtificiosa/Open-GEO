import { getOptionalEnvValue } from "@/server/lib/runtime-env";
// Two modules, deliberately. `AlertMessage` is the wire shape and lives beside
// the code that builds it; `Transport` is the one-method contract and lives
// beside the code that satisfies it. Importing the shape from `alertDispatch`
// looks plausible and fails - that module only re-exports the signature.
import type { AlertMessage } from "./alertMessage";
import type { Transport } from "./alertDispatch";

/**
 * Posting an alert to a Discord webhook.
 *
 * ## Three things the docs settled, and each one would have been a bug
 *
 * 1. **`content` is capped at 2000 characters**, and the default is not enforced
 *    by the type system. Our message is a subject plus a bullet list, so a run
 *    that lost thirty citations produces a body well over the cap — and Discord
 *    answers a 400, which the dispatch layer would record as `failed` and retry
 *    on every tick, forever. So the body is **truncated with a marker saying how
 *    much was dropped**, which is the same rule the evidence drawer follows: a
 *    silently shortened alert is a lie about its own completeness.
 *
 * 2. **`allowed_mentions` defaults to parsing the content for mentions**, and
 *    our content contains URLs, prompts, and domains. A prompt like
 *    `@someone` in a customer's own prompt set would ping a real person from an
 *    automated message. So it is pinned to `parse: []`, which means *nothing* is
 *    ever interpreted as a mention — a rare case where the safe option is also
 *    the simpler one.
 *
 * 3. **`wait` defaults to false, and with it false "a message that is not saved
 *    does not return an error."** A 204 then proves nothing. So `wait=true`, and
 *    a 200 with a message id is the only thing counted as delivered — which is
 *    what makes CL-309b's `sent` row mean something.
 *
 * ## A rate limit is not a transient failure
 *
 * Discord answers 429 with a `retry_after` in seconds. Retrying immediately
 * would burn the budget again; retrying on the next tick would retry a message
 * that is *not* about a change, because the alert has already been decided and
 * its fingerprint is spent. So a 429 is reported as a **distinct outcome**, and
 * the dispatch layer records it as `failed` — which means the next tick's
 * duplicate check will not suppress it, and the alert lands late rather than
 * never. Late beats never; a repeated 429 for a month is an operator problem
 * and a visible one.
 *
 * Verified against the webhook documentation on 2026-09-30.
 */

/** Discord's documented cap for `content`. */
export const DISCORD_CONTENT_LIMIT = 2000;

/** The env var holding the webhook URL. Absent means "no channel configured". */
export const WEBHOOK_ENV_VAR = "GEO_ALERT_DISCORD_WEBHOOK_URL";

/**
 * There is deliberately no result type.
 *
 * The first version of this transport returned a discriminated union describing
 * what Discord had said: delivered, rate-limited, rejected. It was unused. A
 * `Transport` returns `Promise<void>`, and a caller that wants to know why a
 * send failed has to look at the thrown error, because the *dispatch* layer is
 * what records `sent` versus `failed`, and it can only do that from a throw.
 *
 * So the outcomes became error messages carrying the same information, and the
 * union went away with the caller that never existed. A type describing a result
 * nobody reads is a second source of truth about what the transport does.
 */

/**
 * Shorten to the cap, saying how much was dropped.
 *
 * A message that ends mid-sentence with no marker reads as a complete message,
 * and the reader has no way to know the change list was cut off. The marker is
 * the whole point: this is the evidence drawer's rule applied to an alert.
 */
export function fitToDiscord(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  const marker = "… (truncated)";
  const room = DISCORD_CONTENT_LIMIT - marker.length;
  return content.slice(0, room).trimEnd() + marker;
}

/**
 * Read the body as JSON when we can, and fall back to text when we cannot.
 *
 * A 400 from Discord carries a JSON error object, and a 429 carries a
 * `retry_after` number. But a proxy or a gateway in front of it may return HTML,
 * and `res.json()` on an HTML body throws — which would turn a legible "rate
 * limited" into an unparseable failure and lose the `retry_after` that tells us
 * how long to wait.
 */
/** True only for a plain object: not null, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(
  res: Response,
): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (text === "") return null;
  try {
    // Narrowed, not asserted: a body can legitimately be an array or a bare
    // string, and reading `.retry_after` off either would be reading `undefined`
    // by accident rather than by decision.
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // HTML from a proxy, or anything else that is not JSON. Null rather than a
    // throw, so a rate limit stays legible.
    return null;
  }
}

/** Discord's `retry_after` is seconds, and sometimes fractional. */
function parseRetryAfter(body: Record<string, unknown> | null): number | null {
  const raw = body?.retry_after;
  if (typeof raw !== "number") return null;
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Build the transport.
 *
 * Every option is optional so the production call site is
 * `createDiscordTransport()` with nothing in it: the env lookup and the global
 * `fetch` are the defaults, and a test supplies its own. A required options
 * object here would push every caller to write `{}`, which is a place for
 * someone to add a real option by accident.
 */
export function createDiscordTransport(
  options: {
    fetchImpl?: typeof fetch;
    /** Injected so the env lookup is testable without a Workers runtime. */
    webhookUrl?: string | undefined;
  } = {},
): Transport {
  const doFetch = options.fetchImpl ?? fetch;

  return async (message: AlertMessage): Promise<void> => {
    const url =
      options.webhookUrl ?? (await getOptionalEnvValue(WEBHOOK_ENV_VAR));
    if (url === undefined || url === "") {
      // Unconfigured is not an error. See the module docblock in `alertRunner`:
      // throwing here would fail every patrol for an install that never asked for
      // a channel, and a self-hoster with no webhook is the *default* install.
      return;
    }

    // `wait=true` so a 204 cannot be mistaken for a delivery, and
    // `allowed_mentions` pinned so a prompt containing `@name` cannot ping a
    // person from an automated message.
    const res = await doFetch(`${url}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: fitToDiscord(message.body),
        allowed_mentions: { parse: [] },
      }),
    });

    if (res.ok) return;

    const body = await readBody(res);
    if (res.status === 429) {
      // Thrown, not returned: the dispatch layer records a throw as `failed`,
      // which the duplicate check ignores, so the next tick retries this exact
      // alert instead of suppressing it as already-sent.
      const retryAfter = parseRetryAfter(body);
      throw new Error(
        retryAfter === null
          ? `Discord rate limited the alert (HTTP 429) with no retry_after.`
          : `Discord rate limited the alert (HTTP 429); retry after ${retryAfter}s.`,
      );
    }

    throw new Error(
      `Discord rejected the alert (HTTP ${res.status}): ${
        typeof body?.message === "string" ? body.message : "no detail"
      }`,
    );
  };
}
