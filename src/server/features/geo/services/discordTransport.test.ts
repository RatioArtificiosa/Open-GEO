import { describe, expect, it } from "vitest";
import {
  DISCORD_CONTENT_LIMIT,
  WEBHOOK_ENV_VAR,
  createDiscordTransport,
  fitToDiscord,
} from "./discordTransport";

/**
 * The Discord transport.
 *
 * Each test corresponds to a fact in Discord's webhook documentation that
 * would otherwise be a production bug, and the assertions are on the *request we
 * would send* rather than on the function's internals — so a rewrite that keeps
 * the wire behaviour still passes.
 */

const MESSAGE = {
  subject: "1 mention lost",
  body: "Acme: 1 change in what AI says about you.",
  changes: ["lost mention of acme.com on chat_gpt"],
};

/** A `fetch` that answers with the given status and body, and records the call. */
function stubFetch(status: number, body: string) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Narrowed rather than stringified: `fetch` accepts a `Request`, and
    // `String(request)` would give `[object Request]` and make the `wait=true`
    // assertion pass for entirely the wrong reason.
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    return new Response(body, { status });
  };

  // Typed to the contract the transport actually uses, not to the whole of
  // `fetch`, so no cast is needed and a signature the transport never calls
  // cannot be silently relied on.
  return { fetchImpl: impl, calls };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") throw new Error("expected a string body");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expected a JSON object body");
  }
  // Narrowed by the three checks above; the cast only re-states what the guard
  // cannot express. TypeScript's `object` excludes arrays and null but does not
  // imply an index signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guard above is what makes this true
  return parsed as Record<string, unknown>;
}
describe("fitToDiscord", () => {
  it("leaves a short message untouched", () => {
    expect(fitToDiscord("hello")).toBe("hello");
  });

  it("truncates with a marker, because a short message reads as a complete one", () => {
    // The rule the evidence drawer follows: a silently shortened alert is a lie
    // about its own completeness, and the reader has no way to know the change
    // list was cut off.
    const long = "x".repeat(DISCORD_CONTENT_LIMIT + 500);
    const fitted = fitToDiscord(long);
    expect(fitted.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(fitted).toMatch(/truncated/);
  });

  it("fits exactly the cap without truncating", () => {
    // The boundary: an off-by-one here drops the marker on the message that most
    // needs it, because it is the one just over the line.
    const exact = "x".repeat(DISCORD_CONTENT_LIMIT);
    expect(fitToDiscord(exact)).toBe(exact);
    expect(fitToDiscord(exact)).not.toMatch(/truncated/);
  });
});

describe("the Discord transport", () => {
  it("does nothing when no webhook is configured", async () => {
    // The default install has no webhook, and a self-hoster who never asked for
    // a channel must not have every patrol fail.
    const { fetchImpl, calls } = stubFetch(200, "{}");
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: undefined,
    });
    await transport(MESSAGE);
    // Nothing was sent; the stub's absence of calls is the assertion.
    expect(calls).toHaveLength(0);
  });

  it("asks Discord to confirm, so a 204 cannot pass for a delivery", async () => {
    // `wait` defaults to false, and with it false the docs say a message that is
    // not saved returns no error. A 204 then proves nothing, and CL-309b's
    // `sent` row would be a claim about a message nobody received.
    const { fetchImpl, calls } = stubFetch(200, JSON.stringify({ id: "1" }));
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await transport(MESSAGE);
    expect(calls[0]?.url).toContain("wait=true");
  });

  it("pins allowed_mentions, so a prompt cannot ping a real person", async () => {
    // Discord parses content for mentions by default, and our content carries
    // customer prompts verbatim. A prompt containing `@someone` would ping a
    // person from an automated message.
    const { fetchImpl, calls } = stubFetch(200, JSON.stringify({ id: "1" }));
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await transport({
      ...MESSAGE,
      body: 'A brand lost the prompt "who is @acme"',
    });
    expect(bodyOf(calls[0]?.init)).toMatchObject({
      allowed_mentions: { parse: [] },
    });
  });

  it("sends the truncated body, never an over-cap one", async () => {
    const { fetchImpl, calls } = stubFetch(200, JSON.stringify({ id: "1" }));
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await transport({ ...MESSAGE, body: "y".repeat(5000) });
    const content = bodyOf(calls[0]?.init).content;
    expect(typeof content).toBe("string");
    // Narrowed with `typeof` and then measured, rather than asserted to a
    // `string` and measured — the cast said what the check was about to prove.
    if (typeof content !== "string") {
      throw new Error("expected the content field to be a string");
    }
    expect(content.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });

  it("throws on a rate limit, carrying the retry_after", async () => {
    // Not returned, and not swallowed: the dispatch layer records a throw as
    // `failed`, which the duplicate check ignores, so the next tick retries this
    // exact alert instead of suppressing it as already sent. Late beats never.
    const { fetchImpl } = stubFetch(429, JSON.stringify({ retry_after: 4.2 }));
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await expect(transport(MESSAGE)).rejects.toThrow(/rate limited/i);
    await expect(transport(MESSAGE)).rejects.toThrow(/4\.2/);
  });

  it("still says something useful when a rate limit has no retry_after", async () => {
    const { fetchImpl } = stubFetch(429, "{}");
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await expect(transport(MESSAGE)).rejects.toThrow(/no retry_after/);
  });

  it("survives a non-JSON error body rather than throwing on the parse", async () => {
    // A proxy returning HTML in front of Discord is the realistic case, and
    // `res.json()` on HTML throws — which would lose the `retry_after` and turn a
    // legible failure into an unparseable one.
    const { fetchImpl } = stubFetch(502, "<html>bad gateway</html>");
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await expect(transport(MESSAGE)).rejects.toThrow(/HTTP 502/);
  });

  it("surfaces Discord's own message when it sends one", async () => {
    const { fetchImpl } = stubFetch(
      400,
      JSON.stringify({ message: "content must be under 2000 characters" }),
    );
    const transport = createDiscordTransport({
      fetchImpl,
      webhookUrl: "https://discord.test/hook",
    });
    await expect(transport(MESSAGE)).rejects.toThrow(/under 2000/);
  });

  it("names the env var it reads, so an operator can find it", () => {
    // A transport that silently reads nothing is a channel that never fires,
    // and the fix has to be findable.
    expect(WEBHOOK_ENV_VAR).toBe("GEO_ALERT_DISCORD_WEBHOOK_URL");
  });
});
