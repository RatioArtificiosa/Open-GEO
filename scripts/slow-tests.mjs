#!/usr/bin/env node
/**
 * Report the **real per-test durations** for a vitest run, sorted slowest first.
 *
 * ## Why this exists
 *
 * Three times in one session a broken measurement nearly produced a confident false
 * conclusion, and twice the broken measurement looked like a *passing* one:
 *
 * 1. `tsc --noEmit | more && echo "clean"` printed `clean` over five real type
 *    errors, because `&&` fired on the **pipe's** exit status, not tsc's.
 * 2. vitest's `--reporter=json` reported **every test duration as `0`**. A reader
 *    scanning for slow tests sees "all fast" — exactly the wrong answer presented
 *    as a right one.
 * 3. The `--reporter=verbose` per-test times could not be parsed out of a
 *    PowerShell pipeline at all, and a failed parse returns an empty list, which
 *    also reads as "nothing to worry about".
 *
 * **An empty list and a list of zeroes are the same trap**: a failed measurement is
 * indistinguishable from a good one unless the tool says which it produced. So this
 * script refuses to print a table it could not obtain, and says so out loud rather
 * than exiting 0 over an empty result.
 *
 * ## What it does
 *
 * Runs vitest with the verbose reporter, **capturing stdout and stderr to a temp
 * file**, then parses the file. Writing to a file rather than a pipe is deliberate:
 * the reporter interleaves stderr progress with stdout results, ANSI colours every
 * line, and the per-test duration appears only in the verbose reporter's own line
 * format.
 *
 * ```
 * node scripts/slow-tests.mjs                     # whole suite
 * node scripts/slow-tests.mjs src/server/mcp      # a path
 * node scripts/slow-tests.mjs --budget 1000       # exit 1 if any test exceeds 1s
 * node scripts/slow-tests.mjs --top 15
 * ```
 *
 * ## `--budget`
 *
 * Optional, and the reason this is a tool rather than a report: it turns "how slow is
 * this test" into a check.
 *
 * **The default budget sits below the ceiling that already bit.** vitest's
 * `testTimeout` defaults to 5s and its `hookTimeout` to **10s** — and the OAuth flake
 * this was written for was a *hook*, so a budget on tests alone would not have caught
 * it. Which is why the script also reports **hook lines separately**: a slow
 * `beforeEach` spends a different, larger budget that no test-level setting reaches.
 *
 * That asymmetry is the finding. A test at 2.7s looks slow and gets a timeout; a hook
 * at 10.1s looks like a mystery, because the number in the report is 10000ms and the
 * failing test is not the slow one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

let budget = null;
let top = 12;
const targets = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--budget") {
    budget = Number(argv[i + 1]);
    i += 1;
  } else if (a === "--top") {
    top = Number(argv[i + 1]);
    i += 1;
  } else {
    targets.push(a);
  }
}

if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) {
  console.error(
    `--budget needs a positive number of milliseconds, got "${argv[1]}"`,
  );
  process.exit(2);
}
if (!Number.isFinite(top) || top < 1) {
  console.error(`--top needs a positive integer, got "${argv[1]}"`);
  process.exit(2);
}

const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * `  ✓ suite > nested > name  123ms` — also × for a failure and ↓ for a skip.
 *
 * **The reporter WRAPS long lines**, which was the third broken measurement this
 * script exists to replace: a test name long enough to hit the terminal width has
 * its duration pushed onto the *next* line. Reading line-by-line therefore loses
 * exactly the slow tests — the ones with the longest names.
 *
 * So the pattern is matched against the whole text, with the newline consumed as
 * part of the separator:
 *
 *     ✓ …completes the code exchange
 *     8129ms
 *
 * becomes one record. `[\s\S]+?` rather than `.+` for exactly that reason, and the
 * `m` flag because each match still starts at a line beginning.
 */
const TEST_LINE = /^\s*[✓×↓]\s+([\s\S]+?)\s+(\d+(?:\.\d+)?)ms\s*$/gm;

// **Both must be global.** `String.matchAll` throws on a non-global RegExp rather
// than returning one match — so a missing `g` here is a crash, not a silent miss.
const HOOK_FAIL = /Hook timed out in (\d+)ms/g;
const TEST_FAIL = /Test timed out in (\d+)ms/g;

const dir = mkdtempSync(join(tmpdir(), "slow-tests-"));
const outFile = join(dir, "vitest.txt");

const proc = spawnSync(
  "npx",
  ["vitest", "run", "--reporter=verbose", ...targets],
  {
    encoding: "utf8",
    shell: process.platform === "win32",
    // A file, not a pipe: the reporter interleaves stderr progress with stdout
    // results and colours every line, so a pipe is what made the earlier
    // measurements unreadable in the first place.
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// spawnSync gives us strings, not a file handle, so write them out ourselves and
// read back — which also means the parse never depends on the shell.
const raw = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outFile, raw);
} catch {
  // Reading from the string is equivalent; the file is for the error path below.
}

const text = readFileSync(outFile, "utf8").replace(ANSI, "");
rmSync(dir, { recursive: true, force: true });

const tests = [];
const files = new Set();

for (const m of text.matchAll(TEST_LINE)) {
  // The file name is inside the name string itself — vitest prints
  // `file > describe > it` — so take it from there rather than tracking a "current
  // file" across lines, which the wrapping defeats.
  const name = m[1].replace(/\s+/g, " ").trim();
  const fileMatch = name.match(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/);
  const file = fileMatch ? fileMatch[1] : "(unknown)";
  files.add(file);
  tests.push({ name, ms: Number(m[2]), file });
}

// --- The refusal, and why it is the important part -------------------------

if (tests.length === 0) {
  console.error(
    "No per-test durations were parsed.\n" +
      "This is a measurement failure, not a fast suite — refusing to report a\n" +
      'table it does not have, because an empty table reads as "nothing is slow".\n' +
      (raw.includes("timed out")
        ? "The run did time out; see the raw output below.\n"
        : ""),
  );
  console.error(raw.split(/\r?\n/).slice(-40).join("\n"));
  process.exit(1);
}

const slowest = [...tests].sort((a, b) => b.ms - a.ms);
const total = tests.reduce((sum, t) => sum + t.ms, 0);

console.log(`files: ${files.size}   tests timed: ${tests.length}`);
console.log(`summed test time: ${(total / 1000).toFixed(2)}s`);
console.log("");

// Hooks get their own section, because the OAuth flake lived there and no
// test-level timeout reaches a hook's budget.
const hookFail = [...text.matchAll(HOOK_FAIL)].map((m) => Number(m[1]));
const testFail = [...text.matchAll(TEST_FAIL)].map((m) => Number(m[1]));
if (hookFail.length > 0 || testFail.length > 0) {
  console.log("=== a timeout fired ===");
  if (hookFail.length > 0) {
    console.log(
      `  HOOK timed out at ${hookFail.join(", ")}ms. hookTimeout defaults to 10000ms,\n` +
        `  and the failing test is usually NOT the slow one — check the line vitest names.`,
    );
  }
  if (testFail.length > 0) {
    console.log(
      `  TEST timed out at ${testFail.join(", ")}ms. testTimeout defaults to 5000ms.`,
    );
  }
  console.log("");
}

console.log(
  `=== slowest ${Math.min(top, tests.length)} of ${tests.length} ===`,
);
for (const t of slowest.slice(0, top)) {
  const ms = String(t.ms).padStart(6);
  const name = t.name.length > 96 ? `${t.name.slice(0, 93)}...` : t.name;
  console.log(`  ${ms}ms  ${name}`);
}

// --- The budget ------------------------------------------------------------

let overBudget = 0;
if (budget !== null) {
  const over = slowest.filter((t) => t.ms > budget);
  overBudget = over.length;
  console.log("");
  if (over.length === 0) {
    console.log(`budget: no test exceeds ${budget}ms`);
  } else {
    console.log(`budget: ${over.length} test(s) exceed ${budget}ms`);
    for (const t of over.slice(0, top)) {
      console.log(`  ${String(t.ms).padStart(6)}ms  ${t.name}`);
    }
  }
}

/**
 * Exit code, in order of what a caller needs to know:
 *
 * 1. **A failing suite stays failing.** vitest's own status is the base, so this
 *    never hides a red run behind a green report.
 * 2. **A budget breach fails the command.** *Written after printing a perfectly
 *    clear "3 tests exceed 1000ms" and then exiting 0* — which is the exact
 *    failure this whole tool is about, committed by the tool itself. A report that
 *    cannot fail is a report, not a check.
 * 3. A failing suite wins over a budget breach, because a suite that did not
 *    finish has not measured anything meaningful.
 */
if ((proc.status ?? 0) !== 0) {
  process.exit(proc.status ?? 1);
}
if (overBudget > 0) {
  process.exit(1);
}
process.exit(0);
