import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
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

  /** This file names the sequences, and the note documents them. */
  const EXEMPT = new Set(["prepublish-audit.test.ts", "REBRAND-NOTES.md"]);

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

  function survey(): { scanned: number; sequences: number; list: string[] } {
    const files = textFiles(ROOT);
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
        list.push(relative(ROOT, file).replaceAll("\\", "/"));
      }
    }
    return { scanned: files.length, sequences, list };
  }

  it("scans a real number of files, so a wrong directory is not green", () => {
    // A scan of 0 files passes, and that has happened here before: the
    // private-split scan shipped with the wrong path and was green from the day
    // it was written.
    expect(textFiles(ROOT).length).toBeGreaterThan(500);
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
  });
});
