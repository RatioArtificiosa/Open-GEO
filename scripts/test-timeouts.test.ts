/**
 * Every declared test timeout, in every shape vitest accepts.
 *
 * ## Why this is a gate rather than a script
 *
 * A scanner that reports a timeout as **absent** when one is declared is more dangerous than
 * no scanner, because the reader cannot tell *"looked and found nothing"* from *did not
 * look*. Three shapes in this repository defeat a naive pattern, and **each was found by
 * the scanner disagreeing with a file it was supposed to describe** — not by inspection:
 *
 * | shape | example | what a naive pattern sees |
 * |---|---|---|
 * | a named constant | `it("…", fn, IMPORT_UNDER_LOAD_MS)` | nothing |
 * | a hook's second argument | `beforeEach(fn, 30_000)` | nothing |
 * | **a trailing comma** | `it(\n "…",\n fn,\n CONST,\n)` | **nothing** |
 *
 * The third is the one worth a gate. Prettier reformats to that shape whenever a call has
 * a JSDoc block or a long body — **which is exactly when a timeout argument is present** —
 * so a pattern anchored at `$` fails on precisely the calls worth checking. Three attempts
 * were needed, and the answer was visible in a diagnostic two runs before it.
 *
 * ## A fourth and fifth shape, found the same way
 *
 * The machine-bounded budgets moved behind `SUBPROCESS_TEST_TIMEOUT_MS`
 * (`src/__tests__/test-budgets.ts`), and **the scanner immediately went blind on every
 * file that reads it** — which is the same discovery this gate exists to make, again:
 *
 * | shape | example | what a per-file pattern sees |
 * |---|---|---|
 * | an options object naming a constant | `spawnSync(…, { timeout: SUBPROCESS_TEST_TIMEOUT_MS })` | nothing |
 * | a constant **from another module** | `beforeAll(fn, SUBPROCESS_TEST_TIMEOUT_MS)` | nothing |
 * | a constant plus a margin | `it.each(…, SUBPROCESS_TEST_TIMEOUT_MS + 10_000)` | `10_000` — **wrong, and worse than nothing** |
 *
 * The last one deserves its sentence: the trailing digits match the literal branch, so the
 * scanner would have reported a 10-second budget on a 70-second test — a *false* reading
 * rather than an absent one. All three resolve here, with the shared module read once and
 * local declarations shadowing it, which is the precedence a reader expects.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * **Asserted:** that the scanner resolves the known slow files. Those are measured facts —
 * `scripts/slow-tests.mjs` puts `geo-module-reachability` first at 43s, and the OAuth tests
 * at 6.2s and 6.5s — so a scanner that cannot find their budgets is broken, and this says so.
 *
 * **Not asserted:** that every slow test *has* a timeout. A 3ms check needs no budget, and
 * inventing one would make this a gate that cries wolf.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { at } from "@/shared/index-reads";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `const NAME: Type = 30_000;` — the annotation may hold anything, including `=`. */
function constantsOf(src: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(
      /^\s*(?:export\s+)?(?:const|let)\s+([A-Z_][A-Z0-9_]*)\s*(?::[^=]*?)?=\s*([\d_]+)\s*[;,)]/,
    );
    if (m)
      map.set(
        at(m, 1, "the row under test (m)"),
        Number(at(m, 2, "the row under test (m)").replace(/_/g, "")),
      );
  }
  return map;
}

/**
 * The budgets declared in `src/__tests__/test-budgets.ts`, read once.
 *
 * A budget that exists precisely so a dozen files can read it is a budget no
 * per-file scan can resolve, and reporting those as absent is the failure this
 * gate is about. Local declarations shadow these, which is the precedence a
 * reader expects from "the file wins over the module it imports".
 */
const SHARED_BUDGETS_FILE = "src/__tests__/test-budgets.ts";
const SHARED_BUDGETS = constantsOf(
  stripComments(readFileSync(join(ROOT, SHARED_BUDGETS_FILE), "utf8")),
);

/**
 * Comments blanked to spaces, **string-aware**.
 *
 * ## Why a scanner needs this at all
 *
 * An apostrophe in a comment — `// the test's budget` — used to open a string
 * that swallowed the rest of the file, so a call containing any such comment
 * never balanced and its budget was reported as absent. The failure is silence,
 * which is the worst kind for a gate: nothing looked wrong, because "no budget
 * declared" is a normal answer for a fast test. The same trap catches the
 * `timeout:` pattern, where a comment *containing* the words `timeout: 60_000`
 * injects a budget no code declares.
 *
 * Strings are respected so a `//` inside a string literal is not a comment, and
 * the blanks keep every index stable, so an offset in a diagnostic still points
 * at the line it came from. `check-source-markers.mjs` strips comments the same
 * way for the same reason.
 */
function stripComments(src: string): string {
  let out = "";
  let inString: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 1;
      } else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "  ";
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The arguments of a call, **bracket-balanced from its opening paren**, with the
 * index just past its closing paren.
 *
 * The end index is what makes a chained call followable: `it.each(cases)(fn,
 * TIMEOUT)` keeps its budget on the **second** call, whose callee is a closing
 * paren — so a pattern that only matches `it(` reads the cases array, sees no
 * budget, and moves on. Every budget declared on a chained call was invisible
 * until this returned where the call ends.
 *
 * **Runs on comment-stripped source.** The caller strips once, because a
 * comment's apostrophe opens a string that never closes and the balance never
 * returns to zero.
 */
function argumentsAt(
  src: string,
  startIndex: number,
): { args: string; end: number } | null {
  const open = src.indexOf("(", startIndex);
  if (open === -1) return null;
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return { args: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * The final top-level argument of an already-trimmed argument list.
 *
 * **Isolated before it is classified.** Classifying the whole list was the bug
 * in the `CONST + 10_000` shape: the list `"title", fn, CONST + 10_000` does
 * not *start* with the constant, so a start-anchored match failed and the
 * trailing digits matched as a bare `10_000` instead — a false reading on a
 * real budget. Splitting at the last top-level comma also keeps a title that
 * *contains* a comma (`"handles [ Array(8) ]"`) from splitting the list.
 */
function finalArgument(args: string): string {
  let depth = 0;
  let inString: string | null = null;
  let cut = -1;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) cut = i;
  }
  return (cut === -1 ? args : args.slice(cut + 1)).trim();
}

/**
 * The last bare-token argument, **ignoring a trailing comma**.
 *
 * **This is the load-bearing line of the whole file.** Every other shape is obvious; this
 * one failed three attempts because prettier's multi-line call style ends the argument list
 * with `CONST,\n` and a pattern anchored at `$` sees a comma.
 */
function lastArgument(
  args: string,
):
  | { kind: "literal"; value: string }
  | { kind: "name"; value: string }
  | { kind: "sum"; name: string; literal: string }
  | null {
  const trimmed = args.replace(/\s*,\s*$/, "").trimEnd();
  // **`NAME + 10_000` first, and before the literal branch.** The trailing digits
  // would otherwise match as a plain `10_000`, reporting a ten-second budget on a
  // seventy-second test — a false reading, which is worse than an absent one
  // because a reader can act on it.
  const sum = finalArgument(trimmed).match(
    /^([A-Z_][A-Z0-9_]*)\s*\+\s*([\d_]+)$/,
  );
  if (sum)
    return {
      kind: "sum",
      name: at(sum, 1, "the row under test (sum)"),
      literal: at(sum, 2, "the row under test (sum)"),
    };
  const literal = finalArgument(trimmed).match(/^([\d_]+)$/);
  if (literal)
    return {
      kind: "literal",
      value: at(literal, 1, "the row under test (literal)"),
    };
  const name = finalArgument(trimmed).match(/^([A-Z_][A-Z0-9_]*)$/);
  if (name)
    return { kind: "name", value: at(name, 1, "the row under test (name)") };
  return null;
}

const CALLERS =
  /\b(it|test|describe|beforeAll|beforeEach|afterAll|afterEach)(?:\.(?:each|for|concurrent|skipIf|only|runIf|todo|skip|fails))*\s*\(/g;

/** A bare number, or a constant's name — whichever the token is. */
function budgetOf(
  token: string,
  constants: Map<string, number>,
): number | undefined {
  const literal = Number(token.replace(/_/g, ""));
  if (Number.isFinite(literal) && literal > 0) return literal;
  return constants.get(token);
}

function declaredTimeouts(raw: string): Array<{ ms: number; shape: string }> {
  // **Comments stripped once, here.** A comment's apostrophe opens a string
  // that never closes, and a comment's `timeout: 60_000` is a budget no code
  // declares — both are silent misreads, so they are removed before anything
  // looks at the source rather than worked around at each pattern.
  const src = stripComments(raw);
  // **Local wins, shared module second.** The merge order is the precedence.
  const constants = new Map([...SHARED_BUDGETS, ...constantsOf(src)]);
  const found: Array<{ ms: number; shape: string }> = [];

  // The options-object shape reads a **token**, not only digits: a spawn budget
  // lives in `{ timeout: … }` as happily as in a call's trailing argument, and
  // the named form was invisible until the budgets moved behind a constant.
  for (const m of src.matchAll(/timeout:\s*([A-Za-z_][A-Za-z0-9_]*|[\d_]+)/g)) {
    // The token is read once and used for both the budget and the shape label —
    // a second read of the match group would be a second place the group's
    // index is typed, and the shape is a fact about the same token.
    const token = at(m, 1, "the row under test (m)");
    const ms = budgetOf(token, constants);
    if (ms !== undefined)
      found.push({
        ms,
        shape: /^[\d_]+$/.test(token)
          ? "options object"
          : "options object (named)",
      });
  }

  for (const m of src.matchAll(CALLERS)) {
    const call = argumentsAt(src, m.index);
    if (call === null) continue;

    // **Every argument list on the chain.** `it.each(cases)` holds the cases;
    // the budget is on the call that follows it. The chain is followed only
    // when another call **immediately** follows the close paren — that is the
    // `it.each(…)(…)` shape and nothing else. Without the anchor, the next
    // statement's call (`expect(…)`, or the following `it(…)`) would be parsed
    // as a chained call and its last argument read as a budget twice over.
    const argumentLists = [call.args];
    if (/^\s*\(/.test(src.slice(call.end))) {
      const chained = argumentsAt(src, call.end);
      if (chained) argumentLists.push(chained.args);
    }

    for (const args of argumentLists) {
      const last = lastArgument(args);
      if (!last) continue;

      if (last.kind === "literal") {
        const ms = Number(last.value.replace(/_/g, ""));
        if (ms > 0) found.push({ ms, shape: `${m[1]} literal` });
        continue;
      }
      // A budget stated as the shared floor plus a margin. The margin must beat
      // the floor, or the test fails by its own timeout with the child's error
      // swallowed — the shape documented on `string-retention.test.ts` itself.
      if (last.kind === "sum") {
        const base = constants.get(last.name);
        if (base !== undefined)
          found.push({
            ms: base + Number(last.literal.replace(/_/g, "")),
            shape: `${m[1]} -> ${last.name} + ${last.literal}`,
          });
        continue;
      }
      const value = constants.get(last.value);
      if (value !== undefined) {
        found.push({ ms: value, shape: `${m[1]} -> ${last.value}` });
      }
    }
  }

  return found;
}

const ALL_FILES = [...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "src"))];

const BY_FILE = new Map(
  ALL_FILES.map((file) => {
    const found = declaredTimeouts(readFileSync(file, "utf8"));
    return [
      file.replace(/\\/g, "/").replace(`${ROOT.replace(/\\/g, "/")}/`, ""),
      found,
    ] as const;
  }),
);

function widestOf(rel: string): number {
  const found = BY_FILE.get(rel) ?? [];
  return found.length === 0 ? 0 : Math.max(...found.map((f) => f.ms));
}

describe("the timeout scanner reads every shape vitest accepts", () => {
  it("scans a real number of files, so this is not a gate about nothing", () => {
    expect(ALL_FILES.length).toBeGreaterThan(200);
  });

  /**
   * **The control on the control, and the reason this file exists.**
   *
   * Each case below is a *measured* slow test — `scripts/slow-tests.mjs` puts these at the
   * top of its table — and each declares its budget in a **different shape**. A scanner
   * that cannot find them is broken, and which shape failed is visible in the message.
   */
  it.each([
    {
      file: "src/server/mcp/oauth-provider.test.ts",
      ms: 30_000,
      why: "a named constant passed as an `it` argument, in prettier's multi-line form",
    },
    {
      file: "src/server/mcp/oauth-refresh.e2e.test.ts",
      ms: 30_000,
      why: "a hook's second argument — the ceiling that actually bites, per its own comment",
    },
    {
      file: "scripts/geo-module-reachability.test.ts",
      ms: 20_000,
      // **Measured, and the number moved because the work moved.** This gate took 21s
      // idle and 43s under load against a 60s budget — 72% consumed, which is not a
      // margin. The cost was `resolveLocal` re-resolving the import graph once per
      // declared writer: 126,085 filesystem probes for answers that cannot change during
      // the loop. Hoisted out, it takes 1.5s, so the budget followed it down.
      why: "an options object; measured, and lowered once the redundancy behind it was removed",
    },
    {
      file: "scripts/prepublish-audit.test.ts",
      ms: 60_000,
      // **This entry used to say 30_000, and that was the blind spot recorded as a
      // measurement.** The 60-second budget has been in the file since it was
      // widened to the outermost repository root, but the scanner could not
      // balance the call that declares it: the call's comments contain an
      // apostrophe and quotes, which opened strings that never closed, so the
      // walk ran to the end of the file and reported no budget. A test that
      // pins the scanner's *output* can only ever pin what the scanner sees —
      // which is why the strip above exists, and why this number moved without
      // anyone editing this file.
      why: "an options object on several `it`s, and a literal on a fifth — found only once the comments stopped breaking the balance",
    },
    {
      file: "src/server/lib/string-retention.test.ts",
      ms: 70_000,
      why: "the shared budget resolved across modules, then read as a floor plus a margin on the `it.each` — the child spawns with the floor alone",
    },
    {
      file: "src/lib/pr-preview-access.test.ts",
      ms: 60_000,
      why: "an options object naming the shared budget on the probe and on every case, so a loaded host cannot turn the suite into a green skip",
    },
    {
      file: "src/serverFunctions/geo.test.ts",
      ms: 60_000,
      why: "a hook reading the shared budget from another module — the shape that made the scanner blind until the merge above",
    },
  ])("finds the $ms budget in $file", ({ file, ms, why }) => {
    expect({ file, widest: widestOf(file), why }).toEqual({
      file,
      widest: ms,
      why,
    });
  });

  it("still reads a trailing comma, which is what defeated three attempts", () => {
    /**
     * The failure, reduced to a fixture. **A synthetic case rather than a real file**,
     * because the whole point is that the shape is easy to reintroduce: any new
     * `it(\n "…",\n fn,\n CONST,\n)` is the same problem again, and this is the line that
     * catches it.
     */
    const src = [
      "const SOME_BUDGET_MS = 7_000;",
      "",
      "it(",
      '  "a title long enough that prettier breaks the call across lines",',
      "  async () => {",
      "    await something();",
      "  },",
      "  SOME_BUDGET_MS,",
      ");",
    ].join("\n");

    expect(declaredTimeouts(src)).toEqual([
      { ms: 7000, shape: "it -> SOME_BUDGET_MS" },
    ]);
  });

  it("reads a budget named in an options object", () => {
    // `spawnSync(…, { timeout: SUBPROCESS_TEST_TIMEOUT_MS })` is where a child
    // process's budget lives, and the digit-only pattern saw nothing at all.
    const src = [
      'import { SUBPROCESS_TEST_TIMEOUT_MS } from "@/__tests__/test-budgets";',
      "spawnSync(cmd, args, { timeout: SUBPROCESS_TEST_TIMEOUT_MS });",
    ].join("\n");
    expect(declaredTimeouts(src)).toEqual([
      { ms: 60_000, shape: "options object (named)" },
    ]);
  });

  it("reads a budget stated as a floor plus a margin, and does not report the margin alone", () => {
    // **The false reading.** `CONST + 10_000` ends in digits, so the literal
    // branch alone would report 10_000 for a 70-second test — a number a reader
    // could act on, which is worse than an absent one. The margin must beat the
    // floor or the test fails by its own timeout, which is the documented reason
    // the shape exists.
    const src = [
      "it.each(cases)(",
      '  "releases the large source behind %s",',
      "  async () => {},",
      "  SUBPROCESS_TEST_TIMEOUT_MS + 10_000,",
      ");",
    ].join("\n");
    expect(declaredTimeouts(src)).toEqual([
      { ms: 70_000, shape: "it -> SUBPROCESS_TEST_TIMEOUT_MS + 10_000" },
    ]);
  });

  it("lets a local declaration shadow the shared budgets", () => {
    // The precedence a reader expects: the file wins over the module it reads.
    // A scanner that resolved shared names unconditionally would report the
    // shared floor on a file that deliberately narrowed it.
    const src = [
      "const SUBPROCESS_TEST_TIMEOUT_MS = 5_000;",
      "beforeAll(fn, SUBPROCESS_TEST_TIMEOUT_MS);",
    ].join("\n");
    expect(declaredTimeouts(src)).toEqual([
      { ms: 5_000, shape: "beforeAll -> SUBPROCESS_TEST_TIMEOUT_MS" },
    ]);
  });

  it("does not invent a budget for a fast test", () => {
    // **The other direction, and the one that stops this being a gate that cries wolf.**
    // A three-line test with no timeout must report nothing rather than a default.
    const src = ['it("fast", () => {', "  expect(1).toBe(1);", "});"].join(
      "\n",
    );
    expect(declaredTimeouts(src)).toEqual([]);
  });
});
