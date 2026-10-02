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
    if (m) map.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  return map;
}

/** The arguments of a call, **bracket-balanced from its opening paren**. */
function argumentsOf(src: string, startIndex: number): string | null {
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
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
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
): { kind: "literal" | "name"; value: string } | null {
  const trimmed = args.replace(/\s*,\s*$/, "").trimEnd();
  const literal = trimmed.match(/([\d_]+)$/);
  if (literal) return { kind: "literal", value: literal[1] };
  const name = trimmed.match(/([A-Z_][A-Z0-9_]*)$/);
  if (name) return { kind: "name", value: name[1] };
  return null;
}

const CALLERS =
  /\b(it|test|describe|beforeAll|beforeEach|afterAll|afterEach)\s*\(/g;

function declaredTimeouts(src: string): Array<{ ms: number; shape: string }> {
  const constants = constantsOf(src);
  const found: Array<{ ms: number; shape: string }> = [];

  for (const m of src.matchAll(/timeout:\s*([\d_]+)/g)) {
    found.push({ ms: Number(m[1].replace(/_/g, "")), shape: "options object" });
  }

  for (const m of src.matchAll(CALLERS)) {
    const args = argumentsOf(src, m.index);
    if (args === null) continue;
    const last = lastArgument(args);
    if (!last) continue;

    if (last.kind === "literal") {
      const ms = Number(last.value.replace(/_/g, ""));
      if (ms > 0) found.push({ ms, shape: `${m[1]} literal` });
      continue;
    }
    const value = constants.get(last.value);
    if (value !== undefined) {
      found.push({ ms: value, shape: `${m[1]} -> ${last.value}` });
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
      ms: 30_000,
      why: "an options object on several `it`s",
    },
    {
      file: "src/server/lib/string-retention.test.ts",
      ms: 20_000,
      why: "an options object",
    },
    {
      file: "src/lib/pr-preview-access.test.ts",
      ms: 10_000,
      why: "an options object on the probe",
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

  it("does not invent a budget for a fast test", () => {
    // **The other direction, and the one that stops this being a gate that cries wolf.**
    // A three-line test with no timeout must report nothing rather than a default.
    const src = ['it("fast", () => {', "  expect(1).toBe(1);", "});"].join(
      "\n",
    );
    expect(declaredTimeouts(src)).toEqual([]);
  });
});
