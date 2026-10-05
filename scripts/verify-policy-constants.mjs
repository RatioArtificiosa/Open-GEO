#!/usr/bin/env node
/**
 * Prove the policy gate can fail — including the **value drift** case,
 * which needs a rebuild to be honest about.
 *
 * ## Why the rebuild matters
 *
 * The published-figure rule compares the percentage the code charges with
 * the percentage the built pages state. A mutation that changes only the
 * source leaves the build stale, and the rule then fails on the stale
 * build — which is real, but it does not prove the rule would still fire
 * after a rebuild.
 *
 * **The stronger claim is the inverse**: rebuild after changing `MARKUP`,
 * and the pricing page is built from the mutated source and says 90% — but
 * the homepage and `/open-source-seo` still say 28%, so the rule fails
 * **on a fresh build**. That is what makes it a check on the figure rather
 * than on staleness.
 *
 * ## Restores from disk, never `git checkout`
 *
 * The ledger records that `git checkout -- <file>` once reverted a commit's
 * worth of uncommitted work. **Every restore here copies a `.mutbak` back.**
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const TARGETS = [
  "src/shared/nightly-budgets.ts",
  "web/src/routes/_marketing/pricing.tsx",
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
  const r = spawnSync("node", ["scripts/check-policy-constants.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
    shell: true,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function rebuild() {
  const r = spawnSync("npx", ["vite", "build"], {
    cwd: join(ROOT, "web"),
    encoding: "utf8",
    timeout: 600000,
    shell: true,
  });
  return r.status === 0;
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
    name: "a local MARKUP shadows the exported one",
    // **Corrected twice.** The first attempt added `MARKUP_AGAIN = 1.28`,
    // and the gate did not fire — correctly, because `MARKUP_AGAIN` is not
    // a policy name and banning every repeated literal would flag every page
    // size in the codebase. **The mutation was wrong, not the gate.**
    //
    // The second put the local `MARKUP` in `pricing.tsx`, which is MARKUP's
    // home module, so the section 3 exemption swallowed it — also correct.
    // This one puts it in a service, which is the shape the original bug had.
    file: "src/serverFunctions/searchPerformance.ts",
    find: "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;",
    replace:
      "const STRIKING_DISTANCE_FETCH_LIMIT = 1000;\nconst MARKUP = 1.28;",
  },
  {
    name: "a policy is declared in the wrong module",
    file: "web/src/routes/_marketing/pricing.tsx",
    find: "export const MARKUP = 1.28;",
    replace:
      "export const MARKUP = 1.28;\nexport const NIGHTLY_BUDGET_USD = { etv: 5 };",
  },
  {
    name: "a policy stops being exported",
    file: "src/shared/nightly-budgets.ts",
    find: "export const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
    replace: "const NIGHTLY_PROJECT_SWEEP_LIMIT = 25;",
  },
  {
    name: "the published figure drifts from what we charge",
    // **Rebuilds, so the failure is not staleness.** After the rebuild the
    // pricing page is built from the mutated source and says 90% — but the
    // homepage and `/open-source-seo` still say 28%, so the rule fails on a
    // fresh build.
    file: "web/src/routes/_marketing/pricing.tsx",
    find: "export const MARKUP = 1.28;",
    replace: "export const MARKUP = 1.9;",
    rebuild: true,
  },
  {
    name: "a page that publishes no percentage at all",
    // **The vacuity guard, and it needs the rebuild.** Remove the
    // markup FAQ so the pricing page states no percentage at all.
    //
    // Without a rebuild this proves nothing: the gate reads the build,
    // and a stale build still carries the removed sentence, so the rule
    // passes on output the source no longer produces. **A vacuity check
    // that reads a stale build is checking the cache, not the page.**
    //
    // After the rebuild the pricing page states no percentage, and the
    // rule has to say so rather than pass.
    file: "web/src/routes/_marketing/pricing.tsx",
    find: "We add a flat {Math.round((MARKUP - 1) * 100)}% to the",
    replace: "We add a flat premium to the",
    rebuild: true,
  },
];

let survivors = 0;

for (const m of MUTATIONS) {
  restore();
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
  if (m.rebuild && !rebuild()) {
    console.log(
      `SKIPPED  ${m.name} — the rebuild failed, so this rule went untested`,
    );
    survivors += 1;
    continue;
  }
  const result = runGate();
  restore();
  if (m.rebuild) rebuild();

  if (result.code === 0) {
    console.log(`SURVIVED ${m.name}   <-- the gate cannot see this`);
    survivors += 1;
  } else {
    const rule = /FAIL ([^\n]+)/.exec(result.out)?.[1]?.trim() ?? "?";
    console.log(`KILLED   ${m.name}`);
    console.log(`           via: ${rule}`);
  }
}

restore();
for (const bak of backups) rmSync(bak, { force: true });
rebuild();

const after = runGate();
console.log(`\nsurvivors: ${survivors} of ${MUTATIONS.length}`);
console.log(
  `after restore: ${after.code === 0 ? "GREEN" : "RED"}${
    after.code === 0
      ? "\n\nEvery rule is shown able to fail."
      : "\n\nTHE GATE IS STILL RED AFTER RESTORE"
  }`,
);
if (survivors > 0 || after.code !== 0) process.exitCode = 1;
