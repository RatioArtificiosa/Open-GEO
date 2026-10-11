/**
 * Find exports whose only references are their own file and its test.
 *
 * ## Why this gate exists
 *
 * Three times in the Phase 5 security sweep, a module was exported, given passing
 * tests, and **reached from nothing**:
 *
 *   • `assertCrawlableTarget` / `resetCrawlDnsBudget` — an SSRF guard that left the
 *     vulnerability wide open while its own test file was entirely green.
 *   • `seriesSpansCutover` — the boundary predicate for the 2026-11-01 ETV switch,
 *     four passing cases and no consumer, so the trend it guarded was computed anyway.
 *   • `REFERENCE_CACHE_ROOT_PREFIX` — a constant that only its own test referenced,
 *     now asserted on the production sweep path.
 *
 * **A test file beside a module is not evidence the module is used.** `knip` cannot see
 * this: by default it counts a test file as a consumer, so an export reached only from a
 * test is "used". That is a defensible default for ordinary code and the wrong default
 * for a security or correctness invariant, where the module's entire value is the
 * production path it guards.
 *
 * ## What it reports
 *
 * An export that (a) sits in one of the {@link INVARIANT_MODULES} with a same-named test
 * file, (b) is referenced by that test, and (c) is referenced by no production code —
 * **its own module included, declarations excluded**. Condition (c) is why
 * {@link ownWithoutDeclarations} exists: without it, the export line itself satisfies
 * "production mentions it", and a symbol declared and never called runs green. That is
 * precisely how the first version of this gate passed against a deliberately dead
 * predicate.
 *
 * ## Why whole-text rather than parsed imports
 *
 * The first version built an import-symbol map and reported 250 exports, nearly all
 * wired through a shape it could not see — a barrel re-export, `import * as ns`, a
 * dynamic `await import(...)`. Among them was `analyzeHtml`, which `crawlPage` reaches
 * by dynamic import *specifically* to keep the HTML parser out of the worker's startup
 * module graph.
 *
 * So this searches whole file texts and errs toward "wired": a comment that merely
 * mentions the symbol counts as a use. The bias is deliberate — a false "wired" leaves
 * one export unchecked, while a false "unwired" is a build failure on every unrelated
 * refactor.
 *
 * ## The exit code is the gate
 *
 * Printing the list would be a document. This exits non-zero, which is what turns the
 * next unwired guard into a build failure rather than a finding in a file somebody reads
 * later.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

// **`execFileSync`, not `execSync`.** `execSync` goes through a shell, which expands the
// globs before git sees them: on this machine that produced an *empty* file list, so the
// gate ran green with zero files scanned — the exact silent pass it was written to
// prevent. `execFileSync` passes the patterns through as arguments and git expands them.
//
// **`.tsx` in the corpus, not just `.ts`.** The first version globbed only `.ts`, so every
// client-side export reached from a component looked unwired — 180 findings, most false,
// which is the same failure as a gate that never fires: one ignored in practice catches
// nothing.
const tracked = execFileSync(
  "git",
  ["ls-files", "src/*.ts", "src/**/*.ts", "src/*.tsx", "src/**/*.tsx"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const production = tracked.filter(
  (file) => !file.endsWith(".test.ts") && !file.endsWith(".d.ts"),
);

const corpus = production.map((file) => ({
  file,
  text: readFileSync(resolve(root, file), "utf8"),
}));

/**
 * The modules that hold an invariant, and must not be allowed to rot.
 *
 * ## Why a list rather than the whole tree
 *
 * Run against every file with a test, this gate found **~100 dead exports** — real dead
 * code, not false positives, all of it referenced only by its own file and its test. That
 * is a genuine finding and it is *not this gate's job*: a check that fires a hundred
 * times is a check everybody learns to skip, and it would have buried the finding that
 * mattered.
 *
 * So this list is the contract: **a module goes on it because losing its only caller is
 * silent and dangerous.** Every entry is a guard — something that refuses, stamps,
 * bounds or labels. A dead `formatVolume` costs a screen; a dead SSRF resolver leaves a
 * hole in the edge. Those are different problems, and only the second belongs in CI.
 *
 * Adding a new guard means adding a line here, and that is the maintenance cost of a
 * check that stays useful.
 */
const INVARIANT_MODULES = [
  // Refuses a fetch target, resolving the hostname immediately before the request.
  "src/server/lib/audit/url-policy.ts",
  // Labels the 2026-11-01 ETV boundary, so a formula change is never read as traffic.
  "src/shared/etv-versioning.ts",
  // The GDPR sweep: what a deletion request is allowed to reach.
  "src/server/gdpr/storage-erasure.ts",
  // Tenant-scoped R2 writes — the stamp an erasure matches on.
  "src/server/lib/r2-cache.ts",
  // Billing gates and the circuit breaker, where a dead guard is metered spend.
  "src/server/lib/dataforseo/gates.ts",
];

/**
 * Test-only hooks, exempted with the reason.
 *
 * ## These are not false positives and they are not production APIs
 *
 * A `__reset…` hook exists precisely because a module keeps process state a test must be
 * able to clear — the pattern is deliberate and its only consumer *is* the test.
 * `gatePressure` is the introspection read that hook's test uses to observe the gate.
 *
 * **Exempted by name rather than by pattern**, because a pattern like "anything starting
 * with `__`" would exempt the next real finding that happened to be named that way, and
 * because each exemption is then a visible line somebody has to keep authorising.
 */
const TEST_HOOKS = new Map([
  [
    "__resetGatesForTests",
    "clears the semaphore and rate-gate maps a test must reset between cases",
  ],
  [
    "gatePressure",
    "the introspection read the gate's own test uses to observe queued/free state",
  ],
]);

const invariantFiles = INVARIANT_MODULES.filter((file) =>
  tracked.includes(file),
);

/** A whole-word reference test, so `forceLayout` does not match `forceLayoutRule`. */
function references(text, symbol) {
  return new RegExp(`\\b${symbol}\\b`).test(text);
}

const exportPattern =
  /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gm;

/**
 * The same test **without** the `g` flag.
 *
 * ## Why two patterns for one rule
 *
 * `exportPattern` is global because `matchAll` requires it. `test` on a global regex is
 * stateful — `lastIndex` persists across calls — so calling it in a `.filter()` over a
 * file's lines matches every *other* line. That made the blanking below erratic: whether
 * a declaration line was removed depended on its position in the file, and the gate ran
 * green against a deliberately dead predicate.
 *
 * **A global regex is for iterating a whole string; a non-global one is for asking a
 * question about one.** Mixing the two is one of the small mistakes that turns a
 * correctness check into a coin toss, and it is invisible in a test that only ever
 * checks the first line.
 */
const isExportLine =
  /^export\s+(?:async\s+)?(?:function|const|class)\s+[A-Za-z0-9_]+/;

const unwired = [];
for (const entry of corpus.filter((entry) =>
  invariantFiles.includes(entry.file),
)) {
  const testFile = `${entry.file.slice(0, -3)}.test.ts`;
  if (!tracked.includes(testFile)) continue;

  // **The module's own text with its export declarations blanked out.**
  //
  // Without this the export line itself satisfies "production mentions it": a symbol
  // declared and never called would still match its own `export function foo(`. That is
  // exactly how the first version of this gate ran green against a deliberately dead
  // predicate — the defect it was built to catch.
  //
  // Blanking only the *declaration line* keeps every other reference in the file, so a
  // helper used inside its own module still counts as reached.
  const ownWithoutDeclarations = entry.text
    .split("\n")
    .filter((line) => !isExportLine.test(line))
    .join("\n");

  for (const match of entry.text.matchAll(exportPattern)) {
    const symbol = match[1];

    // **Two separate questions, and conflating them is what made the first version
    // pass.** "Does this module use it internally?" is answered by the blanked text.
    // "Does any other production file use it?" must exclude *this* file — otherwise the
    // export declaration itself answers yes, and a symbol nothing calls looks wired.
    const usedHere = references(ownWithoutDeclarations, symbol);
    const usedElsewhere = corpus.some(
      (other) => other.file !== entry.file && references(other.text, symbol),
    );
    if (usedHere || usedElsewhere) continue;

    // Its own test mentions it, so it is not merely dead code — that would be `knip`'s
    // report, and a dead export is a different finding from an unwired one.
    const tested = references(
      readFileSync(resolve(root, testFile), "utf8"),
      symbol,
    );
    if (!tested) continue;
    if (TEST_HOOKS.has(symbol)) continue;

    unwired.push({ symbol, file: entry.file });
  }
}

if (unwired.length > 0) {
  console.error(
    "Exports whose only references are their own file and its test.\n" +
      "A test file beside a module is not evidence the module is used —\n" +
      "knip counts a test as a consumer, so it cannot see this.\n" +
      "Wire the caller, or delete the export:\n",
  );
  for (const { symbol, file } of unwired) {
    console.error(`  ${symbol}  —  ${file}`);
  }
  process.exit(1);
}
