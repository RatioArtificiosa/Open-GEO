#!/usr/bin/env node
/**
 * Per-test vendor spend: can this test spend the real money, or not?
 *
 * WHAT THIS MEASURES, AND WHY IT IS A GATE RATHER THAN A REPORT
 *
 * The live DataForSEO account holds $1.00. A test that reaches api.dataforseo.com spends
 * it, and a suite that spends on every run is a money leak nobody notices, because the
 * number is small and the failure is silent.
 *
 * scripts/slow-tests.mjs already measures per-test time. This measures per-test spend
 * exposure, which is a different axis with a different cost of being wrong: a slow test
 * is annoying, and a billable one drains an account that has almost nothing in it.
 *
 * Every test file is classified into three states, and CI fails on the third:
 *
 *   clean     no reachable path to the vendor host (stubbed, or types only)
 *   pinned    reaches the client, but pins a non-production host
 *   BILLABLE  reaches the client with nothing pinning the host, so it exits 1
 *
 * The billable ones are the point. A new test file that imports the real client and calls
 * a fetcher without pinning a host will, the first time DATAFORSEO_BASE_URL is unset in a
 * developer shell or a CI runner, send a real request and be charged for it. Nothing else
 * in the repository would notice: the request succeeds, the test passes, and the money is
 * gone.
 *
 * WHY STATIC ANALYSIS AND NOT AN INSTRUMENTED RUN
 *
 * A run can only observe the requests that run makes. This has to catch the file that
 * WOULD make one, including on a path the current fixtures never exercise, which is
 * exactly the case where the leak appears. Static analysis sees the capability;
 * instrumentation sees the luck.
 *
 * THE REFUSAL, WHICH IS THE IMPORTANT HALF
 *
 * A scan that matches nothing prints an empty list and exits 0, which is the same
 * false-negative shape scripts/slow-tests.mjs documents and gates-about-gates exists to
 * catch. So this asserts it found the test files it expects, and refuses to report a
 * profile it could not build.
 *
 * And like every other gate here it carries a NEGATIVE CONTROL: a fixture containing the
 * defect, asserted to be caught. Without it this is a false-positive test that passes
 * identically whether the detector works or matches nothing.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sort } from "remeda";

/**
 * The feature a test file belongs to.
 *
 * **At module scope, because it captures nothing from the caller.** It was declared
 * inside `main()` and the linter flagged it, which was right: a closure over
 * nothing is a function that reads as if it were local when it is pure, and a
 * hoisted one can be reasoned about on its own.
 *
 * The key has to be the **feature**, so a feature's server and client tests share
 * one row — grouping by directory instead put `src/client/features/geo` and
 * `src/server/features/geo/services` in different rows, which is a table that cannot
 * answer the question this is for, because the question is "which feature", not
 * "which layer of which feature".
 *
 * A file sitting directly inside `features/` is not a feature either: it returns the
 * parent, so a stray test file lands with its neighbours rather than becoming a
 * one-row "feature" of its own.
 */
function featureOf(file) {
  const parts = file.split("/");
  if (parts[0] === "scripts") return "scripts"; // the repo's own gates, as one family
  const features = parts.indexOf("features");
  if (features !== -1 && parts[features + 1]?.includes("/") === false) {
    const name = parts[features + 1];
    if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) return name;
    return parts.slice(0, features + 1).join("/");
  }
  if (file.startsWith("src/server/lib/dataforseo/")) {
    // **Named, not left as a path.** This is the one row in the table that carries
    // every spend capability the scan can find, so it is labelled as what it is
    // rather than as the directory it happens to live in.
    return "vendor client (src/server/lib/dataforseo)";
  }
  return parts.slice(0, parts.length - 1).join("/");
}

/**
 * The floor this scan refuses to report below.
 *
 * A number, not a tautology. A threshold of greater-than-zero would accept a glob that
 * matched one file, and a threshold equal to today's count would fail on the next
 * legitimate addition. So it is a round number below the current count with room to grow,
 * and a drop past it means the scan lost a whole directory, which is the failure the
 * refusal exists for.
 */
const MIN_TEST_FILES = 300;

/**
 * Every test file, tracked.
 *
 * Six globs, not two. src/doublestar/test.ts misses a test file sitting directly in src,
 * and scripts/doublestar/test.ts missed the top-level script gates, because a doublestar
 * requires at least one directory between the root and the pattern. The first version of
 * this scan proved that by finding 351 files and refusing, which is the behaviour the
 * refusal is for.
 *
 * execFileSync, not execSync. This shell expands the globs before git sees them, which
 * produced an empty file list on the sibling gate and made it pass with zero files
 * scanned, the exact silent pass this whole tool exists to prevent.
 *
 * Built by expansion rather than written out, because the literal patterns contain a
 * star-slash-star sequence that a comment scanner reads as a comment terminator.
 */
const STAR = String.fromCharCode(42);
function glob(dir, ext) {
  return `${dir}/${STAR}.${ext}`.replace(`${STAR}.`, `${STAR}.`);
}

const DIRS = ["src", "scripts"];
const EXTS = ["test.ts", "test.tsx"];
const GLOBS = [];
for (const dir of DIRS) {
  for (const ext of EXTS) {
    GLOBS.push(glob(dir, ext));
    GLOBS.push(`${dir}/${STAR}${STAR}/${STAR}.${ext}`);
  }
}

/**
 * Deduplicated, because `git ls-files` with several patterns returns a file once per
 * pattern it matched.
 *
 * **The first version did not do this**, and it also pushed two extra patterns ending in
 * `.ts` rather than `.test.ts`, so the scan covered 2,770 files - every source file in the
 * repository - and reported 28 production modules as BILLABLE. It did exit 1, which is
 * the gate working, but it was useless as a signal and would have been ignored.
 */
const tracked = [
  ...new Set(
    GLOBS.flatMap((pattern) =>
      execFileSync("git", ["ls-files", pattern], {
        cwd: process.cwd(),
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean),
    ),
  ),
];

/**
 * Imports that reach the vendor's client module.
 *
 * A type-only import is deliberately excluded: it cannot execute anything, and counting
 * it would report a file that only names a type as spend-capable.
 */
const IMPORT_RE =
  /import\s+(?!type\s)[^;]*from\s+["']@\/server\/lib\/dataforseo["']/;
const RELATIVE_IMPORT_RE = /import\s+(?!type\s)[^;]*from\s+["']\.\/core["']/;

/**
 * Stubs the whole client module, so nothing real is reachable.
 *
 * vi.mock on the client module replaces it in the module graph; a test that does this
 * cannot spend even if a fetcher is called, because the fetcher is the stub.
 */
const STUBS_CLIENT = /vi\.mock\(\s*["']@\/server\/lib\/dataforseo["']/;

/**
 * Pins the host to something that is not production.
 *
 * baseUrl is the precedence argument the transport itself documents, in DataforseoRequestOptions.
 * Mocking runtime-env neutralises the env-var branch, so an unset DATAFORSEO_BASE_URL
 * cannot silently resolve to api.dataforseo.com.
 */
const PINS_HOST = /baseUrl\s*:/;
const NEUTRALISES_ENV = /vi\.mock\(\s*["']@\/server\/lib\/runtime-env["']/;

/**
 * The classifier, as a function of a source string.
 *
 * A function over a string rather than an inline scan of the real tree. Run only against
 * the real files it can never fail; handed the defect it has to say BILLABLE, and that is
 * what makes the real assertion mean anything.
 */
export function classify(text) {
  if (!(IMPORT_RE.test(text) || RELATIVE_IMPORT_RE.test(text))) return "clean";
  if (STUBS_CLIENT.test(text)) return "clean";
  return PINS_HOST.test(text) || NEUTRALISES_ENV.test(text)
    ? "pinned"
    : "BILLABLE";
}

/** The defect, as a fixture: reaches the vendor with nothing pinned. */
const BILLABLE_FIXTURE = [
  'import { describe, expect, it } from "vitest";',
  'import { dataforseoPost } from "@/server/lib/dataforseo/core";',
  'import { fetchAnchors } from "@/server/lib/dataforseo";',
  "",
  'describe("a fixture that reaches the vendor with nothing pinned", () => {',
  '  it("would spend real money on every run", async () => {',
  '    await fetchAnchors("example.com");',
  '    await dataforseoPost("/v3/x/live", [{}]);',
  "    expect(true).toBe(true);",
  "  });",
  "});",
].join("\n");

/** The control's mirror: the same reach, with the host pinned. */
const PINNED_FIXTURE = [
  'import { describe, expect, it } from "vitest";',
  'import { fetchAnchors } from "@/server/lib/dataforseo";',
  "",
  'describe("a fixture that pins the host", () => {',
  '  it("cannot spend", async () => {',
  '    await fetchAnchors("example.com", { baseUrl: "http://127.0.0.1:1" });',
  "    expect(true).toBe(true);",
  "  });",
  "});",
].join("\n");

/** A file that only names a type, and must not be counted as spend-capable. */
const TYPE_ONLY_FIXTURE = [
  'import { describe, expect, it } from "vitest";',
  'import type { LmPlatform } from "@/server/lib/dataforseo";',
  'import { buildVisibilityCard } from "./visibilityCard";',
  "",
  'describe("a fixture that names a type", () => {',
  '  it("cannot spend", () => {',
  "    expect(buildVisibilityCard).toBeTruthy();",
  '    const p: LmPlatform = "chatgpt";',
  '    expect(p).toBe("chatgpt");',
  "  });",
  "});",
].join("\n");

/** A file that stubs the whole client, and must not be counted either. */
const STUBBED_FIXTURE = [
  'import { describe, expect, it, vi } from "vitest";',
  'import { fetchAnchors } from "@/server/lib/dataforseo";',
  "",
  'vi.mock("@/server/lib/dataforseo", () => ({ fetchAnchors: vi.fn() }));',
  "",
  'describe("a fixture that stubs the client", () => {',
  '  it("cannot spend", async () => {',
  '    await fetchAnchors("example.com");',
  "    expect(true).toBe(true);",
  "  });",
  "});",
].join("\n");

// --- The controls, and the refusal --------------------------------------------

const controls = {
  // Every fixture states the answer it is supposed to produce. A control that only
  // asserts the defect is caught cannot distinguish a detector that flags everything
  // from one that flags the right thing, which is why the clean shapes are here too.
  billableFixtureIsCaught: classify(BILLABLE_FIXTURE) === "BILLABLE",
  pinnedFixtureIsClean: classify(PINNED_FIXTURE) === "pinned",
  typeOnlyFixtureIsClean: classify(TYPE_ONLY_FIXTURE) === "clean",
  stubbedFixtureIsClean: classify(STUBBED_FIXTURE) === "clean",
  realTreeWasScanned: tracked.length >= MIN_TEST_FILES,
};

const failedControls = Object.entries(controls).filter(([, ok]) => !ok);

// **The empty-tree case is checked first, and reported as itself.**
//
// `realTreeWasScanned` is technically one of the controls, but the first version folded it
// into the control-failure message and printed "A negative control failed" for a scan that
// had simply found no files. The two need different fixes: a broken classifier is a bug in
// the tool, an empty tree is usually a shell expanding the glob or a wrong working
// directory, and telling the reader the wrong one sends them to the wrong place.
if (tracked.length < MIN_TEST_FILES) {
  console.error(
    `Only ${tracked.length} test files were found. A profile built on an empty tree\n` +
      "reads identically to one built on a full one, so this refuses to report.\n" +
      "If the glob genuinely matched nothing, a shell is expanding it.",
  );
  process.exit(1);
}

if (failedControls.length > 0) {
  console.error(
    "A negative control failed, so this profile is reporting nothing it can prove:\n" +
      JSON.stringify(controls, null, 2),
  );
  process.exit(1);
}

/**
 * True when this file is the process entry point.
 *
 * **Without this the classifier cannot be imported at all.** The test file imports
 * `classify` to assert on fixtures, and the first version ran the whole report on
 * import - including `process.exit(0)`, which terminated the vitest worker mid-test.
 * A module whose import kills its importer is a module nobody can test, which is how
 * the gate ended up with embedded fixtures but no external coverage.
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(import.meta.filename);
})();

async function main() {
  // --- The per-test spend ledger ------------------------------------------------

  const rows = [];
  for (const file of tracked) {
    // **A file in the index that is no longer on disk is skipped, not read.**
    //
    // `git ls-files` lists the *index*, not the working tree. Between "I moved this
    // file to the other repo" and "I committed that" the two disagree, and the first
    // version of this loop called `readFileSync` on every path the index returned —
    // which threw ENOENT on the moved file and crashed the gate with a stack trace
    // instead of a profile. That is the repo-split's own residue showing up in a
    // script that had nothing to do with it.
    //
    // The semantics are also simply right: a file that does not exist cannot spend.
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const state = classify(text);
    if (state === "clean") continue;
    rows.push({ file, state });
  }

  const billable = rows.filter((r) => r.state === "BILLABLE");
  const pinned = rows.filter((r) => r.state === "pinned");

  // --- Per-migration cost ------------------------------------------------------

  /**
   * The DDL class of one migration, and why it is the cost signal.
   *
   * Rows-affected cannot be measured statically, but WHAT A STATEMENT DOES TO A TABLE can,
   * and that is what decides whether a migration is cheap or expensive.
   *
   * The subtlety this classifier was wrong about first time round: drizzle's SQLite
   * generator emits a COLUMN CHANGE as a full rebuild - CREATE a new table, INSERT INTO
   * ... SELECT from the old one, DROP the old one, RENAME. A naive DROP detector reads that
   * as data loss. It is the opposite: it is the expensive-but-safe branch, and it is the
   * reason 17 of 63 migrations were reported "destructive" when only two are.
   *
   * So the two are separated by shape, not by keyword:
   *
   *   rebuild        CREATE TABLE + INSERT ... SELECT + DROP + RENAME in one file
   *                  sqlite COPIES the table; postgres rewrites under a lock
   *   destructive    a DROP with no rebuild following it - deliberate data removal
   *   index-only     CREATE INDEX, or DROP INDEX             cheap on both dialects
   *   table-change   volatile DEFAULT on ADD COLUMN, SET NOT NULL,
   *                  ALTER COLUMN ... TYPE               postgres full rewrite
   *
   * `drizzle/0020_drop_delegated_users.sql` and `0040_drop_reddit_attributions.sql` are the
   * real destructive ones, and the naming convention agrees with the DDL. That agreement is
   * the check: a classifier that called `0002_fair_toad_men.sql` destructive would be
   * reporting drizzle's codegen as a decision someone made.
   *
   * **`DROP INDEX` is deliberately NOT destructive.** Dropping an index costs nothing and is
   * undone by re-running its CREATE. Counting it as data loss reported 14 destructive
   * migrations when the true number is two, and a report that overstates by 7x is one
   * nobody reads - the same "useless signal" failure as the glob bug above.
   */
  const REBUILD =
    /CREATE\s+TABLE[\s\S]*INSERT\s+INTO[\s\S]*SELECT[\s\S]*DROP\s+TABLE[\s\S]*RENAME\s+TO/i;
  const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE)\b/i;
  const TABLE_CHANGE =
    /\b(SET\s+NOT\s+NULL|ALTER\s+COLUMN\s+[^)]+\s+TYPE|ADD\s+COLUMN[^)]*(CURRENT_TIMESTAMP|now\(\)|random\(\)))/i;
  const INDEX_ONLY = /\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX\b/i;

  const ddlFiles = execFileSync("git", ["ls-files", "drizzle/*.sql"], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  const migrations = [];
  for (const file of ddlFiles) {
    // Same index-vs-working-tree guard as the test ledger above: a migration that
    // has been removed but not yet committed must not crash the profile.
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let klass = "other";
    // **Order matters.** A rebuild contains DROP TABLE, so it has to be tested before the
    // destructive pattern or the check reports drizzle's codegen as a data decision.
    if (REBUILD.test(text)) klass = "rebuild";
    else if (DESTRUCTIVE.test(text)) klass = "destructive";
    else if (TABLE_CHANGE.test(text)) klass = "table-change";
    else if (INDEX_ONLY.test(text)) klass = "index-only";
    migrations.push({ file, klass });
  }

  const byClass = {};
  for (const m of migrations) byClass[m.klass] = (byClass[m.klass] ?? 0) + 1;

  // --- The report ---------------------------------------------------------------

  console.log(`test files scanned:      ${tracked.length}`);
  console.log(`reaching the vendor:      ${rows.length}`);
  console.log(`  pinned to a host:       ${pinned.length}`);
  console.log(`  BILLABLE (must be 0):   ${billable.length}`);
  for (const row of pinned) console.log(`    pinned    ${row.file}`);

  // --- Per-feature roll-up (CL-710) -------------------------------------------
  /**
   * **What this is the input to, and what it is not.**
   *
   * CL-710 asks for per-feature cost so a monthly margin review can ask "which
   * feature earns its vendor cost". The static measure available here is where the
   * *capability* to spend sits per feature, which is not the same number and should
   * not be read as one: a feature whose tests all pin a host costs nothing per run,
   * and the vendor bill for a feature is driven by how often its scheduled jobs run,
   * which is not in the test tree at all.
   *
   * So this is a coverage map rather than a forecast, and it says so in its heading.
   * What it answers is the question that precedes any forecast — where would a new
   * spending path have to live to be noticed.
   *
   * The grouping is the feature directory under `src/server/features/`, with
   * everything outside those directories collected under its own top-level path so
   * a new family of tests shows up as a row rather than being absorbed.
   */
  //
  // **A group has to contain more than one file to be a group.** The first version
  // returned `scripts/x.test.ts` for a script, which turned every gate into its own
  // feature row — 30 rows of one file each, and a table whose whole purpose is
  // comparison could not compare anything.
  //
  // **The key is the feature, so a feature's server and client tests share a row.**
  // Grouping by directory instead put `src/client/features/geo` and
  // `src/server/features/geo/services` in different rows, which is a table that
  // cannot answer the question CL-710 asks, because the question is "which feature",
  // not "which layer of which feature".
  //
  const byFeature = {};
  for (const file of tracked) {
    // Counted from the full scan rather than from `rows`, so the row's share is
    // meaningful. A feature with 40 tests and 1 reaching the vendor is a very
    // different place from one with 4 and 1, and both would look identical in a
    // list of the reaching ones.
    const feature = featureOf(file);
    byFeature[feature] ??= { files: 0, reaching: 0 };
    byFeature[feature].files += 1;
  }
  for (const row of rows) {
    const feature = featureOf(row.file);
    byFeature[feature] ??= { files: 0, reaching: 0 };
    byFeature[feature].reaching += 1;
  }

  /**
   * **A group of one file is not a group.** `src/server/auth` and
   * `src/server/auth/repositories` were separate rows holding one test each, which
   * is a table whose every cell is 1 and which answers nothing. A leaf directory
   * with a single file folds into its parent, so the rows are things a reader can
   * act on: a feature, or a subsystem with more than one test in it.
   */
  const folded = {};
  for (const [feature, counts] of Object.entries(byFeature)) {
    if (counts.files === 1 && feature.includes("/")) {
      const parent = feature.split("/").slice(0, -1).join("/");
      if (Object.keys(byFeature).includes(parent)) {
        folded[parent] ??= { files: 0, reaching: 0 };
        folded[parent].files += counts.files;
        folded[parent].reaching += counts.reaching;
        continue;
      }
    }
    folded[feature] ??= { files: 0, reaching: 0 };
    folded[feature].files += counts.files;
    folded[feature].reaching += counts.reaching;
  }

  // Remeda's `sort` returns a new array. `.sort()` here would mutate a fresh
  // `.map()` result and be harmless, but the repo's lint flags the shape and the
  // ES2022 floor means `toSorted` is not available — so the non-mutating form is
  // the one that compiles and the one that does not need justifying.
  const features = sort(
    Object.entries(folded).map(([feature, counts]) => ({ feature, ...counts })),
    (a, b) => b.reaching - a.reaching || a.feature.localeCompare(b.feature),
  );

  /**
   * **The roll-up has a vacuity guard of its own.** The same refusal shape as the
   * test-file scan, for the same reason: a grouping that matched nothing prints an
   * empty table and exits 0, and an empty per-feature table reads exactly like a
   * clean one. Forty is a floor below today's count with room to grow; falling
   * under it means the key function stopped matching, which is the failure that
   * arrives silently whenever the directory layout is reorganised.
   */
  if (features.length < 40) {
    console.error(
      `Only ${features.length} feature groups were formed. A per-feature roll-up` +
        " that has grouped almost nothing is indistinguishable from a clean one," +
        " so this refuses to report.",
    );
    process.exit(1);
  }

  console.log("");
  console.log(
    `=== per-feature spend capability (${features.length} features) ===`,
  );
  console.log("  files  reaching  feature");
  for (const f of features) {
    console.log(
      `  ${String(f.files).padStart(5)}  ${String(f.reaching).padStart(8)}  ${f.feature}`,
    );
  }

  console.log("");
  console.log(
    `=== per-migration cost class (${migrations.length} migrations) ===`,
  );
  for (const [k, v] of sort(Object.entries(byClass), ([a], [b]) =>
    String(a).localeCompare(String(b)),
  )) {
    console.log(`  ${k.padEnd(13)} ${v}`);
  }
  // The expensive and destructive ones are named, not just counted. "table-change: 3" is a
  // fact nobody acts on; the three file names are a review.
  for (const m of migrations) {
    if (m.klass === "table-change" || m.klass === "destructive") {
      console.log(`  ${m.klass.padEnd(13)} ${m.file}`);
    }
  }

  // --- The gate -----------------------------------------------------------------

  if (billable.length > 0) {
    console.error("");
    console.error(
      "Test files that reach the vendor client with nothing pinning the host:",
    );
    for (const row of billable) console.error(`  BILLABLE  ${row.file}`);
    console.error(
      "\nThese spend real money the first time DATAFORSEO_BASE_URL is unset. Pin the\n" +
        "host, or mock runtime-env so the env-var branch cannot resolve to\n" +
        "api.dataforseo.com.",
    );
    process.exit(1);
  }

  /**
   * Exit 0.
   *
   * Deliberately not a failure on the migration classes. A migration that rebuilds a table
   * is sometimes the right migration, and a gate that fails on it becomes a gate people
   * delete. What CI gets from that half is the COUNT, so a jump is visible in a PR diff
   * rather than discovered in production.
   *
   * The half that fails is the spend half, because that one has no legitimate zero.
   */
  process.exit(0);
}

if (isMain) await main();
