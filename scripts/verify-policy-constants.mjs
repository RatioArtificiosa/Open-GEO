#!/usr/bin/env node
/**
 * Prove the policy gate can fail.
 *
 * A gate that has never been watched fail is not known to be a gate. This
 * harness mutates each of the gate's rules in turn and asserts the gate goes
 * red — then restores from disk and never `git checkout`, because the ledger
 * records that `git checkout -- <file>` once reverted a commit's worth of
 * uncommitted work. **Every restore here copies a `.mutbak` back.**
 *
 * ## Where this lives, and why
 *
 * It moved out of `web/scripts/` with the gate it verifies. The nightly
 * budgets are the app's `src/shared/nightly-budgets.ts`, so a harness that
 * mutated `src/shared/nightly-budgets.ts` from `web/` was mutating a file the
 * gate never read — and the mutations reported as **surviving**, which is the
 * outcome this harness exists to distinguish from a gate that genuinely cannot
 * see the defect.
 *
 * ## The mutations that are not here any more
 *
 * Three of the original six mutated `MARKUP` in `src/routes/_marketing/pricing.tsx`.
 * That constant is gone: the markup is an operator setting resolved per request on
 * the server, and `check-business-model.mjs` rule 2 now bans a published figure
 * rather than checking one. **A mutation against a rule that no longer exists is
 * worse than no mutation**, because it reports a survivor for a gate that is
 * working exactly as intended.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const GATE = "scripts/check-policy-constants.mjs";

const TARGETS = [
  "src/shared/nightly-budgets.ts",
  "src/serverFunctions/searchPerformance.ts",
];

const originals = new Map();
const backups = [];
for (const rel of TARGETS) {
  const p = join(ROOT, rel);
  originals.set(rel, readFileSync(p, "utf8"));
  const bak = `${p}.mutbak`;
  copyFileSync(p, bak);
  backups.push(bak);
}

const restore = () => {
  for (const [rel, text] of originals) writeFileSync(join(ROOT, rel), text);
};

function runGate() {
  const r = spawnSync("node", [GATE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    shell: true,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("baseline:");
const base = runGate();
console.log(`  exit ${base.code} — ${base.code === 0 ? "GREEN" : "RED"}\n`);
if (base.code !== 0) {
  console.log(base.out.slice(-1500));
  process.exit(1);
}

const MUTATIONS = [
  {
    name: "the nightly sweep limit is restated in a service",
    // **The real bug this gate was built for.** Four services once each
    // declared `?? 25` and every comment credited the others.
    file: "src/serverFunctions/searchPerformance.ts",
    find: "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;",
    replace:
      "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;\nconst NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
  },
  {
    name: "a policy is declared in the wrong module",
    file: "src/serverFunctions/searchPerformance.ts",
    find: "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;",
    replace:
      "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;\nexport const NIGHTLY_BUDGET_USD = { etv: 5 };",
  },
  {
    name: "a policy stops being exported",
    file: "src/shared/nightly-budgets.ts",
    find: "export const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
    replace: "const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
  },
  {
    name: "a policy is declared twice",
    file: "src/shared/nightly-budgets.ts",
    find: "export const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
    replace:
      "export const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;\nexport const NIGHTLY_PROJECT_SWEEP_LIMIT = 30;",
  },
  {
    name: "the gate scans a source tree twice",
    // **A regression control, and the one that earned its place.**
    //
    // The duplicate `src` glob reported every policy as declared in two
    // places. It had been invisible for as long as the gate ran from `web/`,
    // where one of the globs pointed at a directory that did not exist. A
    // gate that only works because a path is wrong is worse than a gate that
    // fails — and a harness that cannot reproduce the fix cannot protect it.
    gateEdit: true,
  },
];

let survivors = 0;

for (const m of MUTATIONS) {
  restore();

  if (m.gateEdit) {
    const gatePath = join(ROOT, GATE);
    const gateText = readFileSync(gatePath, "utf8");
    const anchor = '...sourceFiles(join(ROOT, "scripts")),';
    if (!gateText.includes(anchor)) {
      console.log(
        `SKIPPED  ${m.name} — anchor not found, so this rule went untested`,
      );
      survivors += 1;
      continue;
    }
    const mutatedGate = gateText.replace(
      anchor,
      `${anchor}\n  ...sourceFiles(join(ROOT, "src")),`,
    );
    const gateBak = `${gatePath}.mutbak`;
    copyFileSync(gatePath, gateBak);
    writeFileSync(gatePath, mutatedGate);
    const result = runGate();
    copyFileSync(gateBak, gatePath);
    restore();

    if (result.code === 0) {
      console.log(`SURVIVED ${m.name}   <-- the gate cannot see this`);
      survivors += 1;
    } else {
      console.log(`KILLED  ${m.name}`);
    }
    continue;
  }

  const path = join(ROOT, m.file);
  const text = readFileSync(path, "utf8");

  if (!text.includes(m.find)) {
    console.log(
      `SKIPPED  ${m.name} — anchor not found, so this rule went untested`,
    );
    survivors += 1;
    continue;
  }

  writeFileSync(path, text.replace(m.find, m.replace));
  const result = runGate();
  restore();

  if (result.code === 0) {
    console.log(`SURVIVED ${m.name}   <-- the gate cannot see this`);
    survivors += 1;
  } else {
    console.log(`KILLED  ${m.name}`);
  }
}

/**
 * **Delete the backups, not the restore.**
 *
 * The first version kept them, on the theory that a `.mutbak` left behind is
 * harmless. It is not: `git status` then shows an untracked copy of a source
 * file, which is exactly the kind of leftover that makes the next reader
 * wonder what was mutated here and whether it was reverted. The restore above
 * has already written the originals, so the backups have nothing left to say.
 */
for (const bak of [...backups, `${join(ROOT, GATE)}.mutbak`]) {
  try {
    rmSync(bak, { force: true });
  } catch {
    /* best effort */
  }
}

console.log(
  survivors === 0
    ? "\nall mutations killed — the gate is not vacuous"
    : `\n${survivors} mutation(s) survived — the gate cannot see these`,
);
process.exit(survivors === 0 ? 0 : 1);
