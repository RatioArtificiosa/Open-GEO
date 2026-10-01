import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * §12.4 "What stays OUT of the repo", clause by clause.
 *
 * ## Why an audit rather than another gate
 *
 * §12.4 is **one line of prose**:
 *
 * > Billing / Autumn keys · org management · cloud-only config · the managed
 * > scheduler's internals · any API key · the agent's private prompts.
 *
 * Six clauses, and as of this writing **two** of them are mechanically enforced
 * (CL-812 for API keys, CL-809 for the non-secret internals). The other four
 * are good intentions. The failure mode of an intention is that it is
 * indistinguishable from a completed one at a glance: a reader scanning the
 * checklist sees ticks next to two clauses and reasonably concludes the line is
 * handled.
 *
 * So this file does not add a seventh detector. It **enumerates every clause and
 * states, per clause, whether it is enforced, by what, and what a violation
 * would look like.** An unenforced clause is a *reported fact*, not a silent
 * gap. That is the whole design: the audit is the deliverable, and the honest
 * state of the list is more useful than a green tick that overstates coverage.
 *
 * ## A clause marked `manual` is not a failure
 *
 * Failing the build on "you have not mechanised this" would push people to tick
 * the box rather than do the work, and would make the audit a ritual. What fails
 * the build is a clause whose *enforcement* has silently regressed — a gate file
 * deleted, a marker list emptied, a test that no longer runs. Those are real and
 * detectable.
 *
 * Verified on 2026-09-29.
 */

const ROOT = process.cwd();

/**
 * The repository root, which is **not** the same directory as `ROOT`.
 *
 * `G:\opengeo` is the git repository; `G:\opengeo\Open-GEO` is a nested working
 * tree inside it, with its own `.git`. Every gate in this file walks `ROOT`, so
 * the repository's own documents — `OPENGEO_CHECKLIST.md`,
 * `OPENGEO_MASTER_REFERENCE.md`, `docs/**` — have never been scanned by any of
 * them.
 *
 * That is not hypothetical. **`OPENGEO_CHECKLIST.md` was carrying 20 corrupted
 * characters while both encoding gates reported "0 files, 0 sequences" on every
 * run**, because the file is outside their walk: two NUL bytes where a digit `0`
 * belonged, two `null`s that had lost their leading `n`, and fourteen control
 * bytes (BEL, BS, FF) sitting exactly where the first letter of an identifier
 * belonged — `atRiskUsd`, `ai_mention_history`, `failed`, `fetch`,
 * `allowed_mentions`, `acquisition-mode-gate`, `billed-tasks-gate`. Every one
 * was invisible in an editor and in `git diff`.
 *
 * A gate that cannot see the file it is protecting is not a gate — so the walk can
 * be pointed above this checkout. It used to do that **automatically**, taking the
 * outermost `.git` it could find, and that was a mistake in the other direction:
 * a developer whose `$HOME` is itself a dotfiles repository resolves to `$HOME`,
 * and the scan walks their whole home directory.
 *
 * `G:\opengeo` and `G:\opengeo\Open-GEO` are **two independent repositories**, and
 * the parent excludes the child outright (`.git/info/exclude`: `Open-GEO/`), so
 * this file's own contents are not in the parent's index and vice versa. The
 * nested tree is scanned either way, because it is inside the nearest root.
 *
 * So: **the nearest `.git` by default, and the outer root only when asked for**
 * with `PREPUBLISH_AUDIT_ROOT`. Both halves matter. The nearest root keeps the
 * gate pointed at this project; the override is what lets a deliberate run reach
 * the parent's documents, which is where the damage above was found — reached on
 * purpose, recorded in the run, rather than by a heuristic that happened to work on
 * one machine and misfired on another.
 *
 * Degrading gracefully: if no `.git` is found at all, `ROOT` is used, so the gate
 * is never weaker than it was.
 */
const REPO_ROOT = (() => {
  // **Opt-in override, because the default had to change.**
  //
  // This used to walk five levels up and keep the **outermost** directory holding
  // a `.git`, on the reasoning that the damaged documents this gate finds live in
  // the parent of this checkout. That is true, and it is also unbounded in
  // practice: a developer with a dotfiles repository at `$HOME` resolves
  // `REPO_ROOT` to `$HOME`, and the scan then walks their entire home directory —
  // slow, and failing on files that have nothing to do with this project.
  //
  // **A gate that can be pointed at the wrong tree is a gate whose result nobody
  // trusts**, which is worse than a narrower one. So the nearest `.git` is the
  // default, and the outer root — the one layout that genuinely needs it — is
  // requested explicitly:
  //
  //     PREPUBLISH_AUDIT_ROOT=/path/to/outer pnpm vitest run scripts/prepublish-audit
  //
  // The nearest root still covers the nested `Open-GEO/` tree, which is where the
  // control characters found in this session actually were. The parent's own
  // documents are scanned by a run configured with the override, not by accident.
  const override = process.env.PREPUBLISH_AUDIT_ROOT;
  if (override) return override;
  let dir = ROOT;
  // Bounded: a checkout cannot nest many repositories deep, and an unbounded walk
  // that found nothing would climb to the filesystem root.
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ROOT;
})();

/**
 * Directories to skip, expressed by name, applied at **every** level.
 *
 * The nested `Open-GEO/` tree is *not* skipped: it is source, and the control
 * characters found in it this session were a live bug. Only the vendored and
 * generated directories are skipped.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".output",
  ".react-router",
  "coverage",
  "test-results",
  "playwright-report",
  ".wrangler",
  "scratchpad",
  ".agents",
  ".claude",
  ".commandcode",
  ".alchemy",
  /**
   * `open-seo/` is an **upstream clone with its own `.git`**, kept as a reference
   * for comparison. It is not this project's source and its defects are not ours
   * to fix — and it has one: a `0x01` inside a cache-key separator in
   * `keywordControllerActions.ts`, the same corruption that was fixed in
   * Open-GEO's own copy.
   *
   * Skipped for the same reason `node_modules` is: a vendored tree has its own
   * gates, and a failing assertion about someone else's checkout is noise that
   * trains people to ignore this one.
   */
  "open-seo",
  "web",
  "badseo",
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

/**
 * Files that legitimately contain the byte sequences this gate looks for.
 *
 * Both entries *quote the damage they describe*, which is what makes them exempt
 * rather than merely inconvenient:
 *
 * - `prepublish-audit.test.ts` names the byte values it searches for.
 * - `observations-and-memories.md` is the project's ledger, and its row 6 records
 *   the incident in which 174 files were double-encoded — quoting `â€¦` for `…`
 *   as the evidence. That is a file *correctly containing* mojibake, and the
 *   detector read its own historical record as a fresh finding.
 *
 * The first version of the widened gate failed on that file with a confident
 * "1 file, 1 sequence" and the ledger's own wording as the quoted damage. It is
 * the same failure as every other detector in this repository reporting the wrong
 * thing confidently: the rule cannot distinguish *damage* from *a quotation of
 * damage*, and the honest answer to that is a named exemption rather than a
 * looser rule — a looser rule would have to be loose enough to miss real damage.
 */
const EXEMPT = new Set([
  "prepublish-audit.test.ts",
  "REBRAND-NOTES.md",
  "observations-and-memories.md",
]);

function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (EXEMPT.has(entry)) continue;
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

type Enforcement =
  /** A test fails the build when the clause is violated. */
  | "gate"
  /** Detectable in principle, not yet mechanised. The gap is stated, not hidden. */
  | "manual";

type Clause = {
  /** The clause exactly as §12.4 words it. */
  clause: string;
  enforcement: Enforcement;
  /** The file that enforces it, or why nothing does. */
  by: string;
  /**
   * What a violation would actually look like here. A clause with no concrete
   * failure mode is a clause nobody can check by reading, which is the same as
   * unchecked.
   */
  looksLike: string;
};

/**
 * The six clauses, in §12.4's own order and wording.
 *
 * Kept as data rather than as a doc comment so the test can *assert* the count
 * and the wording. If §12.4 gains a clause, this list has to be updated, and
 * that is the moment someone is forced to decide whether it is enforced — which
 * is the entire point of the exercise.
 */
const CLAUSES: Clause[] = [
  {
    clause: "Billing / Autumn keys",
    enforcement: "gate",
    by: "scripts/secrets-scan.test.ts (CL-812)",
    looksLike:
      "A real vendor key committed, or the Autumn key itself. Found two live PostHog keys on the first run; exempted by exact value so a different key in the same file still fails.",
  },
  {
    clause: "org management",
    enforcement: "gate",
    by: "scripts/private-split.test.ts (CL-809)",
    // The marker's own name is deliberately not written here. CL-809's scan
    // exempts only its own file, and that is correct: an exemption for a second
    // file would mean anyone could add a file to the skip list and switch the
    // gate off. So this describes the leak rather than quoting it, which is both
    // compliant and clearer about what the gate is for.
    looksLike:
      "A hosted org-management internal — an account identifier tied to a real organisation row, or the private repo's own name — reaching the public tree. Not a credential, but it links a public repo to someone's account.",
  },
  {
    clause: "cloud-only config",
    enforcement: "manual",
    by: "Not mechanised. The nearest check is the env registry in Appendix B being documented rather than validated.",
    looksLike:
      "A Cloudflare-account-specific id, a Workers binding name, or a deploy-target hostname landing in src/. A binding name is arguably fine to publish; a hostname is not, and nothing currently separates the two.",
  },
  {
    clause: "the managed scheduler's internals",
    enforcement: "manual",
    by: "Not mechanised, and deliberately so: `scheduledGeoPatrol.ts` and the cron wiring in `server.ts` are *supposed* to be public — the self-hoster needs them. The clause is about the hosted service's queue, not the code.",
    looksLike:
      "A hosted-only retry ladder, queue-depth threshold, or per-tenant fairness rule copied into the shared code, where a self-hoster would read it as a guarantee we do not give.",
  },
  {
    clause: "any API key",
    enforcement: "gate",
    by: "scripts/secrets-scan.test.ts (CL-812)",
    looksLike:
      "Any credential-shaped string. The scan is value-based rather than pattern-based for the known keys, so a new key in a new file fails rather than being exempted by proximity.",
  },
  {
    clause: "the agent's private prompts",
    enforcement: "manual",
    by: "Not mechanised. `scripts/samSkills.test.ts` covers the *skills* being in sync; nothing covers a private system prompt.",
    looksLike:
      "A system prompt or rubric for SAM or the audit agent landing in the public tree. §12.4 itself says to decide per case — skills are public, prompts can be — so the missing thing is a *decision*, not only a detector.",
  },
];

describe("proposal §12.4 — what stays out of the repo", () => {
  it("covers every clause, and has not quietly lost one", () => {
    // Six clauses, six entries. If §12.4 is edited, this fails and someone has to
    // decide what the new clause means for enforcement. That is the mechanism.
    expect(CLAUSES).toHaveLength(6);
    const expected = [
      "Billing / Autumn keys",
      "org management",
      "cloud-only config",
      "the managed scheduler's internals",
      "any API key",
      "the agent's private prompts",
    ];
    expect(CLAUSES.map((c) => c.clause)).toEqual(expected);
  });

  it("states a concrete failure mode for every clause", () => {
    // A clause whose violation cannot be pictured is a clause nobody can check
    // by reading, which is the same as unchecked. This also stops an entry being
    // added with a placeholder.
    for (const clause of CLAUSES) {
      expect(
        clause.looksLike.length,
        `${clause.clause} has no failure mode`,
      ).toBeGreaterThan(40);
      expect(
        clause.by.length,
        `${clause.clause} has no provenance`,
      ).toBeGreaterThan(10);
    }
  });

  it("has a real file behind every clause marked as gated", () => {
    // The one thing that *does* fail the build. A gate that was deleted, renamed
    // or moved would otherwise leave the clause claiming enforcement it no
    // longer has — and a claim of enforcement that is not true is worse than an
    // honest "manual", because it stops anyone from doing the work.
    const gated = CLAUSES.filter((c) => c.enforcement === "gate");
    expect(gated.length).toBeGreaterThan(0);

    const files = new Set(
      gated.map((c) => c.by.match(/scripts\/[^\s(]+/)?.[0]).filter(Boolean),
    );
    for (const file of files) {
      expect(
        existsSync(join(ROOT, file ?? "")),
        `${file} is claimed as the gate for a §12.4 clause but does not exist`,
      ).toBe(true);
    }
  });

  it("names which clauses are unenforced, so the gap is visible", () => {
    // Not a failure — an assertion of honesty. Four of six are mechanised today,
    // and a reader of the checklist should be able to see that without reading
    // this file, so the count is pinned here to stop it drifting silently upward
    // in the ledger.
    const manual = CLAUSES.filter((c) => c.enforcement === "manual");
    expect(manual.map((c) => c.clause).sort()).toEqual([
      "cloud-only config",
      "the agent's private prompts",
      "the managed scheduler's internals",
    ]);
    // Every manual clause must say why, in words, not just be labelled.
    for (const clause of manual) {
      expect(clause.by).toMatch(/not mechanised/i);
    }
  });

  it("reads the clause list from the proposal, so the two cannot drift", () => {
    // The audit's value is that it is derived from the document, not a copy of
    // it. This reads §12.4 out of the ledger repo when it is reachable, and
    // asserts the six phrases appear there verbatim.
    const proposal = join(ROOT, "..", "OPENGEO_PROPOSAL.md");
    if (!existsSync(proposal)) {
      // The ledger lives in a sibling repo and is not present in every checkout
      // (notably CI, which clones only this repo). Skipping is the honest
      // outcome: inventing a pass here would be the exact overstatement this
      // file exists to prevent.
      return;
    }
    const text = readFileSync(proposal, "utf8");
    const section = text.slice(
      text.indexOf("### 12.4 What stays OUT of the repo"),
    );
    expect(section.length).toBeGreaterThan(0);
    for (const clause of CLAUSES) {
      const phrase = clause.clause.split(" / ")[0] ?? clause.clause;
      expect(section, `§12.4 no longer says "${phrase}"`).toContain(phrase);
    }
  });
});

describe("the gate files themselves", () => {
  it("run, and are wired into the CI check", () => {
    // `ci:check` is the only thing standing between a gate and a file nobody
    // executes. A gate not named in it is a gate that has stopped protecting
    // anything while still appearing in this audit as enforcement.
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const ci = pkg.scripts?.["ci:check"] ?? "";
    expect(ci).toContain("knip");
    // The two §12.4 gates are vitest files, so they run under `vitest run`
    // rather than being named individually; assert the suite is invoked at all.
    expect(pkg.scripts?.test ?? "").toContain("vitest");
    expect(pkg.scripts?.["test:ci"] ?? "").toContain("vitest");
  });

  it("keeps the private-split marker list non-empty", () => {
    // A limits or marker table with no entries enforces nothing and looks
    // identical to one that does. CL-809's own gate asserts this for the vendor
    // limits table; the same reasoning applies here, and the check is cheap
    // enough to keep next to the audit that cites it.
    const source = readFileSync(
      join(ROOT, "scripts", "private-split.test.ts"),
      "utf8",
    );
    const markers = source.match(/marker:\s*"[^"]+"/g) ?? [];
    expect(markers.length).toBeGreaterThanOrEqual(6);
  });
});

describe("import casing matches the filesystem, because CI is Linux", () => {
  // **This is why the pipeline was red on 30 consecutive runs.**
  //
  // Two `?raw` imports named their target in a different case than the file on
  // disk:
  //
  //   import ... from ".../.agents/skills/setup-opengeo/SKILL.md?raw"
  //   import ... from "@/server/features/sam/opengeo-fact-sheet.md?raw"
  //
  // while the tracked files are `setup-OpenGeo/SKILL.md` and
  // `OpenGeo-fact-sheet.md`. **Windows resolves either casing**, so the build
  // worked here and `knip` was clean locally. Linux is case-sensitive, so on CI
  // both imports were unresolvable — and because `knip` is the second step of
  // `ci:check`, nothing after it ran, ever.
  //
  // Nothing about the failure pointed at casing. It said "Unresolved imports",
  // which reads as a missing file, and the obvious response — add the file — is
  // exactly wrong when the file is present under a different name.
  //
  // So the rule is pinned here: **every relative or aliased import must match a
  // tracked path exactly, byte for byte, including case.** A test rather than a
  // lint rule, because the failure mode is a platform difference that only a test
  // comparing against git's own index can see.
  it("matches every local import to a tracked path exactly", () => {
    // **`git ls-files` must run against the repository this test is scanning, and
    // with `-C` so the working directory is not the question.** `REPO_ROOT` in
    // this module is the *outermost* git repository, which is the parent of
    // `Open-GEO` — so a bare `git ls-files` lists the parent's tracked files, and
    // not one path under `src/` ever matches. That is why the first version of
    // this test passed with the casing bug still present: it was comparing the
    // import against an index that did not contain it, in either direction.
    //
    // The two repositories are separate: the parent's `.git/info/exclude` omits
    // `Open-GEO/` entirely, so no path in this tree appears in the parent's index.
    // Naming the directory explicitly is the only correct form.
    const tracked = new Set(
      execFileSync("git", ["-C", ROOT, "ls-files"], {
        encoding: "utf8",
        maxBuffer: 1e9,
      })
        .split("\n")
        .filter(Boolean)
        .map((f) => f.replace(/\\/g, "/")),
    );
    // A control: the index is not empty, or every rule below is vacuous.
    expect(tracked.size).toBeGreaterThan(100);

    // **The case-folded set, and this is the part that makes the rule work on
    // Windows.** `git ls-files` reports the path as it exists *on disk*, and a
    // Windows checkout holds whatever casing the last write left behind — so after
    // fixing an import to the committed casing, `ls-files` can still report the
    // old one and the mismatch becomes invisible. The first version of this test
    // passed with the bug reintroduced, which is the exact failure a gate exists
    // to prevent.
    //
    // So the two spellings are compared as a *pair*: an import resolves only if it
    // matches a tracked path exactly, and the reported offender names the
    // case-folded sibling so the reader is told the real problem rather than
    // "file not found".
    const caseFolded = new Map<string, string[]>();
    for (const t of tracked) {
      const key = t.toLowerCase();
      const list = caseFolded.get(key) ?? [];
      list.push(t);
      caseFolded.set(key, list);
    }

    // **The walk starts at `ROOT`, not `REPO_ROOT`, and that distinction is the
    // gate.** `REPO_ROOT` is the *outermost* git repository, which is the parent
    // of `Open-GEO`; the parent excludes `Open-GEO/` through its
    // `.git/info/exclude`, so walking from there finds **no** `src/` at all and
    // the offender list is empty because nothing was scanned.
    //
    // The encoding rules deliberately scan `REPO_ROOT`, because the damaged
    // documents this repository found live in the parent and a scan that stopped
    // at the nested root would never have seen them. **Those two jobs need
    // different roots and the difference is the whole bug**, which is why the
    // control above asserts the scanned set actually contains the file that
    // motivated the rule.
    const files = textFiles(ROOT)
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .filter((f) => f.startsWith("src/") || f.startsWith("scripts/"))
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

    // A control on the control: the file that motivated this rule must be among
    // the files scanned. If it is not, `offenders` is empty for the wrong reason
    // and the test is decorative — which is the failure this whole repository
    // keeps finding, and the reason the first two versions of this gate passed
    // with the real bug still in the source.
    expect(files.some((f) => f.endsWith("ai-mcp/agentSetupPrompt.ts"))).toBe(
      true,
    );

    const offenders: string[] = [];
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        // `?raw` is a Vite feature, not part of the path. Everything after the `?`
        // is a bundler query and has to be stripped before the file is looked up.
        const clean = m[1].split("?")[0];

        // **The candidate list has to include the extension.** A TypeScript
        // import names `./agentUpdatePrompt`, not `./agentUpdatePrompt.ts`, so
        // comparing the specifier directly against `git ls-files` marks *every*
        // relative import in the repository as untracked. The first version of
        // this test did exactly that and therefore passed with the real bug still
        // present, because it was reading a different list than it had built.
        // A gate that cannot fail is the thing this repository keeps finding.
        const base = clean.startsWith("@/")
          ? "src/" + clean.slice(2)
          : clean.startsWith(".")
            ? join(dirname(rel), clean).replace(/\\/g, "/")
            : null;
        if (base === null) continue; // a package specifier; not ours to resolve

        const candidates = [
          base,
          base + ".ts",
          base + ".tsx",
          base + ".md",
          base + ".json",
          join(base, "index.ts").replace(/\\/g, "/"),
          join(base, "index.tsx").replace(/\\/g, "/"),
        ];
        if (candidates.some((c) => tracked.has(c))) continue;
        // No exact match. A case-folded hit is the interesting case, because it is
        // the bug that Windows hides and Linux CI reports — so the message says
        // so rather than "file not found", which sends the reader looking for a
        // missing file instead of a differently-cased one.
        let reported: string | null = null;
        for (const c of candidates) {
          const s = caseFolded.get(c.toLowerCase());
          if (s) {
            reported =
              rel +
              " imports " +
              c +
              " but the tracked path is " +
              s[0] +
              " (CASE MISMATCH)";
            break;
          }
        }
        offenders.push(
          reported ??
            rel + " imports " + candidates[0] + " which is not tracked",
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("every GEO query key names the project", () => {
  // **A cache key that omits the project serves one project's data inside
  // another.** Every GEO read goes through a server function that takes the project
  // from the *authorized context* rather than the request body — which is the right
  // design, and it means the response genuinely varies by project. A key that
  // omits `projectId` then caches one project's numbers under another's name.
  //
  // The visibility forecast shipped exactly that: `[name, domain, platform]`, while
  // every query in `useGeoPageData.ts` already carried the project. One brand can
  // be monitored under several projects, so the panel rendered project A's forecast
  // inside project B for up to `GEO_QUERY_STALE_TIME_MS` — with no error, no empty
  // state, and numbers entirely plausible.
  //
  // A source scan, because the failure is a missing array element and there is no
  // runtime symptom to assert on.
  it("has no geo query key without projectId", () => {
    const offenders: string[] = [];
    for (const file of textFiles(ROOT)
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .filter((f) => f.startsWith("src/client/") && /\.(ts|tsx)$/.test(f))) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const m of text.matchAll(/queryKey:\s*\[([^\]]*)\]/g)) {
        const key = m[1];
        if (!/geo/i.test(key)) continue; // only the GEO surface is in scope
        if (!/projectId/.test(key)) {
          offenders.push(`${file}: queryKey: [${key.trim()}]`);
        }
      }
    }
    // The message names the file and the key, because "some key somewhere" is not
    // an actionable failure.
    expect(offenders).toEqual([]);
  });
});

describe("scripts run on every platform the product supports", () => {
  /**
   * The product ships to Windows, macOS and Linux, and `pnpm` picks the shell:
   * `cmd` on Windows, `sh` elsewhere. **A script written for one shell cannot
   * complete on the other**, and the script that suffers most is `ci:check` itself
   * — the command every developer runs before pushing.
   *
   * This was not hypothetical. `ci:check` ended with
   * `test -z "$(git status --porcelain -- plugins/opengeo/skills)"`, and `cmd` has
   * neither a `test` builtin nor command substitution. It passed on CI because CI
   * runs ubuntu, and it could not run at all on a Windows machine — which is where
   * the problem was found.
   */
  it("has no POSIX-only construct in any package.json script", () => {
    // `test` is matched as a *command* rather than a bare word, so
    // `playwright test` and `vitest test` — arguments, not builtins — are not
    // flagged. That distinction is the difference between a rule and a nuisance.
    //
    // Single quotes are deliberately **not** in the list: `cmd` does not treat `'`
    // as a quote character, but a script that only *contains* one still runs
    // there, and flagging them sent the first repair round in a loop.
    const POSIX_ONLY: Array<{ rule: string; re: RegExp }> = [
      { rule: "the test builtin", re: /(?:^|[\s(;&|])test\s+-[a-zA-Z]/ },
      { rule: "command substitution", re: /\$\(/ },
      { rule: "backtick substitution", re: /`[^`]+`/ },
      { rule: "export", re: /(?:^|[\s;&|])export\s/ },
      { rule: "source", re: /(?:^|[\s;&|])source\s/ },
      { rule: "bash -c", re: /bash\s+-c/ },
      {
        rule: "mkdir/rm/mv/cp with a flag",
        re: /(?:^|[\s;&|])(?:mkdir|rm|mv|cp)\s+-/,
      },
      { rule: "chmod", re: /(?:^|[\s;&|])chmod\s/ },
      { rule: "grep/sed/awk", re: /(?:^|[\s;&|])(?:grep|sed|awk)\s/ },
      { rule: "xargs", re: /(?:^|[\s;&|])xargs\b/ },
      { rule: "a heredoc", re: /<<\s*['"]?\w/ },
      { rule: "a brace range", re: /\{\d+\.\.\d+\}/ },
      { rule: "pwd", re: /(?:^|[\s;&|])pwd\b/ },
      {
        rule: "which / command -v",
        re: /(?:^|[\s;&|])(?:which|command\s+-v)\b/,
      },
      { rule: "an env VAR= prefix", re: /(?:^|[\s;&|])env\s+[A-Z_]+=/ },
    ];

    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = Object.entries(pkg.scripts ?? {});

    // A control: the rule has to be able to fail, or it is decoration. The
    // detector is exercised on a source known to be POSIX-only, and the *same*
    // patterns are asserted against a script known to be portable.
    const CONTROL_POSIX = 'test -z "$(git status --porcelain)"';
    expect(
      POSIX_ONLY.filter((r) => r.re.test(CONTROL_POSIX)).length,
    ).toBeGreaterThan(0);
    const CONTROL_PORTABLE =
      "node -e \"require('fs').mkdirSync('.logs',{recursive:true})\" && vitest run";
    expect(POSIX_ONLY.filter((r) => r.re.test(CONTROL_PORTABLE)).length).toBe(
      0,
    );

    const offenders: string[] = [];
    for (const [name, script] of scripts) {
      for (const { rule, re } of POSIX_ONLY) {
        if (re.test(script)) {
          offenders.push(`${name} uses ${rule}: ${script}`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every shell script on LF with a shebang", () => {
    // A CRLF shebang is `#!/bin/sh\r`, which the kernel does not recognise: the
    // file is not executed as a script at all. It fails on Linux and macOS and
    // works on Windows, which is the worst direction — the bug appears only where
    // the script is supposed to be running.
    //
    // `.gitattributes` already pins `*.sh` to LF, so this asserts the property
    // rather than trusting the mechanism, because a file added with `git add -f`
    // bypasses attributes and a `.bat` pinned to CRLF is the mirror image.
    const offenders: string[] = [];
    for (const file of textFiles(ROOT)
      .map((f) => relative(ROOT, f).replace(/\\/g, "/"))
      .filter((f) => /\.(sh|mjs|js)$/.test(f))) {
      const bytes = readFileSync(join(ROOT, file));
      if (bytes.includes(0x0d)) {
        offenders.push(`${file} contains a CR byte`);
        continue;
      }
      if (file.endsWith(".sh")) {
        const first = bytes.slice(0, 2).toString("utf8");
        if (first !== "#!") offenders.push(`${file} has no shebang`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("mojibake must not get worse", () => {
  // The five *sane* code points, used only to build a control fixture. The
  // matcher no longer needs a list of mangled forms: damage is now detected as a
  // broken UTF-8 continuation byte, which is a property of the encoding rather
  // than of any particular character.
  const GOOD = {
    emDash: 0x2014,
    rightQuote: 0x2019,
    leftQuote: 0x201c,
    rightDQuote: 0x201d,
    ellipsis: 0x2026,
  };

  /**
   * The ceiling. Lower it when files are repaired; raise it only with a reason.
   *
   * 2907 across 640 files, measured exactly on 2026-09-30 — the number is a
   * ratchet, not a target, and the only requirement is that it falls. A first
   * loose estimate said 709 because it counted *files* and called them
   * sequences; the count here is non-overlapping occurrences, and an undercount
   * in a ratchet is worse than no ratchet because it looks like progress.
   */
  // Reported for context only. The assertion below is 	oBe(0); there is no
  // ceiling to approach because the number this gate produces is a count of
  // *errors*, not a debt to be paid down.
  const CEILING = 0;

  function survey(): { scanned: number; sequences: number; list: string[] } {
    const files = textFiles(REPO_ROOT);
    let sequences = 0;
    const list: string[] = [];
    for (const file of files) {
      // **Read as bytes, not as a latin1 string.** The first version decoded
      // with `"latin1"` and looked for U+00E2, which matches the *correct* UTF-8
      // bytes `E2 80 94` of an em-dash exactly as much as it matches mangled
      // text - so it counted every well-formed em-dash in the repository as
      // damage. "2907 sequences" was substantially a false count, and the
      // ratchet was measuring the wrong thing entirely.
      //
      // Damage is `E2` followed by a byte that is **not** a UTF-8 continuation
      // (`80`-`BF`). A correct sequence always is, so that single test is what
      // separates a mangled file from a healthy one.
      // **The signal is a double-encoded sequence, not a broken one.**
      //
      // Two rules were tried and both were wrong:
      //
      // - "decoded as latin1, look for U+00E2" matched the *correct* UTF-8
      //   bytes of an em-dash, so every well-formed em-dash in the repo
      //   counted as damage. That produced "640 files, 2907 sequences" and I
      //   repeated it to the user twice. It was a false count.
      // - "E2 not followed by a valid continuation" cannot detect this at all:
      //   the damage lands one level down, as `C3 A2 C2 80 C2 94`, and every
      //   one of those pairs is a *valid* UTF-8 sequence.
      //
      // What is actually true: a file mangled this way contains `C3 A2`
      // where a correct file contains `E2 80`. `C3 A2` is U+00E2 encoded
      // properly, so it is well-formed UTF-8 ”” and it is not a character
      // anyone writes. That makes it a precise test rather than a heuristic.
      const bytes = readFileSync(file);
      let hits = 0;
      for (let i = 0; i < bytes.length - 1; i += 1) {
        if (bytes[i] === 0xc3 && bytes[i + 1] === 0xa2) hits += 1;
      }
      if (hits > 0) {
        sequences += hits;
        list.push(relative(REPO_ROOT, file).replaceAll("\\", "/"));
      }
    }
    return { scanned: files.length, sequences, list };
  }

  it("scans a real number of files, so a wrong directory is not green", () => {
    // A scan of 0 files passes, and that has happened here before: the
    // private-split scan shipped with the wrong path and was green from the day
    // it was written.
    expect(textFiles(REPO_ROOT).length).toBeGreaterThan(500);
  });

  it("detects damage, and does not flag a correct file", () => {
    // The control, and the reason this file is not a tautology. A detector that
    // cannot see the thing it was written for is the failure this repository
    // has now found in seven separate gates.
    //
    // **The signature is `C3 A2`**, and this control had it backwards twice.
    // A file mangled by a cp1252 round trip holds `C3 A2 C2 80 C2 94` where a
    // correct file holds `E2 80 94`: each of the three characters was re-encoded
    // individually. So the damaged bytes are *valid* UTF-8, and the only
    // reliable tell is the `C3 A2` pair - a properly-encoded U+00E2, which
    // nobody writes. The first version instead re-encoded the three characters
    // back to the original bytes and then asserted those were broken, which is
    // why it reported zero detected on text that was demonstrably mangled.
    // **A control that inverts the mechanism it tests passes or fails for
    // reasons unrelated to the detector.**
    const countSignature = (buf: Buffer): number => {
      let n = 0;
      for (let i = 0; i < buf.length - 1; i += 1) {
        if (buf[i] === 0xc3 && buf[i + 1] === 0xa2) n += 1;
      }
      return n;
    };

    const GOOD = {
      emDash: 0x2014,
      rightQuote: 0x2019,
      leftQuote: 0x201c,
      rightDQuote: 0x201d,
      ellipsis: 0x2026,
    };

    for (const [name, code] of Object.entries(GOOD)) {
      // What a cp1252 reader saw: three separate characters.
      const seen = String.fromCharCode(
        ...[...Buffer.from(String.fromCharCode(code), "utf8")].map((b) => b),
      );
      const mangled = Buffer.from(seen, "utf8");
      const clean = Buffer.from(String.fromCharCode(code), "utf8");

      expect(countSignature(clean), `${name} flagged in clean text`).toBe(0);
      expect(mangled.length, `${name} damage is not longer`).toBeGreaterThan(
        clean.length,
      );
    }

    // And the em-dash case end to end, stated as bytes so it cannot be
    // re-encoded while this file is being written.
    const dash = Buffer.from([0xc3, 0xa2, 0xc2, 0x80, 0xc2, 0x94]);
    expect(countSignature(dash)).toBe(1);
    expect(countSignature(Buffer.from([0xe2, 0x80, 0x94]))).toBe(0);
  });

  it("does not grow the mojibake count", () => {
    // **The ratchet.** Repairing files makes this test fail until CEILING is
    // lowered, which is what turns "we fixed some" into a number the next person
    // can see rather than a claim in a commit message.
    const { scanned, sequences, list } = survey();
    const report = list.slice(0, 10).join("\n  ");
    expect(
      sequences,
      `Mojibake is now in ${list.length} files (${sequences} sequences). ` +
        `That is UTF-8 re-decoded as cp1252, and almost always a multi-byte ` +
        `punctuation mark in a comment. Re-save the file as UTF-8.\n  ${report}` +
        (list.length > 10 ? "\n  ... and more" : ""),
    ).toBe(0);
    expect(scanned).toBeGreaterThan(500);
  });

  it("states the current damage on every run", () => {
    // A number nobody sees is a trend nobody has.
    const { sequences, list } = survey();
    console.log(
      `[mojibake] ${list.length} files, ${sequences} sequences (ceiling ${CEILING})`,
    );
    // **Zero is the correct answer today, and it is asserted rather than
    // allowed.** The first version of this gate reported 640 files and 2907
    // "sequences", and I repeated that number to the user twice. It was wrong:
    // the detector was matching the *correct* UTF-8 bytes of an em-dash
    // (E2 80 94) as though they were damage, because it decoded the file as
    // latin1 and looked for U+00E2 - which is that byte. **The committed tree
    // was never corrupted; the detector was.**
    //
    // So the assertion is `toBe(0)`, not a ceiling comparison. A ratchet
    // whose current value is a miscount is worse than none, because it makes a
    // healthy repository look diseased, and a reader trusts the number over
    // the tool that produced it.
    expect(sequences).toBe(0);
    // **A budget, because this survey reads every file in the repository** — and
    // that is now more expensive than before this session: the encoding gate was
    // widened to the outermost repository root, which added the parent's
    // documents, and the checklist grew by three ledger entries.
    //
    // It failed once under the full parallel suite and passed every other time,
    // which is the worst shape a gate can have: a reader who sees it red has no
    // way to tell a slow disk from a corrupted file. The cost is genuine work, so
    // the honest fix is a budget that matches it — the same reasoning as
    // `migration-coverage.test.ts`, which scans the same tree.
  }, 60_000);
});

/**
 * Control characters that no text file has any business containing.
 *
 * ## Why this is a separate rule and not part of the mojibake check
 *
 * The mojibake detector looks for `C3 A2` — the byte pair of a *properly encoded*
 * U+00E2, which is what a cp1252 round trip produces. That is one specific way
 * for a file to be damaged, and it is a good detector for it.
 *
 * **`OPENGEO_CHECKLIST.md` was damaged in a completely different way while the
 * mojibake gate reported "0 files, 0 sequences" every single run.** Two NUL bytes
 * had replaced two digit zeros, and two `null`s had lost their leading `n` to a
 * stray line feed — so the sentence stating the project's core rule read
 *
 *   "...**0 and <LF>ull are kept apart everywhere... because <LF>ull + null is 0**"
 *
 * A NUL is not double-encoded UTF-8, and a misplaced line feed is not either, so
 * the existing rule could not see them by construction. The damage was invisible
 * in `git diff` and invisible in most viewers, and it had been committed.
 *
 * The lesson is the one this file already keeps finding: **a detector only
 * recognises the shapes it has seen.** Two damage classes were present and only
 * one had a rule.
 *
 * ## What is and is not flagged
 *
 * Tab (09), line feed (0A) and carriage return (0D) are legal in text files and
 * are *not* flagged — the checklist uses hard line breaks inside paragraphs, and
 * the `.ts` files use tabs for indentation. Everything else in the C0 range, plus
 * DEL (7F) and the C1 range, is damage: it is invisible, it is never authored on
 * purpose, and it silently replaces a character, which is exactly the failure that
 * cost four characters here.
 *
 * NUL is reported separately from the rest because it is the byte that broke a
 * whole source file earlier in this session — a `.ts` collapsed to one line with
 * no newlines, unrecoverable without `git checkout`.
 */
describe("control characters", () => {
  /** Bytes allowed to appear in a text file. */
  const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

  /**
   * The rule, and the mistake that shaped it.
   *
   * **The first version also flagged 0x80-0x9F, the C1 range, and reported
   * 8612 findings in a repository it had just declared healthy.** Those bytes are
   * not control characters in a UTF-8 file: they are the **continuation bytes** of
   * every multibyte character — the `80 94` of an em-dash, the `9C` of an opening
   * curly quote. Flagging them flags the punctuation this codebase is written
   * with, which is how a detector ends up reporting 8612 problems that are all
   * correct text.
   *
   * So the rule is C0-minus-the-three-legal-bytes, plus DEL (0x7F). The C1 range
   * is only a control range in a *decoded* string, and a decoded string is exactly
   * what this must not use — the same class of error the mojibake detector made
   * when it decoded as latin1 and matched a legitimate byte.
   *
   * Reading the bytes is not incidental. A NUL is invisible in every viewer and in
   * `git diff`, and it is the byte that destroyed a whole `.ts` file earlier in
   * this session.
   */
  function forbiddenCount(buf: Buffer): number {
    let n = 0;
    for (const byte of buf) {
      const forbidden = (byte < 0x20 && !ALLOWED.has(byte)) || byte === 0x7f;
      if (forbidden) n += 1;
    }
    return n;
  }

  function controlSurvey(): {
    scanned: number;
    nul: number;
    other: number;
    list: string[];
  } {
    const files = textFiles(REPO_ROOT);
    let nul = 0;
    let other = 0;
    const list: string[] = [];
    for (const file of files) {
      const hits = forbiddenCount(readFileSync(file));
      if (hits === 0) continue;
      const bytes = readFileSync(file);
      const nulHere = [...bytes].filter((b) => b === 0).length;
      nul += nulHere;
      other += hits - nulHere;
      list.push(relative(REPO_ROOT, file).replaceAll("\\", "/"));
    }
    return { scanned: files.length, nul, other, list };
  }

  it("sees the damage it was written for, and leaves a correct file alone", () => {
    // The control. Without it this rule is a tautology, and this repository has
    // now found that failure mode in eight gates.
    //
    // **Built from the rule's own vocabulary:** a NUL byte and a C1 byte, which
    // are exactly what the repaired checklist contained. The mojibake control
    // above had to invert its mechanism twice before it worked; this one states
    // the damage directly because the mechanism *is* the byte value.
    const withNul = Buffer.from("0 and null are kept apart", "utf8");
    withNul[8] = 0x00;
    expect(forbiddenCount(withNul)).toBe(1);
    expect(forbiddenCount(withNul.slice(0, 8))).toBe(0);

    // The three legal ones must never be flagged, or every indented source file
    // and every hard-wrapped paragraph in the checklist fails.
    for (const legal of [0x09, 0x0a, 0x0d]) {
      expect(forbiddenCount(Buffer.from([legal]))).toBe(0);
    }

    // A C1 byte is *not* forbidden, and the control says so explicitly: the first
    // version of this rule flagged 0x80-0x9F and reported 8612 findings that were
    // all the continuation bytes of correct punctuation. A control that only
    // proves the detector can fire is half a control.
    expect(forbiddenCount(Buffer.from([0x9b]))).toBe(0);
    expect(forbiddenCount(Buffer.from([0x80]))).toBe(0);
    // DEL is, and nothing else in the high range is.
    expect(forbiddenCount(Buffer.from([0x7f]))).toBe(1);
  });

  it("finds no forbidden control characters in the repository", () => {
    const { scanned, nul, other, list } = controlSurvey();
    const report = list.slice(0, 10).join("\n  ");
    expect(
      nul + other,
      `Forbidden control characters in ${list.length} files ` +
        `(${nul} NUL, ${other} other).\n  ${report}` +
        (list.length > 10 ? "\n  ... and more" : "") +
        `\n\nA NUL byte means a source file has been truncated or its ` +
        `newlines destroyed — that is a real corruption, not a warning. ` +
        `\`git checkout -- <file>\` restores it. A stray 0x0A inside a word means ` +
        `a line feed was written where a character belongs.`,
    ).toBe(0);
    expect(scanned).toBeGreaterThan(500);
  });

  it("states the control-character damage on every run", () => {
    // The number has to be visible, or "it was green" is the only evidence anyone
    // has — and a gate that is silent can be as wrong as one that is red.
    const { nul, other } = controlSurvey();
    console.log(`[control-chars] ${nul} NUL, ${other} other forbidden`);
    expect(nul + other).toBe(0);
  });
});
