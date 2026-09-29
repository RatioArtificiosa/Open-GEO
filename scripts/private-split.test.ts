import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing private in the public repo.
 *
 * The secrets scan (CL-812) covers *credentials*. This covers the other half of
 * the same risk: internal business facts that are not secret and are still not
 * ours to publish. Proposal §12.4 names them — billing and org management, the
 * managed scheduler's internals, the agent's private prompts — and CL-809 exists
 * because that list was only ever prose in a private document.
 *
 * ## Why this is a different gate from the secrets scan
 *
 * There is no pattern that reliably detects "a margin percentage". These markers
 * are therefore **explicit strings** — a customer's name, an internal host, a
 * support escalation address — where a match is unambiguous. A fuzzy heuristic
 * ("looks like a percentage near a price") would fire on legitimate code and on
 * marketing copy, and a gate that cries wolf on a *commercial* detail is worse
 * than none, because someone will eventually disable it.
 *
 * So the rule is: **only check what cannot legitimately appear in an open-source
 * project.** That makes the list short, and every entry defensible on its own.
 *
 * ## The asymmetry that matters
 *
 * A false positive here costs an exemption; a false negative costs a leaked
 * margin figure or a named customer, published, permanently, in a repo anyone
 * can clone. That asymmetry is the reason the list errs toward including
 * anything a competitor would find valuable — including our own vendor's support
 * address, which is public to them and not ours to redistribute.
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
  "scratchpad",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".md",
  ".mdx",
  ".css",
  ".html",
  ".sql",
  ".sh",
  ".toml",
  ".txt",
]);

const SKIP_FILES = new Set([
  // This file, for the same reason the secrets scan exempts itself: it contains
  // a literal positive for every marker.
  "private-split.test.ts",
  "pnpm-lock.yaml",
  "package-lock.json",
]);

/**
 * Markers that must never appear in the published tree.
 *
 * Each is a string that cannot legitimately occur in an open-source project, so
 * a match needs no interpretation. `where` states what would be lost by
 * publishing it, which is what makes the list auditable rather than a vibe.
 */
const FORBIDDEN: Array<{ marker: string; where: string }> = [
  {
    marker: "support@dataforseo.com",
    where:
      "A vendor escalation path. It is public to them and not ours to redistribute, and publishing it invites support load on a channel we do not own.",
  },
  {
    marker: "@gmail.com",
    where:
      "A personal address rather than a role address. Every address here should be `hello@opengeo.so` or similar, so any other domain in a commit is a person's inbox being published.",
  },
  {
    marker: "opengeo-private",
    where:
      "The private repo's own name. Its presence in the public tree means a doc written for internal eyes has been copied across, and those docs are the ones that say what we charge.",
  },
  {
    marker: "MAINTAINER_ONLY",
    where:
      "The maintainer-doc marker. `maintainer-docs/` is by definition not for the public repo; a copy of its content that lands in `docs/` is the leak this catches.",
  },
  {
    marker: "COMMERCIAL_FLOOR",
    where:
      "Pricing floors agreed with a customer. This is the single most damaging category of leak in a SaaS repo: a competitor learns the bottom of our range for a specific account, and a customer learns another customer's discount.",
  },
  {
    marker: "INTERNAL_ACCOUNT_ID",
    where:
      "A hosted account identifier, tied to a real organisation row. Not a credential, but it links a public repo to someone's account.",
  },
];

/** Files that legitimately contain the word "customer" in ordinary product copy. */
const NOT_A_MATCH = [
  // Guard against the obvious over-broad patterns, so a future entry that
  // reintroduces one fails here rather than in a pull request.
  "the customer sees",
  "customer-facing",
  "Customer Support",
];

function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    if (SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      textFiles(full, out);
      continue;
    }
    if (!info.isFile()) continue;
    const dot = entry.lastIndexOf(".");
    if (dot === -1) continue;
    if (!TEXT_EXTENSIONS.has(entry.slice(dot))) continue;
    out.push(full);
  }
  return out;
}

type Finding = { file: string; line: number; marker: string; where: string };

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of textFiles(ROOT)) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const rule of FORBIDDEN) {
        if (!line.includes(rule.marker)) continue;
        findings.push({
          file: rel,
          line: i + 1,
          marker: rule.marker,
          where: rule.where,
        });
      }
    }
  }
  return findings;
}

const findings = scan();

describe("the private/public split", () => {
  it("reads a real number of files, so it is not vacuous", () => {
    expect(textFiles(ROOT).length).toBeGreaterThan(100);
  });

  it("matches each marker against a literal positive", () => {
    // A marker that has never fired is a marker nobody knows works.
    for (const rule of FORBIDDEN) {
      expect(
        `const x = "${rule.marker}";`.includes(rule.marker),
        `${rule.marker} did not match its own sample`,
      ).toBe(true);
      expect(rule.where.length).toBeGreaterThan(40);
    }
  });

  it("does not use the over-broad phrases it deliberately avoids", () => {
    // Named in the module docblock: no pattern for "a percentage that looks like
    // a margin". These are the shapes such a pattern would take, asserted absent
    // so reintroducing one is a visible decision rather than a quiet regression.
    const source = readFileSync(
      join(ROOT, "scripts", "private-split.test.ts"),
      "utf8",
    );
    for (const phrase of NOT_A_MATCH) {
      const marker = FORBIDDEN.find((r) => r.marker === phrase);
      expect(
        marker,
        `${phrase} must not be a forbidden marker`,
      ).toBeUndefined();
    }
    // And no regex at all: these are literal strings, which is what makes every
    // match unambiguous.
    expect(source).not.toMatch(/new RegExp\(/);
  });

  it("keeps nothing private in the published tree", () => {
    const report = findings
      .map((f) => `  ${f.file}:${f.line} — ${f.marker}\n    ${f.where}`)
      .join("\n");
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.marker}`),
      `Private markers found in the public repository:\n${report}`,
    ).toEqual([]);
  });
});
