import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The queue must not become the default by accident.
 *
 * ## What could go wrong, and why a unit test cannot see it
 *
 * The Standard queue is ~30% cheaper, so "switch the patrol to the queue" reads
 * as an obvious win. It is also up to **72 hours** slow. The shipped, tested
 * behaviour today is that a patrol archives answers within the run, and every
 * surface in the product renders from that archive.
 *
 * So the failure is not a crash. It is: cheaper, and every surface quietly
 * showing an empty archive for three days, with no error anywhere — which is the
 * exact class this codebase has now found four times (CL-150's inverted cron,
 * CL-205's inverted sort, CL-602b's blind gate, CL-208's silent truncation).
 *
 * No test of `GeoPatrol`'s behaviour catches it, because a run in queue mode
 * behaves perfectly; it just behaves *differently*. The property is therefore a
 * property of the **source**: the default must be Live, and the mode must be
 * something a caller passes deliberately.
 *
 * This is a source scan rather than a runtime test for the same reason
 * `billed-tasks-gate.test.ts` is: the defect lives in the code that *reaches for*
 * the alternative, not in any single input.
 */
const PATROL = "src/server/features/geo/services/GeoPatrol.ts";

function patrolSource(): string {
  return readFileSync(PATROL, "utf8");
}

/**
 * Does this source declare a `mode` that defaults to the queue?
 *
 * Hoisted out of the test so it can be fed a synthetic source. That is not
 * tidiness: while the rule was inline it *could not* have a negative control,
 * because a closure over `readFileSync` has no second input. A detector that
 * cannot be shown a failing case is a detector of unknown coverage ”” which is
 * exactly what this gate turned out to be, having passed with the queue as the
 * default until it was caught by hand.
 */
export function declaresQueuedDefault(source: string): boolean {
  const declared = source.match(/^\s*mode\??\s*:[^;\n]*/m);
  // A missing field is **not** a pass. The first version did
  // `slice(indexOf("mode?:"), ”¦)`, and `indexOf` returns -1 for a missing field,
  // so the slice read from the top of the file and the assertion succeeded for a
  // reason that had nothing to do with the field. Treating absence as a failure
  // is the only reading that cannot be satisfied by a rename.
  if (declared === null) return true;
  const field = declared[0];
  return field.includes("=") || /["']queued["']/.test(field);
}

describe("the patrol's acquisition mode", () => {
  it("catches a queued default in a synthetic source", () => {
    // **The negative control this gate did not have.**
    //
    // Its first version passed 5/5 with the queue as the default, and the bug
    // was only ever caught by hand — a scratchpad script that mutated the file,
    // ran the test and restored it. A verification nobody can run is a comment
    // about a verification. This test is that check, in the repository, on a
    // source that was never on disk.
    //
    // The shape is the exact one that shipped, type annotation and all, because
    // the annotation between the name and the `=` is precisely what the
    // original pattern missed.
    const mutated = [
      "type PatrolInput = {",
      "  projectId: string;",
      '  mode: AcquisitionMode = "queued";',
      "};",
    ].join("\n");
    expect(declaresQueuedDefault(mutated)).toBe(true);
  });

  it("catches a default written with no type annotation", () => {
    // The shape the original pattern *would* have caught, kept so a future
    // rewrite cannot drop the easy case while keeping the hard one.
    expect(declaresQueuedDefault('type T = { mode = "queued" };')).toBe(true);
  });

  it("accepts an optional mode with no default", () => {
    // The shape that must pass, and the reason a test that asserts `true` on
    // everything would be worthless: this is the file as it should be.
    const good = [
      "type PatrolInput = {",
      "  projectId: string;",
      "  mode?: AcquisitionMode;",
      "};",
    ].join("\n");
    expect(declaresQueuedDefault(good)).toBe(false);
  });

  it("treats a missing field as a failure, not as a pass", () => {
    // The `-1` trap. `indexOf` on a field that is not there returns -1, and
    // `slice(-1, n)` silently reads from the end of the file — so a rename used
    // to make this gate pass for a reason that had nothing to do with the mode.
    // A detector that cannot fail on absence is not a detector.
    expect(
      declaresQueuedDefault("type PatrolInput = { projectId: string };"),
    ).toBe(true);
  });

  it("defaults to live, and never to the queue", () => {
    // The single most important line in this file. If a later change makes the
    // queue the default, this fails and the change has to argue for itself.
    const source = patrolSource();

    // ## Why this scans the declaration rather than matching a pattern
    //
    // The obvious version — `expect(source).not.toMatch(/mode\s*=\s*["']queued["']/)`
    // — **passed with the queue as the default**, because the field is declared
    // `mode: AcquisitionMode = "queued"`: the type annotation sits between the
    // name and the `=`, so the pattern never matched. A detector that has only
    // seen the one shape it was written against is a detector of that shape.
    //
    // The `-1` check below matters just as much: with the field renamed, a
    // missing match made `slice(-1, 199)` read from the top of the file, so the
    // assertion passed for a reason that had nothing to do with the field.
    expect(declaresQueuedDefault(source)).toBe(false);
  });

  it("has an explicit mode on the patrol input, so the choice is visible", () => {
    // A mode that does not appear in the input type cannot be set per run, and
    // a per-run decision cannot be reviewed or reverted without a deploy.
    expect(patrolSource()).toMatch(
      /mode\??:\s*AcquisitionMode|mode\??:\s*"live"/,
    );
  });

  it("imports the mode type rather than re-declaring the strings", () => {
    // Two spellings of "queued" in two files is two answers to "is this the
    // queue", and they will eventually disagree.
    const source = patrolSource();
    expect(source).toMatch(/from\s+["'].*queuePlanner["']/);
  });

  it("still runs the Live path, and does not branch away from it", () => {
    // The queue is an *option*, not a replacement. A patrol that can no longer
    // archive within the run has lost the product's shipped behaviour even if
    // every queue test passes.
    const source = patrolSource();
    // The Live mentions endpoint is still called.
    expect(source).toContain("/live");
    // And a snapshot is still written on the Live path.
    expect(source).toMatch(/snapshot/i);
  });

  it("says in the run log when a run only posted", () => {
    // A run that posts and returns must not read as a completed run. The note
    // is the only place a reader learns the archive will be empty for now.
    const source = patrolSource();
    expect(source).toMatch(/queueNote|not now|stays empty/i);
  });
});
