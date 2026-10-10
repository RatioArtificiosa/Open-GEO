/**
 * A shared-secret HTTP Basic gate for open deployments.
 *
 * ## Why this exists
 *
 * `AUTH_MODE=local_noauth` grants every caller a full admin identity. That is
 * fine on `localhost`, and it is **not fine on a `workers.dev` URL**, which is
 * public by construction: `/projects` returned 200 unauthenticated on the
 * preview worker, with an empty database behind it at the time and real tenant
 * data the moment anyone signs up.
 *
 * The two real auth modes both need something a preview does not have yet:
 * - **`cloudflare_access`** needs a Zero Trust team, which needs `Access` to be
 *   enabled on the account — a dashboard one-click the deploy cannot perform
 *   (`access.api.error.not_enabled`).
 * - **`hosted`** needs `better-auth` **plus Google OAuth credentials**, because
 *   `getSocialProviders()` throws without them.
 *
 * So a preview stage had no way to be closed. This is that way.
 *
 * ## What it is, and what it is not
 *
 * A standard staging gate. One shared secret, HTTP Basic, compared in constant
 * time. It is **not** authentication and it must not be described as such —
 * there is one credential shared by everyone with it, no revocation, no
 * per-user identity.
 *
 * It exists so the window between "deployed" and "real auth" is closed rather
 * than merely known about. When `cloudflare_access` becomes available, set
 * `AUTH_MODE=cloudflare_access` and this gate stops applying by construction,
 * because it only runs for `local_noauth`.
 *
 * ## How it is armed
 *
 * On, when the deploy sets `PREVIEW_GATE_SECRET` and `AUTH_MODE=local_noauth`.
 * Off in every other case, including self-hosted Docker — an operator running
 * `local_noauth` on their own machine suffers no prompt.
 *
 * **Unset means open, not closed.** Fail-closed here would break every existing
 * self-host deployment at startup, which is a worse failure than the one this
 * gates; the secret is what makes an open deployment a private one.
 */

/** The username the gate accepts. Only the secret needs rotating. */
const GATE_USERNAME = "opengeo";

/** Paths that must answer without credentials, so a gate cannot wedge them. */
const ALLOWED_PATHS = ["/api/health"];

/**
 * Compare two strings without leaking their prefix through timing.
 *
 * Length is compared first because it is not secret, and the accumulator is
 * only ever OR-ed so the loop never short-circuits.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    // Subscripting a Uint8Array yields `number`, so no cast is needed — and the
    // type-aware linter rejects one here as unnecessary.
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

/** Decode an `Authorization: Basic ...` header into `username:password`. */
function readBasic(request: Request): { user: string; pass: string } | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return null;
  const decoded = atob(header.slice("Basic ".length).trim());
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  return {
    user: decoded.slice(0, separator),
    pass: decoded.slice(separator + 1),
  };
}

/**
 * Reject the request with a Basic challenge, or return null to let it through.
 *
 * Null is the allow result. That keeps the call site a single `if` and makes the
 * gate impossible to apply twice.
 */
export function enforceOpenDeploymentGate(
  request: Request,
  authMode: string,
  secret: string | undefined,
): Response | null {
  if (authMode !== "local_noauth") return null;
  if (!secret || secret.trim() === "") return null;

  const pathname = new URL(request.url).pathname;
  if (ALLOWED_PATHS.includes(pathname)) return null;

  const credentials = readBasic(request);
  if (
    credentials &&
    timingSafeEqual(credentials.user, GATE_USERNAME) &&
    timingSafeEqual(credentials.pass, secret)
  ) {
    return null;
  }

  // **The body explains the mechanism, not just the refusal.** An operator who
  // lands here on a fresh deploy needs to know the shape of the credential to
  // reach it, and a bare 401 sends them looking for an authentication system
  // that does not exist on this stage.
  return new Response(
    `OpenGeo preview is gated.\n\n` +
      `This deployment runs AUTH_MODE=local_noauth, which would otherwise grant\n` +
      `every visitor a full admin account. Set PREVIEW_GATE_SECRET to close it.\n\n` +
      `Sign in with HTTP Basic: username "${GATE_USERNAME}", password = PREVIEW_GATE_SECRET.\n` +
      `  curl -u "${GATE_USERNAME}:$PREVIEW_GATE_SECRET" https://<worker-url>/\n\n` +
      `This gate is a stopgap for a stage with no Zero Trust team yet. Set\n` +
      `AUTH_MODE=cloudflare_access to replace it with real authentication.\n`,
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="OpenGeo preview", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
        // A gated page must not be cached by a shared proxy and served to the
        // next caller who has the password.
        "Cache-Control": "no-store",
      },
    },
  );
}
