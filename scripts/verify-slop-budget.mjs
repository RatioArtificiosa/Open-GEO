#!/usr/bin/env node
/**
 * Prove the slop budget can fail.
 *
 * A gate that has only ever passed is not a gate. It is a script that reports
 * success, and the one thing this project has learned repeatedly — stale `dist`,
 * a preview server 404ing every stylesheet, an insert that silently no-opped — is
 * that **something which looks green can be measuring nothing at all**.
 *
 * So this mutates each rule in turn and requires the gate to notice. Every
 * mutation restores the file from an on-disk backup, never from git: the ledger
 * records that `git checkout -- <file>` once reverted a whole commit's worth of
 * uncommitted work.
 */
import {
  copyFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const CSS = join(ROOT, "web", "dist", "client", "assets");
const HOME = join(ROOT, "web", "dist", "client", "index.html");

/** Every CSS file, so a mutation can be applied and undone across all of them. */
function cssFiles() {
  return readdirSync(CSS)
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(CSS, f));
}

const files = cssFiles();
const originals = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const homeOriginal = readFileSync(HOME, "utf8");
const backups = files.map((f) => `${f}.mutbak`);
files.forEach((f, i) => copyFileSync(f, backups[i]));
copyFileSync(HOME, `${HOME}.mutbak`);

const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  writeFileSync(HOME, homeOriginal);
};

function runGate() {
  const r = spawnSync("node", ["scripts/check-slop-budget.mjs"], {
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

/** Apply the first css file that contains `find`. */
function mutateCss(find, replace) {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (text.includes(find)) {
      writeFileSync(file, text.replace(find, replace));
      return true;
    }
  }
  return false;
}

const MUTATIONS = [
  {
    name: "the body font becomes Inter — the fingerprint",
    kind: "css",
    find: "Instrument Sans",
    replace: "Inter",
  },
  {
    name: "the grid budget is blown",
    kind: "add-grids",
    count: 12,
  },
  {
    name: "a countdown timer appears in the hero",
    kind: "home",
    find: "Generative Engine Optimization",
    replace: "Generative Engine Optimization — ends in 00:59:48",
  },
  {
    name: "a banned phrase is reintroduced",
    kind: "home",
    find: "Start free",
    replace: "Unlock your SEO with Start free",
  },
  {
    name: "a second h1 appears",
    kind: "home",
    find: "<h1",
    replace: "<h1 data-extra='1'></h1><h1",
  },
  {
    name: "three cards appear in a row",
    kind: "home",
    // **Injected before </body>, not after <body>.** Splicing into the
    // opening tag would break the tag's own attributes; the closing tag is
    // a stable anchor, and a `grid` of three cards there is read as a row
    // — the exact macrostructure the adjacency rule exists to forbid.
    find: "</body>",
    replace:
      '<div class="grid gap-4 grid-cols-3">' +
      '<div class="rounded-xl border border-[var(--color-border-subtle)] bg-white p-6">a</div>' +
      '<div class="rounded-xl border border-[var(--color-border-subtle)] bg-white p-6">b</div>' +
      '<div class="rounded-xl border border-[var(--color-border-subtle)] bg-white p-6">c</div>' +
      "</div></body>",
  },
  {
    name: "a stylesheet link is broken — the unstyled page",
    kind: "home",
    // **A literal, not a regex.** The href is content-hashed, so the name is
    // unpredictable but the suffix is not — and `.css"` as a pattern would match
    // the first stylesheet rather than the one this test means to break.
    find: '.css"',
    replace: '.css-that-does-not-exist"',
  },
];

let survivors = 0;

// **Restore and clean up on every exit path.** A verifier that can leave its
// subject poisoned is not a verifier: the next gate run reads `dist`, finds the
// injected violation and reports something nobody introduced. `finally` covers the
// throw, SIGINT covers the Ctrl-C, and neither is best-effort — the mutation window
// is inherently in-place, so a missed restore is a corrupted build artefact.
function cleanup() {
  restore();
  for (const backup of backups) rmSync(backup, { force: true });
  rmSync(`${HOME}.mutbak`, { force: true });
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  for (const m of MUTATIONS) {
    restore();
    let applied = false;

    if (m.kind === "css") {
      applied = mutateCss(m.find, m.replace);
    } else if (m.kind === "home") {
      const text = readFileSync(HOME, "utf8");
      if (text.includes(m.find)) {
        writeFileSync(HOME, text.replace(m.find, m.replace));
        applied = true;
      }
    } else if (m.kind === "add-grids") {
      const file = files.find((f) => f.includes("index")) ?? files[0];
      const text = readFileSync(file, "utf8");
      const extra = Array.from(
        { length: m.count },
        (_, i) => `.mut-grid-${i}{display:grid}`,
      ).join("");
      writeFileSync(file, text + "\n" + extra);
      // And put the classes on the page, or the budget correctly ignores them.
      const home = readFileSync(HOME, "utf8");
      writeFileSync(
        HOME,
        home.replace(
          "<body",
          `<body class="${Array.from({ length: m.count }, (_, i) => `mut-grid-${i}`).join(" ")}"`,
        ),
      );
      applied = true;
    }

    if (!applied) {
      // **A skip counts as a survivor.** The alternative is a script that prints a
      // smaller denominator than it earned and still exits 0 — so a mutation whose
      // anchor stopped existing would silently stop testing that rule while the
      // summary kept claiming the gate was exercised.
      console.log(
        `SKIPPED  ${m.name} — anchor not found, so this rule went untested`,
      );
      survivors += 1;
      continue;
    }

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
} finally {
  cleanup();
}

const after = runGate();
console.log(`\nsurvivors: ${survivors} of ${MUTATIONS.length}`);
console.log(
  `after restore: ${after.code === 0 ? "GREEN" : "RED"}\n${
    after.code === 0
      ? "\nEvery rule is shown able to fail."
      : "\nTHE GATE IS STILL RED AFTER RESTORE"
  }`,
);
if (survivors > 0 || after.code !== 0) process.exitCode = 1;
