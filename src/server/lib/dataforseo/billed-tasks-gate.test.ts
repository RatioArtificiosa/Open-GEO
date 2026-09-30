import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createsBilledTask } from "./billedTasks";

/**
 * No billed `task_post` may rely on the shared retry default.
 *
 * The `serp.ts` bug this file exists to prevent: a queued rank-check post is
 * billed when DataForSEO accepts it, so a 5xx on the way back does not prove the
 * charge was skipped. Replaying it creates a **second** batch of billed tasks and
 * the customer pays twice for work done once. It inherited the shared default of
 * two retries because nobody remembered the opt-out existed.
 *
 * So `NO_RETRY_BILLED_POST` is not a safety property, it is a convention, and a
 * convention one call site forgets is one doubled bill. This test makes forgetting
 * it a **failing build** instead.
 *
 * It is a source scan rather than a runtime test on purpose, for the same reason
 * the platform card rule is: the defect lives in the code that *reaches for* a
 * retry, not in any single input, so no runtime case can distinguish correct code
 * from a client that will double-charge.
 */

const CLIENTS_DIR = join(process.cwd(), "src/server/lib/dataforseo");

const clientFiles = readdirSync(CLIENTS_DIR).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

type Offender = { file: string; line: number; text: string };

/**
 * Every `dataforseoPost` call whose path is a billed `task_post` and which does
 * not pass a zero-retry option.
 *
 * The scan is deliberately about the *call*, not the file: one module can post
 * billed and unbilled tasks, and `business.ts` does exactly that. So the window
 * is per-call, from the `dataforseoPost(` opening to the closing of its argument
 * list, and the check is that a zero-retry option appears inside it.
 */
/**
 * The scan, as a pure function over source text.
 *
 * Split out from {@link findOffenders} so the detection can be exercised against
 * a *synthetic* call site without mutating a real file. The first version of this
 * self-test edited `serp.ts` on disk and restored it in a `finally`, which is a
 * gate that can leave the tree broken when it fails — worse than having no gate.
 * A pure predicate over a string has no such failure mode.
 */
export function scanSource(source: string): Offender[] {
  const offenders: Offender[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A call is `dataforseoPost(` possibly with a generic argument before the
    // paren: `dataforseoPost<T>(`. Prettier wraps that argument onto its own
    // lines, so `(` is usually **not** on the same line as the name — which is
    // why this cannot be a single-line regex. The lookahead below asks only
    // "is a call about to start here", and the existing depth-tracking window
    // then finds its arguments.
    //
    // The original pattern was `dataforseoPost(?:Response)?\s*[<(]`, which
    // matched neither the `<` nor a wrapped call. It therefore passed 6/6 on a
    // *real* billed post that had lost its `NO_RETRY_BILLED_POST` — the exact
    // CL-602b bug, undetected, in the one file written to detect it. Found by
    // mutating the live call, not by reading the pattern.
    if (!/dataforseoPost(?:Response)?\s*(?:<|[\s(])/.test(line)) continue;

    const window: string[] = [];
    let depth = 0;
    let opened = false;
    for (let j = i; j < Math.min(lines.length, i + 40); j++) {
      const candidate = lines[j] ?? "";
      window.push(candidate);
      for (const char of candidate) {
        if (char === "(") {
          depth += 1;
          opened = true;
        } else if (char === ")") {
          depth -= 1;
        }
      }
      if (opened && depth <= 0) break;
    }
    const text = window.join("\n");
    if (!createsBilledTask(text)) continue;
    if (/NO_RETRY_BILLED_POST|NO_RETRY|maxServerErrorRetries:\s*0/.test(text)) {
      continue;
    }
    offenders.push({ file: "<synthetic>", line: i + 1, text: line.trim() });
  }
  return offenders;
}

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const name of clientFiles) {
    const source = readFileSync(join(CLIENTS_DIR, name), "utf8");
    for (const found of scanSource(source)) {
      offenders.push({ ...found, file: name });
    }
  }
  return offenders;
}

const offenders = findOffenders();

describe("billed task posts", () => {
  it("scans a real number of client files, so the gate is not vacuous", () => {
    // A source scan with a wrong directory has been passing silently since the
    // day it was written, and a scan of 0 files is green.
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it("recognises the billed paths it is meant to catch", () => {
    // A detector that matches nothing is not a detector. Asserted against the
    // literal paths, including a `task_get` that must NOT match.
    expect(createsBilledTask('"/v3/serp/google/organic/task_post",')).toBe(
      true,
    );
    expect(
      createsBilledTask('"/v3/business_data/google/reviews/task_post"'),
    ).toBe(true);
    // A sub-path under task_post stays covered, so an endpoint gaining one later
    // is not silently excluded.
    expect(createsBilledTask("/v3/x/task_post/advanced")).toBe(true);
    // Every spelling a path can take in real source. The backtick was missing
    // for as long as the double quote was, and it is the one the LLM Responses
    // queue client actually uses — so the gate reported a clean build for a post
    // that had lost its zero-retry opt-out.
    expect(createsBilledTask("`${base(se)}/task_post`")).toBe(true);
    expect(createsBilledTask("'/v3/x/task_post'")).toBe(true);
    expect(createsBilledTask("/v3/x/task_post")).toBe(true);
    expect(createsBilledTask("/v3/x/task_post,")).toBe(true);
    // Collection is free and must never be treated as a billed post.
    expect(
      createsBilledTask("/v3/serp/google/organic/task_get/advanced/1"),
    ).toBe(false);
    expect(createsBilledTask("/v3/serp/google/organic/live/advanced")).toBe(
      false,
    );
  });

  it("fires on the exact shape that shipped", () => {
    // The gate must fail on the bug this was written for. Exercised against
    // synthetic source so nothing on disk is touched: a self-test that edits a
    // real file and restores it in a `finally` is a gate that can leave the tree
    // broken when it fails.
    const withoutOptOut = [
      "const r = await dataforseoPost(",
      '  "/v3/serp/google/organic/task_post",',
      "  tasks,",
      ");",
    ].join("\n");
    expect(scanSource(withoutOptOut)).toHaveLength(1);
  });

  it("passes the same call once the opt-out is present", () => {
    const withOptOut = [
      "const r = await dataforseoPost(",
      '  "/v3/serp/google/organic/task_post",',
      "  tasks,",
      "  NO_RETRY_BILLED_POST,",
      ");",
    ].join("\n");
    expect(scanSource(withOptOut)).toHaveLength(0);
  });

  it("fires on a post written with an explicit generic type argument", async () => {
    // The real defect this file had. A caller that parameterises the task type —
    // `dataforseoPost<DataforseoTaskLike & { id?: string }>(` — was invisible to
    // the scan, so dropping its `NO_RETRY_BILLED_POST` cost a doubled bill and
    // the gate stayed green. Found by mutating the live call and observing six
    // passing tests; a detector that has never been shown a positive is a
    // detector of unknown coverage.
    //
    // The shape below is the one Prettier actually produces for the live client.
    const withGeneric = [
      "const response = await dataforseoPost<",
      "  DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }",
      ">(`${base(se)}/task_post`, tasks.map(taskBody), NO_RETRY_BILLED_POST);",
    ]
      .join("\n")
      .replace("NO_RETRY_BILLED_POST", "/* no opt-out */");
    expect(scanSource(withGeneric)).toHaveLength(1);

    // And the same call is clean once the opt-out is there — so the widened
    // pattern did not simply start flagging every parameterised post.
    const withOptOut = [
      "const response = await dataforseoPost<",
      "  DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }",
      ">(`${base(se)}/task_post`, tasks.map(taskBody), NO_RETRY_BILLED_POST);",
    ].join("\n");
    expect(scanSource(withOptOut)).toHaveLength(0);
  });

  it("does not fire on a live call that is not billed on replay", () => {
    // A live endpoint is idempotent, so the shared retry default is correct there.
    // A gate that flagged it would train people to ignore it.
    const live = [
      "const r = await dataforseoPost(",
      '  "/v3/serp/google/organic/live/advanced",',
      "  [task],",
      ");",
    ].join("\n");
    expect(scanSource(live)).toHaveLength(0);
  });

  it("never lets a billed post rely on the shared retry default", () => {
    const report = offenders
      .map((o) => `  ${o.file}:${o.line} — ${o.text}`)
      .join("\n");
    expect(
      offenders.map((o) => `${o.file}:${o.line}`),
      `These calls create a billed task but do not disable the server-error ` +
        `retry, so a 5xx would post (and bill) a second batch:\n${report}`,
    ).toEqual([]);
  });
});
