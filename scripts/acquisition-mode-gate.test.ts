import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every `.ts` under `dir`, recursively. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

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

describe("the note for a platform nothing collects", () => {
  it("never claims a collector that does not run", () => {
    // **The sixth instance of this codebase's favourite bug**, and the one that
    // reached a customer-visible string.
    //
    // Both acquisition paths used to say that an uncollected platform *"is
    // collected by the AI Mode monitor"*. There is no such monitor: `planAiModeCaptures`
    // has tests and no caller, `fetchAiModeAnswer` is reached only through the SDK
    // meter's method reference, and `tryBeginRun` is used solely by the patrol for
    // `llm_mentions`. So the run log told a reader their gap was being handled.
    //
    // This asserts the *absence of the claim* rather than the presence of a
    // replacement, because the claim is the defect: any future note that invents a
    // collector fails here even if the sentence is beautifully worded.
    const source = patrolSource();
    expect(source).not.toMatch(/AI Mode monitor/i);
    expect(source).not.toMatch(/is collected by/i);
  });

  it("names no collector, and says the gap is real rather than a delay", () => {
    // The replacement has to carry information, not just avoid a lie. A reader
    // needs to know whether to wait — and the answer is always no.
    //
    // Read from the source rather than imported: this file is a pure source scan
    // by design, and importing `GeoPatrol` drags in `cloudflare:workers` through
    // the billing module, which no Node-side test can resolve. The first version
    // of this test tried it and failed with `Cannot find package
    // 'cloudflare:workers'` — a scan that has to boot the worker is no longer a
    // scan.
    const source = patrolSource();
    expect(source).toMatch(/is not collected/i);
    expect(source).toMatch(/real rather than a delay/i);
    // The platform name is interpolated, not hard-coded per platform — one
    // function, so `gemini` and `perplexity` get the same sentence.
    expect(source).toMatch(/\$\{platform\} is not collected/);
  });

  it("is one sentence for both paths, so they cannot drift apart", () => {
    // The two notes were separate strings and one of them was the false one. A
    // shared function makes a second copy a decision rather than an oversight.
    const source = patrolSource();
    // Declared once. Not exported: the gate reads the source, and an export with
    // no importer is what `knip` exists to refuse — the first version exported it
    // for this test's benefit and knip correctly rejected it.
    expect(
      source.match(/function uncollectedPlatformNote/g) ?? [],
    ).toHaveLength(1);
    // And called from both branches: the queued `llm_responses` loop and the Live
    // `llm_mentions` loop.
    expect(
      source.match(/notes\.push\(uncollectedPlatformNote\(/g) ?? [],
    ).toHaveLength(2);
  });
});

describe("MCP tool text names only tools that exist", () => {
  // **The defect this gate exists for lived in a tool's response text, not in
  // code.** `get_geo_citation_gap` told the caller to use the AI Mode query tool
  // to see what a platform *did* cite. There is no such tool, because the AI Mode
  // monitor has no runner — so an agent reading that sentence would call an
  // unregistered tool, get a protocol error, and report our own server as broken.
  //
  // The repair nearly repeated it: the first fix pointed at a different tool that
  // **also does not exist.** Replacing one invented name with another is the same
  // defect wearing a different word, and nothing caught it — no test read that
  // string, because the string was prose in a return value. This gate is what
  // catches it.
  //
  // Note what that first fix teaches, twice over. It was wrong, **and this file's
  // own comment naming the wrong tool is itself flagged by the rule below** — a
  // gate that scans sources cannot have its sources quote the thing they must not
  // contain. So neither this comment nor the tool's comment may spell the invented
  // name. Both describe it instead. That is the same constraint the encoding gate
  // imposes, and it is a property of source-scanning gates in general: **the rule
  // covers your prose as well as your code**, which is usually the right answer and
  // occasionally just inconvenient.
  //
  // Scoped to `get_geo*` on purpose. A general "every backticked identifier is a
  // real symbol" rule would flag every schema field, option name and file path in
  // the tool prose, and a gate that cries wolf is a gate that gets deleted.
  it("names no unregistered tool in the MCP sources", () => {
    const registered = new Set<string>();
    for (const file of listFiles("src/server/mcp")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/name:\s*"(get_geo[a-z_]*)"/g)) {
        registered.add(m[1]);
      }
    }
    // A control: the set is not empty, or every rule below is vacuous.
    expect(registered.size).toBeGreaterThan(0);

    const offenders: Array<{ file: string; name: string }> = [];
    for (const file of listFiles("src/server/mcp")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/`(get_geo[a-z_]*)`/g)) {
        if (!registered.has(m[1])) {
          offenders.push({ file, name: m[1] });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches an invented name, and does not flag a real one", () => {
    // **The negative control this rule needs**, and the reason the test above can
    // be trusted. A rule that returns nothing for a description naming a tool that
    // does not exist is a rule that returns nothing for every description.
    const registered = new Set(["get_geo_visibility"]);
    const unknownIn = (source: string) =>
      [...source.matchAll(/`(get_geo[a-z_]*)`/g)]
        .map((m) => m[1])
        .filter((n) => !registered.has(n));

    expect(
      unknownIn("Call `get_geo_ai_mode_query` to see what it cited."),
    ).toEqual(["get_geo_ai_mode_query"]);
    expect(unknownIn("See `get_geo_visibility` for the rate.")).toEqual([]);
  });
});
