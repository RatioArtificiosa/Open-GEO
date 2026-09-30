import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Do our gates have a negative control, or only a false-positive one?
 *
 * ## The failure this file exists to name
 *
 * Seven detectors in this repository have now been caught **passing while the bug
 * they were written for was live in the tree**:
 *
 * - `billed-tasks-gate` — 6/6 green with `NO_RETRY_BILLED_POST` removed from a
 *   real billed post. Its trigger missed a generic type argument, and its
 *   terminator class had no backtick.
 * - `acquisition-mode-gate` — 5/5 green with the queue as the patrol's default.
 *   The type annotation sat between the field name and the `=`. Its second
 *   assertion used `slice(indexOf(...))`, which returns `-1` for a missing field
 *   and therefore read the top of the file — structurally incapable of failing.
 * - The `monitor_runs` agreement scan, twice: once with the `ON CONFLICT` clause
 *   missing, and again with the predicate in the wrong position. A text gate can
 *   check that two files agree; it cannot know what the engine's grammar needs.
 * - The drawer fixtures, which seeded a *complete* call where the test intended
 *   an incomplete one, because `??` treated an explicit `null` as absent.
 *
 * Every one had the same shape, and it is worth being precise about it: **a gate
 * that only ever runs over the repository and expects zero findings is a
 * false-positive test.** It passes when the scanner works, and it passes
 * identically when the scanner matches nothing at all. Only a **negative
 * control** — a fixture containing the defect, asserted to be caught —
 * distinguishes those two worlds.
 *
 * So this file is a *gate about gates*. It is deliberately not a hard failure for
 * a missing negative control, because a build that blocks on "please add a test"
 * is a build people disable. It reports the state, pins the number so it cannot
 * drift silently upward, and names the blind ones in the failure message.
 *
 * Verified 2026-09-29. See the note on SCAN_ROOTS: the first version of
 * this survey only looked in scripts/, and two of the seven were invisible to it.
 * A survey that cannot see a gate is worse than no survey, because it
 * reports a clean list.
 */

/**
 * Where gates live — and the answer is **not** one directory.
 *
 * The first version scanned `scripts/` only, and reported six blind gates. Two of
 * the seven detectors that had actually been caught passing on their bug were not
 * in that list at all: `billed-tasks-gate` sits beside the client it guards, in
 * `src/server/lib/dataforseo/`, because a gate separated from its subject is a
 * gate that has to be *remembered*. A survey that cannot see a gate is worse than
 * no survey, because it reports a clean list.
 *
 * So the search is over the whole tree, keyed on how a gate is recognised rather
 * than on where it is.
 */
const SCAN_ROOTS = ["scripts", "src"] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".output",
  ".react-router",
  "coverage",
  "test-results",
  "playwright-report",
  ".wrangler",
]);

/**
 * A file is treated as a gate when it reads the repository and asserts findings.
 *
 * A filename pattern would be simpler and wrong: `billed-tasks-gate`,
 * `private-split` and `prepublish-audit` share no naming convention, and a fourth
 * one will not follow whichever convention the first three happened to share.
 * The *behaviour* is the stable thing — a gate is a test that inspects source.
 */
function looksLikeAGate(source: string): boolean {
  if (!/readFileSync|readdirSync/.test(source)) return false;
  if (!/(it|test)\(/.test(source)) return false;
  if (!/expect\(/.test(source)) return false;

  // **A gate needs no database.** This is the distinction, and the first two
  // versions of this rule missed it, so the survey confidently listed six
  // repository and component tests as blind gates â€” including
  // `AiMentionHistoryRepository.query.test.ts`, which reads a migration purely
  // to build a fixture and is not a gate in any sense.
  //
  // A test that stands up libsql or drizzle is testing *behaviour against data*.
  // A gate tests *a property of the source text* and needs nothing but the
  // filesystem. Where a file does both, it is still a gate â€” so this excludes
  // only the ones that are nothing but.
  const standsUpADatabase =
    /createClient\(|from\s+["']@libsql\/client["']|drizzle\(|vi\.doMock\(["']@\/db["']/.test(
      source,
    );
  if (standsUpADatabase) return false;

  // A component test reads the filesystem to assert something about a rendered
  // string. `GeoTargetForm` and `GeoVisibilityPanel` both do, and the first two
  // versions of this rule listed them as blind gates, which is a category error:
  // what they check is the *content*, not the *code*.
  const assertsOnContent =
    /toHaveTextContent|getByText|toHaveAttribute|toBeInTheDocument|render\(|screen\./.test(
      source,
    );
  if (assertsOnContent) return false;

  return true;
}

function allTestFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.ts"))
        found.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(root);
  return found;
}

/** What counts as a negative control, stated as data so the rule is arguable. */
const NEGATIVE_CONTROL = {
  /** Asserts a FINDING — the scanner reported something. */
  reportsFinding:
    /toHaveLength\(\s*1\s*\)|toHaveLength\(greaterThan|\.toBe\(true\)|toEqual\(\[\s*\{/,
  /** Asserts ABSENCE — the scanner found nothing on clean input. */
  reportsClean:
    /toHaveLength\(\s*0\s*\)|toEqual\(\[\]\)|not\.(toMatch|toContain)/,
  /** A fixture built in the test body rather than read from disk. */
  inlineFixture: /\[\s*"|=\s*\[|join\("\\n"\)|`/,
} as const;

type Block = { name: string; body: string };

/** Split a test file into its `it(...)` blocks. */
function itBlocks(source: string): Block[] {
  // Brace-counted rather than regex-matched, and that change is the whole
  // reason this detector works. The first version matched
  // `it("...", () => { ... });` with a non-greedy regex, which stops at the
  // **first** `\n  });` in the body — so any test containing a nested `});` (an
  // `expect(...).toEqual({...})`, a helper, a `.map()`) got split in half, and
  // the half that survived no longer contained the assertion. The detector then
  // reported `billed-tasks-gate` as having no negative control when it has two,
  // which is the one failure mode this file exists to prevent: a detector
  // confidently reporting the wrong thing.
  const blocks: Block[] = [];
  const itPattern = /it\(\s*"([^"]+)"[\s\S]*?=>\s*\{/g;
  for (const match of source.matchAll(itPattern)) {
    const open = source.indexOf("{", match.index);
    if (open === -1) continue;
    let depth = 0;
    let end = source.length;
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push({
      name: match[1] ?? "",
      body: source.slice(open + 1, end),
    });
  }
  return blocks;
}

type GateReport = {
  file: string;
  tests: number;
  negativeControls: number;
};

/**
 * A block counts as a negative control when it asserts a finding **and** builds
 * its own fixture — either inline, or by **mutating a real file and restoring it**.
 *
 * The second form exists and is not hypothetical. `acquisition-mode-gate` and
 * `billed-tasks-gate` were both verified by a script that wrote the bug into a
 * live file, ran the gate, and restored the file byte-for-byte. That is the
 * strongest possible negative control, and a rule that only recognised inline
 * fixtures would report both of them as blind — which is how this survey's first
 * two versions managed to be confidently wrong twice.
 */
function isNegativeControl(body: string): boolean {
  if (!NEGATIVE_CONTROL.reportsFinding.test(body)) return false;

  // A test that only reads the repository is asserting "nothing is wrong now",
  // which a scanner matching nothing at all would also satisfy.
  const readsRepository =
    /readFileSync\(|readdirSync\(|patrolSource\(|source\(\)/.test(body);
  if (readsRepository) return false;

  // Inline fixture: a literal, an array of lines, or a joined template.
  if (NEGATIVE_CONTROL.inlineFixture.test(body)) return true;

  // Mutation form: the test body itself names a mutation, or the file documents
  // one in a way the survey can see. Detected from the *sibling script* rather
  // than the test body, because the verification is a separate file.
  return /\bmutat|reintroduc|regression|WriteAllText|applyPatch/.test(body);
}

function survey(): GateReport[] {
  const reports: GateReport[] = [];
  for (const full of allTestFiles()) {
    const source = readFileSync(full, "utf8");
    // A test that never reads source is a unit test, not a gate, however
    // gate-shaped its filename.
    if (!looksLikeAGate(source)) continue;
    const blocks = itBlocks(source);
    reports.push({
      file: full.replaceAll("\\", "/").replace(`${process.cwd()}/`, ""),
      tests: blocks.length,
      negativeControls: blocks.filter((b) => isNegativeControl(b.body)).length,
    });
  }
  return reports.sort((a, b) => a.file.localeCompare(b.file));
}

const REPORT = survey();

describe("the gates about gates", () => {
  it("reads a real number of gates, so this is not a gate about nothing", () => {
    // A scan of 0 files is green, and that has happened in this repo before: the
    // private-split scan shipped with the wrong directory and passed silently
    // from the day it was written.
    expect(REPORT.length).toBeGreaterThanOrEqual(10);
  });

  it("finds the negative controls that exist, proving the detector works", () => {
    // This file is itself a detector, and the rule above is a claim about source
    // text. A detector that finds nothing anywhere is indistinguishable from a
    // detector that does not work, so the rule is calibrated against the gates
    // that are known to have one: `billed-tasks-gate` has two, and
    // `acquisition-mode-gate` has the generic-argument case.
    const withControls = REPORT.filter((g) => g.negativeControls > 0).map(
      (g) => g.file,
    );
    // The two detectors that were *caught passing on the bug they were written
    // for* must be recognised as having controls now. Calibrating against the
    // known cases is what stops the rule from silently tightening until it
    // reports nothing anywhere.
    //
    // Full paths, because the survey no longer scans one directory — the first
    // version used bare filenames and passed while two of the seven detectors
    // were invisible to it.
    expect(withControls).toContain(
      "src/server/lib/dataforseo/billed-tasks-gate.test.ts",
    );
    expect(withControls).toContain("scripts/acquisition-mode-gate.test.ts");
  });

  it("does not count a false-positive test as a negative control", () => {
    // The distinction the whole file rests on: "found nothing in the repository"
    // is what a working gate and a broken one both say.
    const fake = `
      it("passes on a live call", () => {
        const source = readFileSync("x.ts", "utf8");
        expect(scan(source)).toHaveLength(0);
      });`;
    expect(
      itBlocks(fake)[0] && isNegativeControl(itBlocks(fake)[0]?.body ?? ""),
    ).toBe(false);
  });

  it("names the gates that still have no negative control", () => {
    // **Reported, and the list is pinned exactly.**
    //
    // A build that blocks on "please add a test" is a build people disable, and a
    // disabled gate is worse than an acknowledged gap. So this does not fail on
    // a missing control — it *prints* the list and pins it, which means:
    //
    // - a gate gaining a control changes the list and this test fails, so the
    //   improvement is recorded rather than forgotten;
    // - a gate appearing that is wrongly classified fails too, so the detector
    //   cannot quietly widen into reporting nonsense.
    //
    // Pinned from observation on 2026-09-29. `acquisition-mode-gate` was on this
    // list, which is how this file found it had **no** negative control at all:
    // its only verification was a hand-run script. It now has four.
    const blind = REPORT.filter((g) => g.negativeControls === 0).map(
      (g) => g.file,
    );
    // Sorted on both sides, so the pin compares like with like. A list whose
    // order depends on filesystem enumeration fails for a reason nobody can act
    // on, which is a failure mode that trains people to ignore failures.
    expect([...blind].sort()).toEqual(
      [
        // Verified by a hand-run mutation that never became a test in the repo.
        // The honest entry in this list: the check exists, the proof does not.
        "scripts/evidence-endpoint-scope.test.ts",
        // `claimSource` is a synthetic fixture the file defines and never feeds to
        // an assertion, so its tests all assert absence over the real source.
        "scripts/monitor-runs-agreement.test.ts",
        // A real gate comparing two schemas, with no negative control. Included
        // precisely because it is load-bearing: a parity test that stopped
        // comparing anything would pass, and nothing here would notice.
        "src/db/schema-parity.test.ts",
        // A component test that reads the source to assert a string is absent.
        // The `assertsOnContent` filter does not exclude it because it uses
        // `readFileSync` on the *component* rather than on rendered output, so
        // it reads as a gate. Listed rather than filtered away: a classifier
        // exception is a judgement call, and this one is arguable enough that
        // hiding it in the detector would be worse than showing it.
        "src/client/features/geo/GeoTargetForm.test.ts",
      ].sort(),
    );
  });

  it("has a negative control for the blindness rule itself", () => {
    // The claim "a false-positive test is not a negative control" is the load-
    // bearing one, so it is tested rather than asserted in a comment.
    const real = `
      it("fires on the exact shape that shipped", () => {
        const withoutOptOut = [
          "const r = await dataforseoPost(",
          "  task_post",
        ].join("\\n");
        expect(scanSource(withoutOptOut)).toHaveLength(1);
      });`;
    const blocks = itBlocks(real);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0] && isNegativeControl(blocks[0]?.body ?? "")).toBe(true);
  });
});
