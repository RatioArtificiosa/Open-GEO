#!/usr/bin/env node
/**
 * Prove the business-model gate can fail.
 *
 * A gate that has only ever passed is a script reporting success. Each rule is
 * violated in turn against the **built** homepage, and the gate has to notice.
 *
 * Restores from an on-disk backup — never `git checkout`, which the ledger records
 * once reverting a commit's worth of uncommitted work — and reports green after
 * restore, because a verifier that leaves its subject poisoned reports the next
 * run's findings as its own.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const HOME = join(ROOT, "web", "dist", "client", "index.html");
const original = readFileSync(HOME, "utf8");
const backup = `${HOME}.mutbak`;
copyFileSync(HOME, backup);

const restore = () => writeFileSync(HOME, original);

function runGate() {
  const r = spawnSync("node", ["scripts/check-business-model.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    shell: true,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("baseline:");
const base = runGate();
console.log(`  exit ${base.code} — ${base.code === 0 ? "GREEN" : "RED"}\n`);
if (base.code !== 0) {
  console.log(base.out.slice(-1200));
  process.exit(1);
}

const MUTATIONS = [
  {
    name: "the old pass-through claim returns",
    find: "No card, and no vendor account to set up.",
    replace: "No card. You pay DataForSEO directly.",
  },
  {
    name: "a zero-margin claim returns",
    find: "No card, and no vendor account to set up.",
    replace: "No card. $0.00 margin.",
  },
  {
    name: "the free tier is called uncapped again",
    find: "$10 of usage included.",
    replace: "$10 of usage included, and the free tier is uncapped.",
  },
  {
    name: "'bring your own key' comes back as the CTA",
    find: "We run the data layer.",
    replace: "Bring your own key.",
  },
  {
    // **Every instance, not one.** The first attempt replaced only the total row's
    // "+28%", and the gate still passed — correctly, because "28%" also appears in
    // the body copy and the table caption. A mutation of one instance of a
    // three-instance string is not a mutation of the rule.
    name: "the 28% disclosure is removed from the prose",
    all: ["a flat 28%", "including a flat 28% markup", "+28%"],
  },
  {
    name: "the copyright returns to the front page",
    find: "MIT licence",
    replace: "© 2026 Every App, Inc.",
  },
  // --- the direction rule, which is a different failure mode ---------------
  //
  // **All three are true sentences.** Self-hosting has no OpenGeo fee, and the
  // licence does let you run it yourself — which is exactly why a fact-checker does
  // not catch this class and a direction rule has to.
  {
    name: "'self-hosting is free' returns as the answer to a price question",
    find: "nothing to maintain",
    replace: "Self-hosting is free.",
  },
  {
    name: "'so you can self-host' returns as a cost tip",
    find: "nothing to maintain",
    replace:
      "It's also open source, so you can self-host with your own account.",
  },
  {
    name: "'control over your stack' returns as a benefit",
    find: "nothing to maintain",
    replace: "Control over your SEO stack, if you would rather run it.",
  },
];

let survivors = 0;

for (const m of MUTATIONS) {
  restore();
  const text = readFileSync(HOME, "utf8");

  const absent = m.all
    ? m.all.filter((s) => !text.includes(s))
    : m.find
      ? []
      : ["(no anchor)"];
  if (m.all ? absent.length > 0 : !text.includes(m.find)) {
    // **A skip counts as a survivor.** A mutation whose anchor stopped existing
    // quietly stops testing that rule, and the summary would claim a coverage it
    // did not earn.
    console.log(
      `SKIPPED  ${m.name} — ${absent.length} anchor(s) not found, so this rule went untested`,
    );
    survivors += 1;
    continue;
  }

  let mutated = text;
  if (m.all) {
    for (const s of m.all) mutated = mutated.split(s).join(m.replace);
  } else {
    mutated = mutated.replace(m.find, m.replace);
  }
  writeFileSync(HOME, mutated);
  const result = runGate();
  restore();

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
rmSync(backup, { force: true });

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
