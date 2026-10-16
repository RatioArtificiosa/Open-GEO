export const HOSTED_PASSWORD_MIN_LENGTH = 8;
export const HOSTED_PASSWORD_MAX_LENGTH = 128;

export const userAdditionalFields = {
  analyticsOptedOut: {
    type: "boolean" as const,
    defaultValue: () => false,
    required: false as const,
    input: true as const,
  },
};

export const baseAuthOptions = {
  emailAndPassword: {
    enabled: true,
    disableSignUp: false,
    minPasswordLength: HOSTED_PASSWORD_MIN_LENGTH,
    maxPasswordLength: HOSTED_PASSWORD_MAX_LENGTH,
  },
  /**
   * Brute-force protection on the password endpoints, stored in the database.
   *
   * Better Auth's default limiter is in-memory, which on Workers is one bucket
   * per isolate — an attacker with N concurrent connections gets N budgets.
   * `storage: "database"` makes the bucket global via the adapter's rateLimit
   * table (both dialects; see the schema). The password endpoints get their own
   * tight rules (10/min): Turnstile already gates sign-up bots, but captcha
   * farms solve captchas while a rate cap stops the loop regardless. The
   * general 100/min budget leaves legitimate bursts (tab restores, retries)
   * alone. Client IP resolution (cf-connecting-ip) is configured alongside in
   * auth-config.ts — without it every isolate shares one bucket and the limit
   * throttles the platform instead of the attacker.
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "database" as const,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
    },
  },
  user: {
    additionalFields: userAdditionalFields,
  },
  session: {
    // Serve getSession from a signed cookie instead of a DB round trip. The
    // session lookup runs on every authenticated request, and the DB lives in
    // us-east — from far colos that single query was ~1s of wall time. The
    // trade-off is revocation lag: a session revoked elsewhere (sign-out on
    // another device, password reset) stays valid on an already-issued cookie
    // for up to maxAge. Authorization still hits the DB via the canonical
    // project-access checks, so the cookie only vouches for identity.
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
};
