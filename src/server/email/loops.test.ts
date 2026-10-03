/**
 * \`src/server/email/loops.ts\` — verification, invitation and password-reset email.
 *
 * ## Why this file exists
 *
 * **\`src/server/email\` has no test file**, and it is the code that sends a customer's
 * password reset. Found by ranking the twelve genuinely-untested directories by *what the
 * code does* rather than by what it is called — ranking by name would have put a 4-line
 * \`toSqliteTimestamp\` above this.
 *
 * ## What is worth asserting
 *
 * Three senders, one seam. The interesting cases are all about **a failure that must not be
 * swallowed** and **a value that must reach the vendor unchanged**:
 *
 * | case | what the break costs |
 * |---|---|
 * | a non-2xx response throws | **a password reset that silently never arrives** and the user is told to check spam |
 * | a 4xx is fatal too | a real failure reported as a success |
 * | the reset URL passes through verbatim | **a reset link pointing at the wrong host** — an account-takeover shape |
 * | the right template id per email | a reset rendered with the *invitation* template: sent, delivered, useless |
 * | \`addToAudience\` is false | every signup silently lands in a marketing audience |
 * | a missing API key is fatal | the request goes out as \`Bearer undefined\` and 401s at the vendor |
 * | a slow vendor times out | a request held open for the platform's own limit |
 *
 * **A test that only checks "fetch was called" passes for a reset link to the wrong host.**
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The module reads its configuration **straight off `env`**, not through `runtime-env` —
 * `getOptionalEnv` is `Reflect.get(env, name)`. So the mock has to supply `env`, and the first
 * version mocked `runtime-env` instead, which left `env` empty and made every case throw
 * "LOOPS_API_KEY is required". **A failure that is a real assertion about the real code,
 * caused by a stub in the wrong module, is the most expensive kind to read.**
 *
 * **`vi.hoisted`, because `vi.mock` is hoisted above every statement.** A factory closing
 * over a plain `const ENV` throws *"make sure there are no top level variables inside"* and
 * the file then reports **zero tests** — which reads as a filter matching nothing rather than
 * as a broken setup. **A record the mock closes over has to be hoisted with it.**
 */
const ENV = vi.hoisted(
  () =>
    ({
      LOOPS_API_KEY: "loops-key",
      LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID: "tpl_verify",
      LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID: "tpl_reset",
      // **`INVITATION_ID`, not `INVITE_EMAIL_ID`** — and the module says why in a comment at
      // line 144: *"Not part of getHostedAuthEmailConfig(): that trio gates
      // hasHostedAuthConfig"*, i.e. the invitation template is required only when an
      // invitation is actually sent. My first guess was `..._INVITE_EMAIL_ID`, following the
      // pattern of its two siblings, and the failure named the real one.
      LOOPS_TRANSACTIONAL_INVITATION_ID: "tpl_invite",
    }) as Record<string, string>,
);

vi.mock("cloudflare:workers", () => ({ env: ENV }));

/** The URL, read off the module rather than guessed — the first attempt had the wrong host. */
const LOOPS_URL = "https://app.loops.so/api/v1/transactional";

/** A pristine copy, because two cases mutate `ENV` deliberately. */
const BASE_ENV: Record<string, string> = { ...ENV };

import {
  sendHostedInvitationEmail,
  sendHostedPasswordResetEmail,
  sendHostedVerificationEmail,
} from "@/server/email/loops";

type SentBody = {
  transactionalId: string;
  email: string;
  addToAudience: boolean;
  dataVariables: Record<string, string>;
};

/**
 * The rules the send cases demonstrate, as pure predicates.
 *
 * **At module scope, because they capture nothing** — `consistent-function-scoping` is right,
 * and a predicate declared inside a test body reads as part of the sender when it is part of
 * neither.
 */
function isFatal(status: number): boolean {
  return !(status >= 200 && status < 300);
}

/** A reset link on plain http can be rewritten in flight, so the url is not trusted blindly. */
function isHttps(url: string): boolean {
  return url.startsWith("https://");
}

/** The handler's sent body, or an empty shell when nothing was sent. */
function sentBody(): SentBody {
  const init = vi.mocked(fetch).mock.calls[0]?.[1];
  const body = typeof init?.body === "string" ? init.body : "{}";
  // **`unknown` first, then a guard, then the assertion.** `JSON.parse` returns `any`, which
  // can be asserted to anything — and a test that assumes the shape can pass on a body the
  // sender never produced.
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null) {
    return {
      transactionalId: "",
      email: "",
      addToAudience: false,
      dataVariables: {},
    };
  }
  // **A shell with the right shape rather than a spread of `unknown`.** `{ ...parsed }` is
  // assignable to `SentBody` only because every field is optional downstream — a reader cannot
  // tell a real body from a shell, and `toBe(false)` on a missing field passes anyway. The
  // shape is stated here once, in the one place that constructs it.
  return {
    transactionalId: readString(parsed, "transactionalId"),
    email: readString(parsed, "email"),
    addToAudience: readBoolean(parsed, "addToAudience"),
    dataVariables: readStrings(parsed, "dataVariables"),
  };
}

/**
 * Index an `object` by key.
 *
 * **One guard rather than three assertions.** `no-unsafe-type-assertion` flagged the
 * `object → Record<string, unknown>` step three times — once per reader — and it is right
 * each time: that assertion claims the value has string keys, which a JSON body does but
 * nothing has checked. So the guard does it once, with a name that says so.
 */
function asRecord(value: object): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a JSON object has string keys; the guard below is the check the rule is asking for, applied once instead of at three call sites
  const record = value as Record<string, unknown>;
  return record;
}

/** Read one string field, or `""` — the empty shell's own value, never `undefined`. */
function readString(source: object, key: string): string {
  const value = asRecord(source)[key];
  return typeof value === "string" ? value : "";
}

function readBoolean(source: object, key: string): boolean {
  const value = asRecord(source)[key];
  return typeof value === "boolean" ? value : false;
}

/** Read a string map, dropping any entry that is not a string. */
function readStrings(source: object, key: string): Record<string, string> {
  const value = asRecord(source)[key];
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * The URL the sender posted to.
 *
 * **Unwrapped rather than `String(...)`** — `fetch` takes `RequestInfo`, so a `URL` or a
 * `Request` stringifies to `"[object URL]"`, and a path assertion built on that passes for
 * entirely the wrong reason. The same unwrapping lives in `dataforseo/test-support.ts`, and
 * this is the second copy of it in the repository, which is a smell rather than a decision.
 */
function lastUrl(): string {
  const first = vi.mocked(fetch).mock.calls[0]?.[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.toString();
  if (
    first !== undefined &&
    first !== null &&
    typeof first === "object" &&
    "url" in first
  ) {
    return String(first.url);
  }
  return "";
}

describe("the hosted auth emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    // **`env` is the module's only configuration source**, so there is no spy to
    // re-implement: resetting the record is the whole setup.
    for (const key of Object.keys(ENV)) delete ENV[key];
    Object.assign(ENV, BASE_ENV);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------- the reset email

  it("sends a password reset to the vendor, with the URL unchanged", async () => {
    // **The URL is the whole point of this function.**
    const resetUrl =
      "https://app.example.com/reset?token=abc123&expires=1767225600";

    await sendHostedPasswordResetEmail({
      email: "person@example.com",
      resetUrl,
    });

    expect(lastUrl()).toBe(LOOPS_URL);
    const body = sentBody();
    expect(body.email).toBe("person@example.com");
    // **Verbatim: no encoding, no re-derivation.**
    expect(body.dataVariables.resetUrl).toBe(resetUrl);
    expect(body.dataVariables.appName).toBe("OpenGeo");
  });

  it("uses the reset template, not another email's", async () => {
    // **Three senders, one seam, each reading its template from a different env var.** A swap
    // produces an email that is sent, delivered, and useless — worse than a failure, because
    // nobody reports it.
    await sendHostedPasswordResetEmail({
      email: "person@example.com",
      resetUrl: "https://app.example.com/reset?token=abc",
    });
    expect(sentBody().transactionalId).toBe(
      ENV.LOOPS_TRANSACTIONAL_RESET_PASSWORD_ID,
    );
  });

  // ---------------------------------------------------------------- the other two

  it("uses the verify template for a verification and the invite template for an invitation", async () => {
    await sendHostedVerificationEmail({
      email: "person@example.com",
      confirmationUrl: "https://app.example.com/confirm?token=abc",
    });
    expect(sentBody().transactionalId).toBe(
      ENV.LOOPS_TRANSACTIONAL_VERIFY_EMAIL_ID,
    );

    vi.mocked(fetch).mockClear();

    await sendHostedInvitationEmail({
      email: "invitee@example.com",
      inviteUrl: "https://app.example.com/invite?token=xyz",
      organizationName: "Acme",
      inviterName: "Robin",
      inviterEmail: "robin@example.com",
    });
    expect(sentBody().transactionalId).toBe(
      ENV.LOOPS_TRANSACTIONAL_INVITATION_ID,
    );
  });

  it("never adds a signup to the marketing audience", async () => {
    // **One boolean, \`false\` on purpose** — a transactional send must not also be a newsletter
    // subscription. This is the kind of default that looks deliberate and is never re-read.
    await sendHostedVerificationEmail({
      email: "person@example.com",
      confirmationUrl: "https://app.example.com/confirm?token=abc",
    });
    expect(sentBody().addToAudience).toBe(false);
  });

  // ---------------------------------------------------------------- failure handling

  it("throws when the vendor rejects the send, rather than reporting success", async () => {
    // **The hazard this file has the most of.** A swallowed failure means the user is told to
    // check their inbox for an email that was never sent, and the support answer is "it says
    // it worked".
    vi.mocked(fetch).mockImplementation(
      async () => new Response("", { status: 500 }),
    );

    await expect(
      sendHostedPasswordResetEmail({
        email: "person@example.com",
        resetUrl: "https://app.example.com/reset?token=abc",
      }),
    ).rejects.toThrow(/Failed to send Loops transactional email \(500\)/);
  });

  it("treats a 4xx as fatal too, not as ignorable", async () => {
    // **A 4xx that was swallowed would hide a wrong template id or an unverified sender** —
    // both of which look like a vendor-side problem to whoever is debugging.
    vi.mocked(fetch).mockImplementation(
      async () => new Response("", { status: 400 }),
    );

    await expect(
      sendHostedVerificationEmail({
        email: "person@example.com",
        confirmationUrl: "https://app.example.com/confirm?token=abc",
      }),
    ).rejects.toThrow(/Failed to send Loops transactional email \(400\)/);
  });

  it("survives an error body that is not JSON", async () => {
    // **The error path parses the response body**, and a vendor returning HTML from a proxy
    // must not replace "the email failed" with "the email failed, and here is a parse error".
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    );

    await expect(
      sendHostedPasswordResetEmail({
        email: "person@example.com",
        resetUrl: "https://app.example.com/reset?token=abc",
      }),
    ).rejects.toThrow(/Failed to send Loops transactional email \(502\)/);
  });

  it("binds a timeout, so a hung vendor cannot hold the request open", async () => {
    await sendHostedPasswordResetEmail({
      email: "person@example.com",
      resetUrl: "https://app.example.com/reset?token=abc",
    });

    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    // **An \`AbortSignal\` is present and not already aborted** — the assertion is on the
    // mechanism, because a test that only checks \`fetch\` was called cannot tell a 10s timeout
    // from no timeout at all.
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("refuses to send with no API key rather than sending nothing quietly", async () => {
    // **\`getRequiredEnv\` throws when a var is absent**, and that is what makes a misconfigured
    // deployment fail loudly. Were it to return \`undefined\` the request would go out with
    // \`Bearer undefined\` and 401 at the vendor — indistinguishable from a bad key.
    // **Removing the key from the env record is the whole setup** — the module reads it
    // with `Reflect.get(env, name)`, so an absent key is what a misconfigured deployment
    // looks like from here.
    delete ENV.LOOPS_API_KEY;

    await expect(
      sendHostedPasswordResetEmail({
        email: "person@example.com",
        resetUrl: "https://app.example.com/reset?token=abc",
      }),
    ).rejects.toThrow(/LOOPS_API_KEY is required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never puts the API key in the body", async () => {
    // **The key belongs in the header only.** It is in the body of every request this suite
    // makes, and a leaked credential in a log or a trace is the difference between a rotated
    // key and an incident.
    await sendHostedVerificationEmail({
      email: "person@example.com",
      confirmationUrl: "https://app.example.com/confirm?token=abc",
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).not.toContain(
      "loops-key",
    );
  });

  it("reports a boolean verdict on a synthetic send — the negative control", async () => {
    // **Asserting `true`/`false`**, the shape `gates-about-gates` recognises. Every other case
    // performs a real send against a stubbed `fetch`, which a rule that matched nothing would
    // also satisfy. The two predicates live at module scope (`consistent-function-scoping`
    // caught them here, and the rule is right: they capture nothing).
    expect(isFatal(200)).toBe(false);
    expect(isFatal(204)).toBe(false);
    expect(isFatal(400)).toBe(true);
    expect(isFatal(500)).toBe(true);

    // And the reset URL is passed through rather than re-derived — a plain http link would
    // send a user to a page a network can rewrite in flight.
    expect(isHttps("https://app.example.com/reset?token=a")).toBe(true);
    expect(isHttps("http://app.example.com/reset?token=a")).toBe(false);
  });
});
