import { describe, expect, it } from "vitest";
import { auditLlmsTxt } from "./llmsTxtAudit";

/**
 * The `llms.txt` check.
 *
 * The property worth defending throughout: **this reports named, checkable
 * defects rather than a score.** An earlier draft scored the file out of 10 and
 * called 7 "comprehensive" — a claim with no definition behind it and no action
 * attached. The tests below assert the *absence* of a score for that reason, and
 * the fixtures are the shapes that actually appear in the wild, including the
 * relative-link case that fails silently in production.
 */

const GOOD = [
  "# Acme",
  "",
  "> Acme builds scheduling software for clinics.",
  "",
  "## Start here",
  "",
  "- [Homepage](https://acme.com/): What we do.",
  "- [Docs](https://acme.com/docs): Getting started.",
].join("\n");

const ORIGIN = "https://acme.com";

describe("auditLlmsTxt", () => {
  it("reports a missing file as a finding, not an empty pass", () => {
    // "We found nothing" and "we found nothing wrong" are different, and only the
    // second is safe to infer.
    const report = auditLlmsTxt(null, ORIGIN);
    expect(report.fetched).toBe(false);
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(["missing"]);
    expect(report.issues[0]?.fix).toMatch(/rel=/i);
    expect(report.summary).toMatch(/fall back to fetching your homepage/i);
  });

  it("passes a well-formed file", () => {
    const report = auditLlmsTxt(GOOD, ORIGIN);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.linkCount).toBe(2);
  });

  it("requires a title", () => {
    const report = auditLlmsTxt("- [Home](https://acme.com/): x", ORIGIN);
    expect(report.issues.map((i) => i.code)).toContain("no_title");
    expect(report.summary).toMatch(/named fix rather than a score/i);
  });

  it("requires at least one link, because prose alone is not an outline", () => {
    const report = auditLlmsTxt("# Acme\n\n> We build things.", ORIGIN);
    expect(report.issues.map((i) => i.code)).toContain("no_links");
  });

  it("catches relative links, which fail silently in production", () => {
    // The shape that looks correct and does nothing: the agent resolves
    // `/docs` against whatever base it assumed, reads a different page, and
    // reports it confidently.
    const report = auditLlmsTxt(
      "# Acme\n\n- [Home](/): x\n- [Docs](/docs): y",
      ORIGIN,
    );
    const issue = report.issues.find((i) => i.code === "relative_links");
    expect(issue).toBeDefined();
    expect(issue?.problem).toMatch(/2 of 2 links are relative/i);
    expect(issue?.fix).toMatch(/absolute URLs/i);
  });

  it("reports a mix of relative and absolute links honestly", () => {
    // Two plural axes: the noun follows the total ("1 of 2 **links**") and the
    // verb follows the count being reported ("**is**", because one is relative).
    // Asserted literally, because this sentence was wrong on both axes at
    // different points during the session and the test is what caught it.
    const report = auditLlmsTxt(
      "# Acme\n\n- [Home](https://acme.com/): x\n- [Docs](/docs): y",
      ORIGIN,
    );
    expect(report.issues[0]?.problem).toMatch(/1 of 2 links is relative/i);
  });

  it("pluralises the verb when several links are relative", () => {
    const report = auditLlmsTxt(
      "# Acme\n\n- [Home](/): x\n- [Docs](/docs): y",
      ORIGIN,
    );
    expect(report.issues[0]?.problem).toMatch(/2 of 2 links are relative/i);
  });

  it("offers a copy-pasteable example for every issue", () => {
    // A fix a customer cannot paste is a note, and a note gets ignored. The one
    // exception is the missing file, where the example *is* the fix.
    for (const body of [
      null,
      "- [Home](https://a.com/): x",
      "# Acme\n\n> prose only",
      "# Acme\n\n- [Home](/): x",
    ]) {
      for (const issue of auditLlmsTxt(body, ORIGIN).issues) {
        expect(issue.problem.length).toBeGreaterThan(30);
        if (issue.fix !== null) expect(issue.example).not.toBeNull();
      }
    }
  });

  it("names each issue with a code, so a report is actionable not just readable", () => {
    const report = auditLlmsTxt("# Acme\n\n- [Home](/): x", ORIGIN);
    for (const issue of report.issues) {
      expect(issue.code).toMatch(
        /^(missing|no_title|no_links|relative_links)$/,
      );
    }
  });

  it("offers no overall score, because a score is unfalsifiable", () => {
    // The property this file exists to hold. A number between 0 and 100 here
    // would be a claim with no definition behind it and nothing to act on.
    const report = auditLlmsTxt(GOOD, ORIGIN);
    for (const key of Object.keys(report)) {
      expect(key.toLowerCase()).not.toMatch(/^(score|grade|rating|points)$/);
    }
  });

  it("reports the byte length, which is the one budget fact agents respect", () => {
    const report = auditLlmsTxt(GOOD, ORIGIN);
    expect(report.byteLength).toBe(GOOD.length);
    expect(report.summary).toMatch(/bytes/i);
  });

  it("treats an empty file as failing, not as a minimal valid one", () => {
    const report = auditLlmsTxt("", ORIGIN);
    expect(report.fetched).toBe(true);
    expect(report.valid).toBe(false);
  });
});
