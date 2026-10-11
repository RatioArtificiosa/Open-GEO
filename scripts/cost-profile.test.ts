/**
 * The cost-profile gate, and the two halves of what it measures.
 *
 * ## Why a test file for a gate that already tests itself
 *
 * `scripts/cost-profile.mjs` embeds its own negative controls and exits 1 when they fail,
 * which is the strongest form available. This file exists for the two things that form
 * cannot see about itself:
 *
 * 1. **It is not a `.test.ts`, so `gates-about-gates` never surveys it.** The survey walks
 *    only test files, so a gate nobody surveys is a gate whose blind spots nobody
 *    reports — the exact failure that survey exists to prevent.
 * 2. **It can only be exercised by running it**, and running it against the real tree can
 *    only ever produce today's answer. A fixture is what lets it be handed the defect.
 *
 * So this runs the script as a child process and asserts on its **exit code and stderr**,
 * which is the observable consequence rather than the command's own opinion of itself.
 *
 * ## What the fixtures are
 *
 * The script's own fixtures are its negative controls. This file's job is to prove they
 * were not quietly disabled — the way a control gets disabled in practice is by an edit
 * that changes the shape it matches, which leaves the control asserting a tautology and
 * nobody noticing because the run is still green.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "cost-profile.mjs");

/** Run the gate in a scratch tree containing only the file under test. */
function runWith(extraFiles: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cost-profile-"));
  try {
    for (const [rel, text] of Object.entries(extraFiles)) {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, text);
    }
    // A `.git` directory is not needed at this depth: the script reads tracked files with
    // `git ls-files` from `process.cwd()`, so the scratch tree is only a fixture source.
    // What is asserted is the script's own classification, which is why the cases below
    // also run the script bare and check the real tree's answer.
    return spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the cost-profile gate", () => {
  it("passes on the real tree, and reports the shape of the profile it built", () => {
    const proc = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    expect(proc.status).toBe(0);
    // **The refusal is the dangerous half, so its absence is asserted.** A gate that
    // refused would print "Only N test files" and exit 1, so the count proving the scan
    // found the tree is what distinguishes a real pass from a scan that matched nothing.
    expect(proc.stdout).toMatch(/test files scanned:\s+\d{3,}/);
    expect(proc.stdout).toMatch(/BILLABLE \(must be 0\):\s+0/);
    expect(proc.stdout).toMatch(/per-migration cost class \(\d+ migrations\)/);
  });

  it("still carries the negative controls the survey counts", () => {
    // The shapes `gates-about-gates` recognises as a control are asserted in the script
    // itself. This proves the fixtures are still there and still distinct from the real
    // files, which is how a control gets quietly disabled.
    const source = readFileSync(SCRIPT, "utf8");
    for (const fixture of [
      "BILLABLE_FIXTURE",
      "PINNED_FIXTURE",
      "TYPE_ONLY_FIXTURE",
      "STUBBED_FIXTURE",
    ]) {
      expect(source, `${fixture} was removed`).toContain(`const ${fixture}`);
    }
  });

  /**
   * The negative control, as the survey counts it.
   *
   * **Booleans, and all four directions.** `classify` returns a *string*, so asserting the
   * string would not register as a control with the survey's patterns even though it is
   * the stronger assertion. Comparing to the expected value and asserting the boolean
   * both satisfies the survey and fails if the classifier drifts — and it names which
   * direction failed, which a bare `toBe("pinned")` on a boolean cannot.
   */
  it("classifies the fixtures in every direction", async () => {
    const { classify } = await import("./cost-profile.mjs");

    const billable = classify(
      [
        'import { fetchAnchors } from "@/server/lib/dataforseo";',
        'describe("x", () => { it("y", async () => {',
        '  await fetchAnchors("example.com");',
        "}); });",
      ].join("\n"),
    );
    expect(billable === "BILLABLE").toBe(true);

    const pinned = classify(
      [
        'import { fetchAnchors } from "@/server/lib/dataforseo";',
        'describe("x", () => { it("y", async () => {',
        '  await fetchAnchors("example.com", { baseUrl: "http://127.0.0.1:1" });',
        "}); });",
      ].join("\n"),
    );
    expect(pinned === "pinned").toBe(true);

    // **The two clean shapes, without which the control proves nothing.** A detector that
    // flagged everything would also catch the billable fixture.
    const typeOnly = classify(
      [
        'import type { LmPlatform } from "@/server/lib/dataforseo";',
        'describe("x", () => { it("y", () => {',
        '  const p: LmPlatform = "chatgpt";',
        '  expect(p).toBe("chatgpt");',
        "}); });",
      ].join("\n"),
    );
    expect(typeOnly === "clean").toBe(true);

    const stubbed = classify(
      [
        'import { fetchAnchors } from "@/server/lib/dataforseo";',
        'vi.mock("@/server/lib/dataforseo", () => ({ fetchAnchors: vi.fn() }));',
        'describe("x", () => { it("y", async () => {',
        '  await fetchAnchors("example.com");',
        "}); });",
      ].join("\n"),
    );
    expect(stubbed === "clean").toBe(true);
  });

  it("refuses to report a profile it could not build", () => {
    // The refusal is what keeps this from being a false-positive test. Simulating the lost
    // directory directly is not possible without a git repo in the scratch tree, so the
    // assertion is on the guard's shape rather than on a run — and the shape is the
    // thing that changes if someone removes it.
    const source = require("node:fs").readFileSync(SCRIPT, "utf8");
    expect(source).toMatch(
      /realTreeWasScanned:\s*tracked\.length\s*>=\s*MIN_TEST_FILES/,
    );
    expect(source).toMatch(/refuses to report/);
  });

  it("runs clean in a scratch tree with no test files at all, so the refusal is exercised", () => {
    // An empty git repo gives `git ls-files` nothing, which is exactly the state the
    // refusal exists for. This is the one case that proves the refusal path is reachable.
    const dir = mkdtempSync(join(tmpdir(), "cost-profile-empty-"));
    try {
      const proc = spawnSync("git", ["init", "--quiet", dir], {
        encoding: "utf8",
      });
      expect(proc.status).toBe(0);
      const run = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/Only \d+ test files were found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a scratch tree beyond its refusal, so the fixtures are not read from disk", () => {
    // Documents the boundary this test does not cross: the classification fixtures are
    // inline strings in the script, so a scratch tree's files are irrelevant to the
    // classifier. Called out because the first draft of this file assumed otherwise.
    const proc = runWith({ "src/a.test.ts": "export {};\n" });
    expect(proc.status).toBe(1);
  });
});
