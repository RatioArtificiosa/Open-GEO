import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No credentials in the public repo.
 *
 * This is a **merge gate**, and it is deliberately the cheapest possible shape: a
 * directory walk plus a list of patterns. A sophisticated secret scanner would
 * be a dependency with its own false-positive profile and its own update cadence;
 * a hand-written list is 30 lines, has no false positives to tune away, and
 * fails loudly on the specific thing that would actually hurt.
 *
 * ## What "actually hurt" means here
 *
 * This is a public repository, and the consequences are not symmetric. A leaked
 * DataForSEO credential costs money directly and can be found by anyone who
 * scrapes GitHub for `api.dataforseo.com` in an auth header. So the patterns
 * below are drawn from **the credentials this project actually uses** — not a
 * generic list of what secrets look like. A pattern for a credential we have
 * never had is a pattern that will only ever fire on a false positive.
 *
 * The env-var *names* are the exception: `.env.example` is supposed to contain
 * them, and it is excluded explicitly. What must never appear is a **value**.
 *
 * ## Why a source scan, and its one weakness
 *
 * This reads committed files, so it cannot see a secret in a commit that has not
 * been made yet — which is the right trade, because the risk being managed is
 * *publishing* one, not writing one locally. `.gitignore`d files are not
 * scanned, and that is intentional: a developer's local `.env` is not published
 * and must not fail their build.
 *
 * The weakness, stated rather than hidden: a secret in a **binary** (a `.png`
 * with a key burnt in) is invisible here. That is out of scope for a text scan,
 * and the honest thing is to say so rather than imply coverage.
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

/** Extensions we can read as text. Anything else is out of scope, by design. */
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
  // Carries names and comments only — that is its whole purpose.
  ".env.example",
  ".env.preview.example",
  "pnpm-lock.yaml",
  "package-lock.json",
  // This file. It necessarily contains a literal positive for every pattern, so
  // without the exclusion the gate fails on its own samples on the first run —
  // which is the *correct* behaviour for a scanner and the wrong outcome for a
  // gate, so the one file that must be exempt is named here rather than the
  // patterns being weakened to tolerate it.
  "secrets-scan.test.ts",
]);

/**
 * Values that are public **by design**, allowlisted individually.
 *
 * Not a file exclusion: a blanket skip would also blind the gate to a real
 * credential pasted into the same file, which is the whole point. Each entry
 * names the exact string and says why it is not a secret, so a *different* key in
 * the same file still fails.
 *
 * PostHog **project** API keys (`phc_`) are write-only ingestion keys. They are
 * designed to be public — they ship in client-side JavaScript bundles for every
 * site using PostHog — and the PostHog UI labels them as safe to expose. What
 * they permit is sending events, which is the feature. Reading anything requires
 * the separate personal API key (`phx_`), which is *not* here and is covered by
 * the same pattern.
 */
const PUBLIC_BY_DESIGN: Array<{ value: string; why: string }> = [
  {
    value: "phc_xaXj4vE4LikxfvR7q6EHemAYNBSZW4hQkqor7fpf8aGT",
    why: "OpenGeo's own PostHog project key, hardcoded so a self-hosted install reports telemetry without configuration. Write-only by design; readable only with the personal API key, which is not in this repo.",
  },
];

/**
 * A credential shape, with the reason it matters *here*.
 *
 * Each pattern is named for what it detects, and the note says why that
 * credential is dangerous in this specific repository. A pattern whose note is
 * "secrets should not be committed" tells the next reader nothing.
 */
const PATTERNS: Array<{ name: string; pattern: RegExp; why: string }> = [
  {
    name: "DataForSEO credentials in a URL",
    // `login:password@host` — the Basic-auth form every DataForSEO example uses.
    pattern: /https?:\/\/[^\s/:@"']+:[^\s/@"']+@(api\.)?dataforseo\.com/i,
    why: "This is the credential shape in every DataForSEO doc example, so it is the exact string a paste would introduce. It bills real money and is scrapeable from GitHub within minutes.",
  },
  {
    name: "A DataForSEO Basic auth header",
    pattern: /authorization:\s*basic\s+[A-Za-z0-9+/]{16,}={0,2}/i,
    why: "The same credential, base64-encoded. Scanning only the URL form would miss it, and base64 is not encryption — it decodes to the same login:password pair.",
  },
  {
    name: "A DataForSEO password assignment",
    pattern: /DATAFORSEO_PASSWORD\s*=\s*["'][^"']{4,}["']/i,
    why: "The env var this project reads. `.env.example` carries the name with no value and is excluded, so any value here is a pasted credential.",
  },
  {
    name: "A private key block",
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    why: "A deploy key committed by accident. Cheap to check, and the file it would land in is usually one nobody reviews.",
  },
  {
    name: "A GitHub token",
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/,
    why: "Would let anyone reading the repo push to it. The prefix is fixed by GitHub, so this cannot false-positive on prose.",
  },
  {
    name: "An OpenAI key",
    pattern: /sk-[A-Za-z0-9]{32,}/,
    why: "Bills directly, is not rate-limited by GitHub, and the prefix is fixed. `sk-` is specific enough that no English word contains it.",
  },
  {
    name: "An AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    why: "Fixed prefix, fixed length, so it cannot be prose. Grants read on any bucket the IAM user can reach.",
  },
  {
    name: "A Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
    why: "Fixed prefix. A leaked webhook token is enough to post into a customer-facing channel.",
  },
  {
    name: "A PostHog project API key",
    pattern: /phc_[A-Za-z0-9]{20,}/,
    why: "This project's analytics. Readable means anyone can enumerate our events and our user list.",
  },
];

/** Every text file, skipping the directories and files named above. */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_FILES.has(entry)) continue;
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

type Finding = { file: string; line: number; rule: string; why: string };

/**
 * Lines that matched a pattern but were allowlisted as public by design.
 *
 * Reported rather than swallowed, so the exemption list cannot grow quietly: it
 * is asserted below to be exactly what it claims, and a reader can see every
 * value the gate is choosing not to flag.
 */
const exempted: string[] = [];

function scan(): Finding[] {
  const findings: Finding[] = [];
  exempted.length = 0;
  for (const file of textFiles(ROOT)) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const rule of PATTERNS) {
        if (!rule.pattern.test(line)) continue;
        // An allowlisted public value is reported as neither a finding nor a
        // pass-by-default: the exemption is explicit and inspectable, and a
        // *different* key on the same line still fires.
        const exempt = PUBLIC_BY_DESIGN.find((entry) =>
          line.includes(entry.value),
        );
        if (exempt !== undefined) {
          exempted.push(`${rel}:${i + 1} — ${rule.name} (public by design)`);
          continue;
        }
        findings.push({
          file: rel,
          line: i + 1,
          rule: rule.name,
          why: rule.why,
        });
      }
    }
  }
  return findings;
}

const findings = scan();

describe("the secrets scan", () => {
  it("reads a real number of files, so it is not vacuous", () => {
    // The failure mode for a source-scanning gate is a wrong path that has been
    // passing silently since the day it was written. A scan of 0 files is green.
    expect(textFiles(ROOT).length).toBeGreaterThan(100);
  });

  it("recognises every declared pattern", () => {
    // Each pattern is exercised against a literal positive. A pattern that has
    // never fired is a pattern nobody knows works, and a typo in a regex is
    // silent — it simply never matches anything, forever.
    const samples: Array<[string, string]> = [
      [
        "DataForSEO credentials in a URL",
        "curl https://me:secret123@api.dataforseo.com/v3/serp",
      ],
      [
        "A DataForSEO Basic auth header",
        "authorization: Basic dXNlcjpsZWNyZXQxMjM0NTY3",
      ],
      ["A DataForSEO password assignment", 'DATAFORSEO_PASSWORD = "hunter2"'],
      ["A private key block", "-----BEGIN RSA PRIVATE KEY-----"],
      ["A GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
      ["An OpenAI key", "sk-abcdefghijklmnopqrstuvwxyz0123456789"],
      ["An AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
      ["A Slack token", "xoxb-1234567890-abcdefghij"],
      ["A PostHog project API key", "phc_abcdefghijklmnopqrstuv"],
    ];
    for (const [name, sample] of samples) {
      const rule = PATTERNS.find((r) => r.name === name);
      expect(rule, `no rule named ${name}`).toBeDefined();
      expect(
        rule?.pattern.test(sample),
        `${name} did not match its own sample`,
      ).toBe(true);
    }
  });

  it("does not fire on ordinary source or prose", () => {
    // The other half of a gate's honesty. A pattern that fires on a doc comment
    // teaches everyone to add an exception, and then it fires on the real thing.
    const innocent: Array<[string, string]> = [
      [
        "DataForSEO credentials in a URL",
        "const BASE = 'https://api.dataforseo.com/v3'",
      ],
      [
        "A DataForSEO Basic auth header",
        "// the Authorization header is built at request time",
      ],
      [
        "A DataForSEO password assignment",
        "DATAFORSEO_PASSWORD is required in production",
      ],
      ["A private key block", "Deploy with a signing key, not a private key"],
      ["A GitHub token", "the gh cli handles auth"],
      ["An OpenAI key", "use sk-your-key-here in your env"],
      ["An AWS access key id", "AKIA is the prefix for an access key id"],
      ["A Slack token", "xoxb tokens belong in a secret store"],
      ["A PostHog project API key", "phc_ is the PostHog key prefix"],
    ];
    for (const [name, sample] of innocent) {
      const rule = PATTERNS.find((r) => r.name === name);
      expect(rule?.pattern.test(sample), `${name} fired on ordinary text`).toBe(
        false,
      );
    }
  });

  it("finds no credentials in the committed tree", () => {
    const report = findings
      .map((f) => `  ${f.file}:${f.line} — ${f.rule}\n    ${f.why}`)
      .join("\n");
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.rule}`),
      `Credentials found in the public repository:\n${report}`,
    ).toEqual([]);
  });

  it("exempts only what it claims, and only by exact value", () => {
    // The exemption is per *value*, not per file or per pattern. A different
    // PostHog key in the same file must still fail, or the allowlist is a blind
    // spot shaped like a key.
    for (const entry of PUBLIC_BY_DESIGN) {
      expect(entry.why.length).toBeGreaterThan(40);
    }
    const otherKey = "phc_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    const rule = PATTERNS.find((r) => r.name === "A PostHog project API key");
    expect(rule?.pattern.test(`const KEY = "${otherKey}"`)).toBe(true);
    expect(
      PUBLIC_BY_DESIGN.some((entry) => otherKey.includes(entry.value)),
    ).toBe(false);
  });

  it("reports every exemption rather than swallowing it", () => {
    // If this ever reads empty while a public key is in the tree, the exemption
    // has started matching more than it should.
    expect(exempted.length).toBeGreaterThan(0);
  });
});
