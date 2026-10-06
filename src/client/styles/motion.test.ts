import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CL-313 — DESIGN.md §7, the motion rules, enforced where a source scan can hold
 * them.
 *
 * **What the audit found, and it is an accessibility defect rather than a taste
 * one:** the app animates through Tailwind's `transition-*`, `animate-spin` and
 * `animate-pulse`, and **not one of them consulted `prefers-reduced-motion`** —
 * no such media query existed anywhere under `src/client`, while the marketing
 * site (which animates three classes) had one. §7 requires it and §10 lists it in
 * the definition of done, so the fix is a global rule in `app.css` and this gate
 * keeps it there.
 *
 * Four rules, and the shape of each is a defect that shipped somewhere in this
 * family:
 *  1. The reduced-motion rule exists, and zeroes **both** durations **and** the
 *     iteration count — a 0.01ms loop still repaints forever.
 *  2. No attention-loop utilities: `animate-bounce` (removed once already by
 *     CL-803) and `animate-ping`.
 *  3. No motion library and no spring/stagger vocabulary — §7 bans all three by
 *     name, and `stagger` is called out as "the single most reliable AI-slop
 *     tell".
 *  4. Not vacuous: it read the stylesheet and a real number of source files.
 *
 * **`animate-spin` and `animate-pulse` are deliberately allowed.** A spinner and
 * a skeleton are affordances, not decoration, and rule 1 is what makes them
 * respect the reader's setting. Banning them would be the noisy-gate failure
 * this repo has already paid for twice — a gate that cries wolf gets disabled,
 * and then it catches nothing.
 */

const STYLES = fileURLToPath(new URL(".", import.meta.url));
const SRC_CLIENT = fileURLToPath(new URL("..", import.meta.url));
const APP_CSS = join(STYLES, "app.css");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts"))
      out.push(path);
  }
  return out;
}

const FILES = walk(SRC_CLIENT);
const APP_CSS_SOURCE = readFileSync(APP_CSS, "utf8");

/** The body of the reduced-motion media query, or null when there is none. */
function reducedMotionBlock(css: string): string | null {
  const match = css.match(
    /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/,
  );
  return match?.[1] ?? null;
}

/**
 * Remove comments, keeping every line's number intact.
 *
 * **Comments cannot animate anything, so the vocabulary rules read code only.**
 * This is the trap this repo has paid for more than twice: a gate that spells a
 * forbidden word fails on its own explanation. Here the prose is a component
 * comment recording that §7 bans stagger — a true sentence, and not a stagger.
 * The on-disk *fix* is also a comment more often than not ("was animate-bounce,
 * now a 1.5s pulse"), so scanning prose would forbid documenting the repair.
 *
 * Block comments are blanked character-for-character rather than deleted, so a
 * reported line number still points at the line it names — a gate that reports
 * the wrong line is a gate whose output cannot be acted on.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

describe("DESIGN.md §7 — motion respects the reader's setting", () => {
  it("zeroes animation and transition when the reader has asked it to", () => {
    const block = reducedMotionBlock(APP_CSS_SOURCE);
    expect(
      block,
      "app.css carries a `prefers-reduced-motion: reduce` rule",
    ).not.toBeNull();
    expect(block).toMatch(/animation-duration\s*:\s*0(\.01)?ms/);
    expect(block).toMatch(/transition-duration\s*:\s*0(\.01)?ms/);
    // A 0.01ms animation that repeats forever still repaints forever.
    expect(block).toMatch(/animation-iteration-count\s*:\s*1/);
  });

  it("does not use an attention-loop animation utility", () => {
    const violations: string[] = [];
    for (const path of FILES) {
      const id = relative(SRC_CLIENT, path).split(sep).join("/");
      stripComments(readFileSync(path, "utf8"))
        .split("\n")
        .forEach((line, index) => {
          if (/\banimate-(bounce|ping)\b/.test(line)) {
            violations.push(`${id}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      violations,
      `§7 bans bounce; a spinner or a skeleton is an affordance:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("carries no motion library, spring or stagger", () => {
    const violations: string[] = [];
    for (const path of FILES) {
      const id = relative(SRC_CLIENT, path).split(sep).join("/");
      stripComments(readFileSync(path, "utf8"))
        .split("\n")
        .forEach((line, index) => {
          if (
            /from\s+["'](framer-motion|motion)["']/.test(line) ||
            /\bstaggerChildren\b|\bstagger\b|type:\s*["']spring["']/.test(line)
          ) {
            violations.push(`${id}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      violations,
      `§7: "No spring physics. No bounce. No stagger."\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("read a real stylesheet and a real tree, so it is not vacuous", () => {
    expect(APP_CSS_SOURCE.length).toBeGreaterThan(1000);
    expect(FILES.length).toBeGreaterThan(200);
  });

  it("animates a chart only through the reduced-motion hook", () => {
    // Recharts animates in JS, so the stylesheet rule cannot reach it: a chart
    // that animates by default is one a reduced-motion reader cannot turn off.
    // Either choice is compliant — the hook's props, spread as `{...chartMotion}`
    // (animate, unless the reader objects) or an explicit
    // `isAnimationActive={false}` (never animate) — and what this catches is the
    // third case, which is silence. The spread name is the convention because
    // hook-presence alone would pass on a file that imported it and never used it.
    const violations: string[] = [];
    const charts = FILES.filter((path) =>
      /from "recharts"/.test(readFileSync(path, "utf8")),
    );
    for (const path of charts) {
      const id = relative(SRC_CLIENT, path).split(sep).join("/");
      const source = readFileSync(path, "utf8");
      const compliant =
        source.includes("useChartMotion") && /\.\.\.chartMotion/.test(source);
      if (
        !compliant &&
        !/isAnimationActive\s*=\s*\{\s*false\s*\}/.test(source)
      ) {
        violations.push(`${id}: animates with no reduced-motion guard`);
      }
    }
    expect(
      charts.length,
      "the tree still has charts to check",
    ).toBeGreaterThanOrEqual(9);
    expect(
      violations,
      `Recharts animations are JS; use useChartMotion():\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the count-up reading the same setting", () => {
    // The other JS-driven animation. §14.5 asks for count-ups; §7 asks that they
    // be instant when the reader has asked for that.
    const countUp = readFileSync(
      join(SRC_CLIENT, "components", "AnimatedNumber.tsx"),
      "utf8",
    );
    expect(countUp).toContain("usePrefersReducedMotion");
    expect(countUp).toContain("DURATION_MS = 240");
  });
});

describe("the motion detectors can fail — the negative controls", () => {
  it("finds the reduced-motion block only when it is there", () => {
    expect(
      reducedMotionBlock(
        "@media (prefers-reduced-motion: reduce) {\n  * { animation-duration: 0.01ms; }\n}",
      ),
    ).not.toBeNull();
    expect(reducedMotionBlock(":root { --x: 1; }")).toBeNull();
    // A block that stops nothing is not the rule.
    const noCount = reducedMotionBlock(
      "@media (prefers-reduced-motion: reduce) {\n  * { transition: none; }\n}",
    );
    expect(noCount).not.toMatch(/animation-iteration-count\s*:\s*1/);
  });

  it("distinguishes a banned loop from a spinner", () => {
    expect(/\banimate-(bounce|ping)\b/.test('className="animate-bounce"')).toBe(
      true,
    );
    expect(/\banimate-(bounce|ping)\b/.test('className="animate-ping"')).toBe(
      true,
    );
    expect(/\banimate-(bounce|ping)\b/.test('className="animate-spin"')).toBe(
      false,
    );
    expect(/\banimate-(bounce|ping)\b/.test('className="animate-pulse"')).toBe(
      false,
    );
  });

  it("distinguishes a spring from an ordinary transition", () => {
    expect(
      /type:\s*["']spring["']/.test('{ type: "spring", stiffness: 200 }'),
    ).toBe(true);
    expect(
      /\bstaggerChildren\b|\bstagger\b/.test("staggerChildren: 0.05"),
    ).toBe(true);
    expect(/type:\s*["']spring["']/.test("transition-colors")).toBe(false);
  });

  it("reads code, not the comment that names the ban", () => {
    // The exact line that failed this gate's first version, from
    // `features/sam/SamConversation.tsx` — true prose, and not a stagger.
    expect(
      stripComments(
        "// DESIGN.md §7 bans bounce and stagger, and a 1.5s period",
      ),
    ).not.toMatch(/stagger/);
    expect(stripComments("/**\n * bans stagger\n */").trim()).toBe("");
    // …and a real usage survives the strip, at the same line number.
    expect(stripComments("const t = { stagger: 0.05 };")).toMatch(/stagger/);
    expect(
      stripComments("/**\n * two\n * lines\n */\nconst x = 1;").split("\n")[4],
    ).toContain("const x = 1");
  });
});
