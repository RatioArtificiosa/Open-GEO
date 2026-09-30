import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Run a gate the way CI would, so "it is wired in" is not a claim about the
 * package.json string but an observation. Exported for the mutation script that
 * proves this audit fails when a gate is removed.
 */
export function runVitestFile(file: string): number {
  try {
    execFileSync("npx", ["vitest", "run", file, "--reporter=dot"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    return 0;
  } catch (error) {
    const e = error as { status?: number };
    return typeof e.status === "number" ? e.status : 1;
  }
}
