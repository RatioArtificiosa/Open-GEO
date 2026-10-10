#!/usr/bin/env node
// Guards the two self-host compose files against the failure that cost a
// self-hoster their whole database, silently.
//
// ## What was wrong
//
// `deploy.docker-compose.yml` — the Coolify/Dokploy path — mounted its
// persistence volume at `/app/data`:
//
//     volumes:
//       - opengeo-data:/app/data
//
// while `docker-entrypoint.sh` runs `wrangler d1 migrations apply DB --local`,
// and Wrangler persists local D1 state under the **project working directory**
// (`/app/.wrangler/state/...`), because `WORKDIR /app`. The sibling
// `compose.yaml` had it right (`open_seo_data:/app/.wrangler`).
//
// Nothing wrote to `/app/data`. Every redeploy therefore created a fresh, empty
// database while the file's own comment promised *"mount a volume at /app/data
// so the SQLite database survives redeploys. Without it you lose local data on
// every push."* The comment stated the intent correctly and the path was wrong,
// so the line survived review: it looks deliberate and the prose above it looks
// authoritative.
//
// ## The second half of the same file
//
// Its header declares `DATAFORSEO_API_KEY` **required**, and the `environment:`
// block forwarded only `PORT`, `AUTH_MODE`, `DEMO_MODE`,
// `BETTER_AUTH_SECRET` and `OPENROUTER_API_KEY`. A self-hoster following the
// documented quickstart got a green healthcheck and a UI where every SEO
// feature was dead. It also lacked `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, which
// `compose.yaml` documents as *"Required for local Docker self-hosting: exposes
// Compose env vars to cloudflare:workers bindings"* — for a Workers-based app,
// without it the env vars are set in the shell and invisible to `env.FOO`.
//
// ## Why this is a script and not a test
//
// It has to run over the compose files, which live outside `src/`, and it has to
// fail `pnpm ci:check`. A vitest file would work too; a plain node script keeps
// it in the same family as `check-migration-journals.mjs` and the business-model
// gates, and lets it read the files with no dependency at all.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
}

// ── The volume path ─────────────────────────────────────────────────────────
//
// Both files must mount persistence at `/app/.wrangler`. Read from
// `Dockerfile.selfhost`'s WORKDIR and `package.json`'s `db:migrate:local`
// rather than hardcoded, so the check cannot drift from the two facts that
// make the path correct.
const dockerfile = readFileSync(join(REPO_ROOT, "Dockerfile.selfhost"), "utf8");
const packageJson = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
);
const migrateLocal = packageJson.scripts?.["db:migrate:local"] ?? "";

check(
  /WORKDIR\s+\/app\b/.test(dockerfile),
  "Dockerfile.selfhost must set WORKDIR /app — the compose volume path below " +
    "depends on it, and the check that follows is derived from it.",
);
check(
  /wrangler d1 migrations apply\b/.test(migrateLocal),
  "db:migrate:local must be `wrangler d1 migrations apply ...` — the " +
    "persistence path is wherever Wrangler keeps local D1 state.",
);

const EXPECTED_MOUNT = "/app/.wrangler";
const WRONG_MOUNT = "/app/data";

for (const file of ["compose.yaml", "deploy.docker-compose.yml"]) {
  const path = join(REPO_ROOT, file);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");

  // Every `volumes:` entry in the file, so a second service added later is
  // covered by the same rule rather than exempted by being the second one.
  const mounts = [...text.matchAll(/^\s*-\s*[\w.-]+:(\S+)\s*$/gm)].map((m) =>
    m[1].replace(/^["']|["']$/g, ""),
  );
  check(
    mounts.length > 0,
    `${file}: no bind mounts found. A self-host compose file with a ` +
      `persistence volume is the whole point of the file.`,
  );
  for (const mount of mounts) {
    check(
      mount !== WRONG_MOUNT,
      `${file}: mounts the persistence volume at ${WRONG_MOUNT}, which ` +
        `nothing in the image writes to. Wrangler keeps local D1 state under ` +
        `the project working directory, so the volume must be ` +
        `${EXPECTED_MOUNT}. Every redeploy otherwise starts from an empty ` +
        `database — projects, cached rankings and GDPR-relevant archives — ` +
        `with no error and no log line.`,
    );
    check(
      mount === EXPECTED_MOUNT,
      `${file}: persistence volume "${mount}" is not ${EXPECTED_MOUNT}. ` +
        `docker-entrypoint.sh runs db:migrate:local, so the volume has to ` +
        `cover the directory Wrangler actually writes.`,
    );
  }
}

// ── The two files must agree on the volume path ─────────────────────────────
//
// The bug was a *disagreement* between two files that look like alternatives.
// Comparing them directly catches the next one, whatever it is.
{
  const a = readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8");
  const b = readFileSync(join(REPO_ROOT, "deploy.docker-compose.yml"), "utf8");
  const mountA = [...a.matchAll(/^\s*-\s*[\w.-]+:(\S+)\s*$/gm)].map(
    (m) => m[1],
  );
  const mountB = [...b.matchAll(/^\s*-\s*[\w.-]+:(\S+)\s*$/gm)].map(
    (m) => m[1],
  );
  check(
    mountA.length > 0 && mountB.length > 0 && mountA[0] === mountB[0],
    `compose.yaml mounts "${mountA[0]}" but deploy.docker-compose.yml mounts ` +
      `"${mountB[0]}". These two files look like interchangeable self-host ` +
      `paths, so a divergence means one of them loses data silently. Keep the ` +
      `volume path in lockstep.`,
  );
}

// ── The Workers env passthrough ──────────────────────────────────────────────
//
// `compose.yaml` documents this as *"Required for local Docker self-hosting:
// exposes Compose env vars to cloudflare:workers bindings."* Without it the
// `environment:` values are set in the container's shell and invisible to
// `env.*`, so every vendor credential the file forwards is decorative.
//
// `deploy.docker-compose.yml` is the file that forgot it — the reason the gate
// exists. Both files carry it, because the second one lost a database to a
// *different* omission in the same block, and the two are alternatives.
for (const file of ["compose.yaml", "deploy.docker-compose.yml"]) {
  const path = join(REPO_ROOT, file);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  check(
    /^\s*-\s*CLOUDFLARE_INCLUDE_PROCESS_ENV=true\s*$/m.test(text),
    `${file}: must set CLOUDFLARE_INCLUDE_PROCESS_ENV=true. Without it the ` +
      `environment: values are set in the container's shell and invisible to ` +
      `\`env.*\` bindings, so every vendor credential the file forwards — ` +
      `DATAFORSEO_API_KEY, BETTER_AUTH_SECRET — never reaches the app.`,
  );
}

// ── The vendor credential the deploy file's own header requires ─────────────
{
  const deploy = readFileSync(
    join(REPO_ROOT, "deploy.docker-compose.yml"),
    "utf8",
  );
  // The header's "Required environment variables" block names what it needs;
  // the `environment:` list must forward each of those names.
  //
  // `\s+` after the `#`, not `\s{2}`: the block is indented with three spaces
  // and an over-precise pattern here matches nothing, which is the worst
  // outcome — the check passes by not running. A gate that silently matches
  // empty is worse than no gate, because it reads as coverage.
  const required = [...deploy.matchAll(/^#\s+([A-Z][A-Z0-9_]*)\s{2,}/gm)].map(
    (m) => m[1],
  );

  for (const name of required) {
    check(
      new RegExp(`^\\s*-\\s*${name}=`, "m").test(deploy),
      `deploy.docker-compose.yml: the header names ${name} as required, but ` +
        `the environment: block never forwards it. A self-hoster following ` +
        `this file's documented steps gets a green healthcheck and dead ` +
        `features.`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    "check-docker-selfhost-compose: " +
      problems.length +
      " problem(s) in the self-host compose files\n",
  );
  for (const problem of problems) console.error("  - " + problem);
  console.error(
    "\nThese two files deploy the same product with the same image. A " +
      "divergence between them is invisible to every other gate and costs a " +
      "deployment its database or its vendor key.",
  );
  process.exit(1);
}

console.log(
  "check-docker-selfhost-compose: volume path, env forwarding and " +
    "cross-file agreement all hold",
);
