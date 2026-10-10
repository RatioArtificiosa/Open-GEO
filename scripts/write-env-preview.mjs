/**
 * Builds `.env.preview` from `.env.example` plus the credentials in the root
 * `.env`, so a preview deploy is one command rather than a transcription job.
 *
 * Idempotent: rewrites the file from scratch each run. Values are read from the
 * root `.env` (never echoed) and written only into this file, which is
 * gitignored by the `.env.*` rule in `.gitignore` (with `!.env.example` and
 * `!.env.*.example` as the only exceptions).
 *
 * ## What a preview is, and what it deliberately is not
 *
 * A preview stage deploys `open-geo-db-preview`, `open-geo-r2-preview`,
 * `open-geo-kv-preview`, `open-geo-oauth-kv-preview` and the `open-geo` /
 * `open-geo-audit` workers. Nothing in it is named anything like `qqq`, and the
 * `qqq` Pages project and `qqq.codes` zone in this account are not referenced by
 * any resource in `alchemy.run.ts`.
 *
 * `DEMO_MODE=true` is the important choice. A preview exists to prove the
 * deployment works; a DataForSEO key in a preview bills real money against the
 * preview's every page load. Demo mode returns fixture data through the same
 * code path, so the preview is a faithful shape without being a bill.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const here = process.cwd();
const root = join(here, "..");

/** Keys copied from the root `.env`, and nothing else. */
const PASSTHROUGH = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "DATAFORSEO_API_KEY",
  "DATAFORSEO_USERNAME",
  "DATAFORSEO_PASSWORD",
];

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const rootEnv = readEnvFile(join(root, ".env"));
const template = readFileSync(join(here, ".env.example"), "utf8");

/**
 * Every key `.env.example` documents, with its comment text preserved.
 *
 * Built by uncommenting the example rather than hand-writing a new file, so the
 * two cannot drift: a key added to `.env.example` shows up here on the next run
 * instead of being silently missing from the deploy.
 */
const documented = new Map();
for (const line of template.split("\n")) {
  const commented = /^#\s?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (commented && !documented.has(commented[1])) {
    documented.set(commented[1], commented[2]);
  }
}

/**
 * The account the deploy targets.
 *
 * Wrangler resolves this from the API token, but **alchemy does not**: in
 * env-var mode (`CI=1`, which is the only non-interactive way to deploy) it
 * requires `CLOUDFLARE_ACCOUNT_ID` and fails with *"No credentials configured for
 * 'Cloudflare'"* if it is absent. So this is written explicitly, and it is the
 * same account wrangler would resolve on its own — the value comes from the
 * token's own account, never from a guess.
 */
const ACCOUNT_ID = "6b0f8e3047b6ce71564148799ab2abfc";

const lines = [
  "## ---------------------------------------------------------------------------",
  "## Generated for the hosted preview stage. gitignored by the `.env.*` rule.",
  "## Regenerate with: node scripts/write-env-preview.mjs",
  "## ---------------------------------------------------------------------------",
  "## Secrets come from the root `.env` and are never echoed.",
  "",
];

for (const key of PASSTHROUGH) {
  const value = key === "CLOUDFLARE_ACCOUNT_ID" ? ACCOUNT_ID : rootEnv[key];
  if (value) {
    lines.push(`${key}=${value}`);
  } else {
    lines.push(`# ${key}=`);
  }
}

for (const [key, exampleValue] of documented) {
  if (PASSTHROUGH.includes(key)) continue;
  // Keys not in the root `.env` keep the example's own value, commented as the
  // example had it, so a reader sees what the default is and that it is unset.
  if (exampleValue === "") {
    lines.push(`# ${key}=`);
  } else {
    lines.push(`${key}=${exampleValue}`);
  }
}

lines.push(
  "",
  "## ---------------------------------------------------------------------------",
  "## Preview-only settings",
  "## ---------------------------------------------------------------------------",
  "",
  "## **Demo mode on a preview.** A preview proves the deployment, not the vendor",
  "## bill: every page load would otherwise spend real DataForSEO money, and demo",
  "## mode returns fixture data through the same code path. Flip to false only on",
  "## a stage whose spend you intend to pay for.",
  "DEMO_MODE=true",
  "",
  "## A preview has no DNS and no Cloudflare Access policy in front of it, so",
  "## hosted auth cannot resolve back to a URL nobody can reach yet. `local_noauth`",
  "## grants full anonymous admin and is safe here *only* because the worker is",
  "## unguessable and unadvertised. See the audit note: this mode fails open, so it",
  "## must never reach a stage with a public hostname.",
  "AUTH_MODE=local_noauth",
  "",
  "## Set to the account's workers.dev subdomain once the first preview deploy",
  "## has created the worker (shown under Workers & Pages in the dashboard).",
  "## Alchemy derives this automatically when unset; set it to override.",
  "# WORKERS_SUBDOMAIN=<account>.workers.dev",
  "",
);

writeFileSync(join(here, ".env.preview"), lines.join("\n"));
console.log("wrote .env.preview");

// Report what is wired without printing a value, so a missing credential is
// visible before the deploy rather than as a mid-deploy failure.
const preview = readEnvFile(join(here, ".env.preview"));
const missing = PASSTHROUGH.filter((key) => !preview[key]);
if (missing.length > 0) {
  console.log(`not wired: ${missing.join(", ")}`);
}
for (const key of Object.keys(preview)) {
  if (
    key === "DATAFORSEO_API_KEY" ||
    key === "CLOUDFLARE_API_TOKEN" ||
    key === "CLOUDFLARE_ACCOUNT_ID"
  ) {
    continue;
  }
  console.log(`  ${key}=${preview[key] === "" ? "(unset)" : "set"}`);
}
console.log(
  `  DATAFORSEO_API_KEY=${preview.DATAFORSEO_API_KEY ? "wired" : "MISSING"}`,
);
console.log(
  `  CLOUDFLARE_API_TOKEN=${preview.CLOUDFLARE_API_TOKEN ? "wired" : "MISSING"}`,
);
console.log(
  `  CLOUDFLARE_ACCOUNT_ID=${preview.CLOUDFLARE_ACCOUNT_ID ? "wired" : "MISSING"}`,
);

const blocking = PASSTHROUGH.filter((key) => !preview[key]);
if (blocking.length > 0) {
  console.log(
    `\nBLOCKING: ${blocking.join(", ")} missing — the deploy cannot authenticate.`,
  );
  process.exitCode = 1;
}
console.log(
  "\nNext: CI=1 npx alchemy cloudflare bootstrap --env-file .env.preview",
);
