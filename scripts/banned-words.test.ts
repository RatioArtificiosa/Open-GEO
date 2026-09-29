import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The banned-words linter.
 *
 * The design skill's §3.5 and §7 ban a specific vocabulary — "supercharge,"
 * "seamless," "unlock," "10x," "theater," and a dash in every sentence. They
 * were a list in a document, which is the same place the repo split (CL-809) and
 * the credential list (CL-812) started. This makes one of them executable.
 *
 * ## Why words, and why a *density* rule for the em-dash
 *
 * A banned word is a claim that fails on any single use: "seamless" in a product
 * description is a claim about something the reader can check, and it is wrong
 * unless it is measurable. So each word is an outright failure.
 *
 * The em-dash is different, and the distinction matters. A dash is not wrong; **a
 * dash in every sentence** is, because it is a rhythm that no human writer
 * sustains and that signals a machine wrote the paragraph. So the rule is a
 * density threshold, and it is measured *per file* rather than per line — the
 * habit is a property of a passage, not of one sentence.
 *
 * The threshold is deliberately generous. A design system doc legitimately uses
 * dashes in a few places; the failure mode this guards against is a screen where
 * every line has one. Setting it too low would mean tuning the rule down to make
 * it pass, which is the exact opposite of a gate.
 */

const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".output",
  ".vinxi",
  ".react-router",
  "coverage",
  "test-results",
  "playwright-report",
  ".turbo",
  ".wrangler",
]);

/** Only user-visible copy is linted. Tests, docs and the linter itself are not. */
const COPY_EXTENSIONS = new Set([".tsx", ".ts", ".mdx"]);

const SKIP_FILES = new Set(["banned-words.test.ts", "pnpm-lock.yaml"]);

const SKIP_DIRS_FOR_COPY = new Set([
  "docs",
  "tests",
  "e2e",
  "scripts",
  "badseo",
]);

/**
 * Files whose prose is a model prompt rather than reader-facing copy.
 *
 * See the note at the skip site for why SAM's system prompt is one of them. It is
 * named individually rather than matched by directory or prefix so the exemption
 * cannot silently widen.
 */
const SKIP_FILES_FOR_COPY = new Set([
  "src/server/features/sam/samSystemPrompt.ts",
]);

/**
 * Banned words, each with the substitute that is actually checkable.
 *
 * `why` names the failure rather than restating the ban: "unlock" is banned
 * because the reader cannot check what was unlocked, and a `fix` that is also an
 * adjective is no fix at all.
 */
const BANNED: Array<{ word: string; fix: string; why: string }> = [
  {
    word: "supercharge",
    fix: "Name the thing that got faster, and by how much.",
    why: "An unmeasurable claim about capability. The reader cannot check it, so it carries no information.",
  },
  {
    word: "seamless",
    fix: "Name what the user stops doing.",
    why: "There is no such thing as a seamless integration, and saying so asserts a perfection nobody can verify.",
  },
  {
    word: "unlock",
    fix: "State what becomes possible.",
    why: "The user already owns the product; nothing is being released to them.",
  },
  {
    word: "elevate",
    fix: "Say what got better.",
    why: "A verb with no object. It reads as effort rather than outcome.",
  },
  {
    word: "game-changing",
    fix: "Say what changed for the reader.",
    why: "A claim about the world rather than the product, and the most common tell of copy written to sound large.",
  },
  {
    word: "cutting-edge",
    fix: "Name the version or the capability.",
    why: "Every product is cutting-edge on its own homepage, so the word distinguishes nothing.",
  },
  {
    word: "world-class",
    fix: "Cite the comparison.",
    why: "Unfalsifiable without a stated peer group, and no reader supplies one in their head.",
  },
  {
    word: "theater",
    fix: "Name what is ineffective and why.",
    why: "A dismissal rather than an explanation, which is the opposite of what a precision product should do.",
  },
  {
    word: "lorem ipsum",
    fix: "Write the real string.",
    why: "Placeholder text that shipped. A test asserts none reaches a rendered surface.",
  },
  {
    word: "coming soon",
    fix: "Put a date on it.",
    why: "Without a date it is a way of saying no without refusing.",
  },
];

/**
 * Em-dash density, per file.
 *
 * Counted as a **ratio** against the file's prose lines, because a
 * 600-line component and a 12-line badge should not share a budget. But the
 * denominator has to be *prose* or the ratio is meaningless: the first version
 * counted code lines, so a file with one dash in a single explanatory comment
 * scored 8% and failed, and eleven files failed — most of them for one dash.
 *
 * That is the lesson of the whole exercise, applied to its own rule: **a
 * threshold that fires on one dash in a comment is not a stricter rule, it is a
 * broken one.** The number that matters is dashes *per written sentence*, and a
 * sentence is a line containing words.
 */
const MAX_EM_DASH_RATIO = 0.15;

/** A line of prose: letters, and not markup or code. */
function isProse(line: string): boolean {
  return (
    line !== "" &&
    !line.startsWith("<") &&
    !line.startsWith("{") &&
    /[A-Za-z]{3}/.test(line)
  );
}

function copyFiles(dir: string, rel = "", out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    if (rel === "" && SKIP_DIRS_FOR_COPY.has(entry)) continue;
    if (SKIP_FILES.has(entry)) continue;
    // SAM's system prompt is instructions *to* a model, not copy *from* one. It
    // is dense with em-dashes because it is written to be read by an LLM, and
    // its own rules tell SAM to "narrate nothing" — so the register it demands
    // of the output is not the register the prompt is written in. Flagging it
    // would apply the product's voice to the product's source of instructions,
    // which is a category error rather than a violation.
    //
    // One named file, not a directory or a prefix: a wider exclusion would hide
    // the copy in whatever else lives there, silently and forever.
    if (SKIP_FILES_FOR_COPY.has(`${rel}${entry}`)) continue;
    const full = join(dir, entry);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      copyFiles(full, `${rel}${entry}/`, out);
      continue;
    }
    if (!info.isFile()) continue;
    const dot = entry.lastIndexOf(".");
    if (dot === -1) continue;
    if (!COPY_EXTENSIONS.has(entry.slice(dot))) continue;
    out.push(`${rel}${entry}`);
  }
  return out;
}

type WordFinding = {
  file: string;
  line: number;
  word: string;
  fix: string;
  why: string;
};
type DashFinding = {
  file: string;
  dashes: number;
  lines: number;
  ratio: number;
};

/**
 * Lines allowed to contain a banned word, each with the reason.
 *
 * The only legitimate case is **quoting the ban**: the project's
 * writing-preferences field tells customers not to use these words, so the
 * placeholder demonstrating it has to name them. That is the opposite of the
 * failure being guarded against. Exempting by *line content* rather than by file
 * keeps a real "seamless" anywhere else in the same file failing — a file-level
 * skip would be a blind spot exactly where the copy lives.
 */
const ALLOWED: Array<{ contains: string; why: string }> = [
  {
    contains: "Never say 'seamless' or 'game-changing'",
    why: "A placeholder demonstrating the writing preferences a customer sets for our AI. It has to name the banned words in order to forbid them.",
  },
];

function isAllowed(line: string): boolean {
  return ALLOWED.some((entry) => line.includes(entry.contains));
}

function scanWords(): WordFinding[] {
  const findings: WordFinding[] = [];
  for (const rel of copyFiles(ROOT)) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (isAllowed(line)) continue;
      const lower = line.toLowerCase();
      for (const rule of BANNED) {
        if (!lower.includes(rule.word)) continue;
        findings.push({ file: rel, line: i + 1, ...rule });
      }
    }
  }
  return findings;
}

/**
 * Reduce a line to the part a *reader* would see.
 *
 * Comments and import paths are removed, because the rule is about prose that
 * ships to a user. Without this the first run flagged `samSystemPrompt.ts` at
 * 19% — a file of block comments explaining the prompt's design, none of which
 * anyone reads as English prose. A writing-habit rule pointed at code comments is
 * not a stricter rule; it is a different rule wearing the same name, and it
 * teaches the team to ignore the whole linter.
 */
function proseOf(line: string): string {
  const withoutBlock = line.replace(/\/\*[\s\S]*?\*\//g, " ");
  const withoutLineComment = withoutBlock.replace(/\/\/.*$/, "");
  return withoutLineComment.replace(/^\s*(import|export)\s.*$/, "").trim();
}

function scanDashes(): DashFinding[] {
  const findings: DashFinding[] = [];
  for (const rel of copyFiles(ROOT)) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    // Blank and comment-only lines are not prose, so they do not count toward
    // the denominator. Counting them would let a file pad its ratio with
    // whitespace, which is the same class of trick the rule exists to prevent.
    const prose = lines.map(proseOf).filter(isProse);
    if (prose.length < 6) continue;
    const dashes = prose.filter((l) => l.includes("—")).length;
    const ratio = dashes / prose.length;
    if (ratio > MAX_EM_DASH_RATIO) {
      findings.push({ file: rel, dashes, lines: prose.length, ratio });
    }
  }
  return findings;
}

const wordFindings = scanWords();
const dashFindings = scanDashes();

describe("the banned-words linter", () => {
  it("reads a real number of copy files, so it is not vacuous", () => {
    expect(copyFiles(ROOT).length).toBeGreaterThan(20);
  });

  it("matches each banned word against a literal positive", () => {
    // One sample per word, read exactly as the scanner reads it (lowercased,
    // `includes`). The first version shared one sentence across every rule and
    // then enumerated which words that sentence happened to contain — a test
    // describing the implementation rather than checking it, and it failed for
    // exactly the reason such tests do: "unlock" is not in "supercharge your
    // workflow", and the enumeration was wrong.
    const samples: Array<[string, string]> = [
      ["supercharge", "Supercharge your workflow."],
      ["seamless", "A seamless integration."],
      ["unlock", "Unlock your potential."],
      ["elevate", "Elevate your data."],
      ["game-changing", "A game-changing release."],
      ["cutting-edge", "The cutting-edge option."],
      ["world-class", "A world-class platform."],
      ["theater", "That is theater."],
      ["lorem ipsum", "lorem ipsum dolor sit amet"],
      ["coming soon", "Coming soon!"],
    ];
    // The list and the samples are asserted equal, so adding a word without a
    // sample fails here rather than being silently unverified.
    expect(samples.map(([w]) => w)).toEqual(BANNED.map((r) => r.word));
    for (const [word, sample] of samples) {
      const rule = BANNED.find((r) => r.word === word);
      expect(rule, `no rule named ${word}`).toBeDefined();
      expect(
        sample.toLowerCase().includes(rule?.word ?? ""),
        `${word} did not match "${sample}"`,
      ).toBe(true);
    }
  });

  it("gives every banned word a checkable substitute", () => {
    // A `fix` that is itself an adjective is no fix. This is the assertion that
    // keeps the list from decaying into "use a better word".
    for (const rule of BANNED) {
      expect(rule.fix.length).toBeGreaterThan(15);
      expect(rule.why.length).toBeGreaterThan(30);
      for (const banned of BANNED) {
        expect(rule.fix.toLowerCase()).not.toContain(banned.word);
      }
    }
  });

  it("keeps the banned words out of the shipped copy", () => {
    const report = wordFindings
      .map(
        (f) =>
          `  ${f.file}:${f.line} — "${f.word}"\n    ${f.why}\n    Fix: ${f.fix}`,
      )
      .join("\n");
    expect(
      wordFindings.map((f) => `${f.file}:${f.line} ${f.word}`),
      `Banned words in shipped copy:\n${report}`,
    ).toEqual([]);
  });

  it("keeps em-dash density readable on every file", () => {
    // The rule is about rhythm, not about a single dash: a human writer uses
    // them. It is the passage where *every* line has one that reads as generated.
    const report = dashFindings
      .map(
        (f) =>
          `  ${f.file} — ${f.dashes}/${f.lines} lines (${(f.ratio * 100).toFixed(0)}%, max ${(MAX_EM_DASH_RATIO * 100).toFixed(0)}%)\n` +
          `    A dash in nearly every sentence is a machine rhythm. Use periods.`,
      )
      .join("\n");
    expect(
      dashFindings.map((f) => `${f.file} ${(f.ratio * 100).toFixed(0)}%`),
      `Em-dash density above threshold:\n${report}`,
    ).toEqual([]);
  });

  it("does not count a dash in a short file", () => {
    // A four-line button with two dashes is not a writing-habit problem, and
    // counting it would make the rule about file length rather than prose.
    const findings = dashFindings.map((f) => f.lines);
    expect(findings.every((n) => n >= 6)).toBe(true);
  });
});
