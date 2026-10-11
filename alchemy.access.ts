// The contract shared by the two email-gated Cloudflare Access boundaries —
// the per-stage self-host gate (alchemy.run.ts) and the persistent preview
// wildcard. Worker naming, the WORKERS_SUBDOMAIN shape, the allowed-emails
// parsing, and the policy/application shape define who gets through which
// hostnames; keep them in one place so the two gates cannot drift.
//
// **The preview half of this contract moved to the private repo.** The script
// that deploys the wildcard application (`alchemy.preview-access.run.ts`) lives
// beside the workflow and credentials it uses, so the public copy of this module
// no longer names it. The duplicate-file drift this module was written to prevent
// is therefore why `previewWildcard` went with it and the self-host exports —
// `workerName`, `readWorkersSubdomain`, `requireAllowedEmails`,
// `emailAccessGate`, `HOSTED_PROD_STAGE` — stayed: `alchemy.run.ts` is a public
// entry point a self-hoster runs, and each of those is on its path.
//
// The one copy that can't import this module is the shell in
// .github/workflows/pr-preview.yml — its `open-geo-<stage>` naming stays
// comment-synced (and is backstopped by the workflow's Access verify step).

import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const WORKER_PREFIX = "open-geo";

// The one stage that adopts opengeo.so's live hosted resources (unsuffixed
// names, app.opengeo.so domain, Postgres). Deliberately not "prod" so a
// self-hoster's stage name can't collide with the adoption path.
export const HOSTED_PROD_STAGE = "hosted-prod";

export const workerName = (stage: string) =>
  stage === HOSTED_PROD_STAGE ? WORKER_PREFIX : `${WORKER_PREFIX}-${stage}`;

/** Reads and validates the account's workers.dev subdomain. */
export const readWorkersSubdomain = ({ required }: { required: boolean }) =>
  Effect.gen(function* () {
    const subdomain = (yield* Config.string("WORKERS_SUBDOMAIN").pipe(
      Config.withDefault(""),
    )).trim();
    if (subdomain.endsWith(".workers.dev") || (!subdomain && !required)) {
      return subdomain;
    }
    return yield* Effect.die(
      new Error(
        `Set WORKERS_SUBDOMAIN to the account's full workers.dev subdomain (shown under Workers & Pages)${required ? "." : ", or leave it unset."}`,
      ),
    );
  });

/** Reads ACCESS_ALLOWED_EMAILS; dies with `remedy` when none are set. */
export const requireAllowedEmails = (remedy: string) =>
  Effect.gen(function* () {
    const emails = (yield* Config.string("ACCESS_ALLOWED_EMAILS").pipe(
      Config.withDefault(""),
    ))
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) {
      return yield* Effect.die(new Error(remedy));
    }
    return emails;
  });

/** The gate itself: an email allow-policy on a self-hosted Access application. */
export const emailAccessGate = (options: {
  policyId: string;
  applicationId: string;
  policyName: string;
  applicationName: string;
  domain: string;
  emails: string[];
}) =>
  Effect.gen(function* () {
    const allow = yield* Cloudflare.Access.Policy(options.policyId, {
      name: options.policyName,
      decision: "allow",
      include: options.emails.map((email) => ({ email: { email } })),
    });
    return yield* Cloudflare.Access.Application(options.applicationId, {
      type: "self_hosted",
      name: options.applicationName,
      domain: options.domain,
      policies: [allow.policyId],
    });
  });
