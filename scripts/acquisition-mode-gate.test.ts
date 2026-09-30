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

describe("the patrol's acquisition mode", () => {
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
    const declared = source.match(/^\s*mode\??\s*:[^;\n]*/m);
    expect(
      declared,
      "PatrolInput no longer declares a `mode` field",
    ).not.toBeNull();
    const field = declared?.[0] ?? "";
    // Optional, so an absent mode falls through to the Live path...
    expect(field).toMatch(/\?/);
    // ...and carries no default, so nothing resolves it to a value here.
    expect(field).not.toContain("=");
    expect(field).not.toMatch(/["']queued["']/);
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
