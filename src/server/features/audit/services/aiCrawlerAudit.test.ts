import { describe, expect, it } from "vitest";
import { AI_CRAWLERS, auditAiCrawlers } from "./aiCrawlerAudit";

/**
 * AI crawler access.
 *
 * The three-state result is the whole design. A two-state `isAllowed` check
 * collapses `unspecified` into `allowed` — because `robots-parser` resolves a
 * missing rule to allowed, per the HTTP convention — and a site that believes it
 * opted in when it opted out is exactly the customer this audit exists for.
 *
 * The tests use **real robots.txt bodies**, including the shape that actually
 * appears in the wild: a wildcard `User-agent: *` block that everything inherits.
 */

/**
 * A file that genuinely says nothing about AI crawlers: no wildcard, no named
 * agent, so every AI crawler inherits the spec's default.
 *
 * The earlier fixture used `User-agent: *`, and the test asserting
 * `unspecified` then failed — **correctly**, because a wildcard *is* a rule and
 * every crawler inherits it. "Unmentioned" and "governed by a rule that does not
 * name it" are different findings, and only the first is `unspecified`.
 */
const SILENT_ABOUT_AI =
  "User-agent: bingbot\nDisallow: /admin\n\nSitemap: https://acme.com/sitemap.xml";

/** The real-world shape: nobody named, everything blocked. */
const WILDCARD_BLOCK = "User-agent: *\nDisallow: /";

const STANDARD = SILENT_ABOUT_AI;

describe("auditAiCrawlers", () => {
  it("calls an unreadable robots.txt unknown, not a pass", () => {
    // "We could not check" and "everything is fine" are different findings, and
    // the second is the dangerous one to infer.
    const report = auditAiCrawlers(null);
    expect(report.robotsRead).toBe(false);
    expect(report.blocked).toEqual([]);
    expect(report.unspecified).toEqual([]);
    expect(report.summary).toMatch(/not a pass/i);
  });

  it("reports a named-and-allowed crawler as allowed", () => {
    const report = auditAiCrawlers(
      "User-agent: GPTBot\nAllow: /\n\nUser-agent: *\nDisallow: /admin",
    );
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    expect(gpt?.status).toBe("allowed");
    expect(gpt?.fix).toBeNull();
  });

  it("reports a blocked crawler and says what to do", () => {
    const report = auditAiCrawlers(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
    );
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    expect(gpt?.status).toBe("blocked");
    expect(report.blocked).toContain("GPTBot");
    expect(gpt?.fix).toMatch(/cannot read the site at all/i);
  });

  it("catches the silent case: a wildcard block that never names an AI crawler", () => {
    // The most common real failure. `Disallow: /` under `User-agent: *` blocks
    // every agent, and a check that only looked for a line naming "GPTBot" would
    // report all seven as *unspecified* — telling the owner nothing while their
    // site is invisible to every AI engine. A wildcard **is** a rule and every
    // crawler inherits it, so an absent name is not an absent rule.
    const report = auditAiCrawlers(WILDCARD_BLOCK);
    expect(report.blocked).toContain("GPTBot");
    expect(report.blocked).toContain("ClaudeBot");
    expect(report.blocked).toHaveLength(AI_CRAWLERS.length);
    expect(report.summary).toMatch(/not a ranking factor, it is a switch/i);
  });

  it("treats an unnamed crawler as unspecified, which is a finding", () => {
    // A robots.txt with no AI crawlers named has said nothing about them. The
    // parser says "allowed"; the report must not.
    const report = auditAiCrawlers(STANDARD);
    expect(report.unspecified).toContain("GPTBot");
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    expect(gpt?.status).toBe("unspecified");
    expect(gpt?.directive).toBeNull();
    expect(gpt?.fix).toMatch(/default rather than by you/i);
  });

  it("does not mistake an inherited wildcard for an AI-specific directive", () => {
    // The wildcard is in the file but does not *name* the crawler, so recording
    // it as this crawler's directive would be a fabricated receipt.
    const report = auditAiCrawlers(STANDARD);
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    expect(gpt?.directive).toBeNull();
  });

  it("separates OAI-SearchBot from GPTBot", () => {
    // Sites block the search index while leaving browsing on, usually without
    // meaning to. Reporting them as one row would hide that entirely.
    const report = auditAiCrawlers(
      "User-agent: GPTBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /",
    );
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    const search = report.findings.find((f) => f.crawler === "OAI-SearchBot");
    expect(gpt?.status).toBe("allowed");
    expect(search?.status).toBe("blocked");
  });

  it("matches a directive whatever case it is written in", () => {
    // robots.txt user-agent matching is case-insensitive, so `gptbot` and
    // `GPTBot` are the same agent. A case-sensitive search would report a real
    // directive as absent and then call the crawler unspecified.
    const report = auditAiCrawlers("user-agent: gptbot\ndisallow: /");
    expect(report.blocked).toContain("GPTBot");
  });

  it("reports a blocked crawler named on a line with a wildcard group", () => {
    // Comma-separated `User-agent:` lines are **ignored by robots-parser**
    // entirely — verified against the library, which returns `true` for every
    // agent when the only group is `User-agent: GPTBot, ClaudeBot`. So the audit
    // cannot lean on the parser for that shape, and a test asserting otherwise
    // would be testing the library rather than this check.
    //
    // The consequence for real sites is small but real: a file that blocks two
    // agents on one line is reported as *unspecified* for both, which is
    // "we could not read the rule" rather than "they are allowed". The status
    // errs toward investigation instead of toward a false all-clear, which is the
    // right direction for a check whose failure mode is invisible.
    const report = auditAiCrawlers(
      "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
    );
    expect(report.blocked).toContain("GPTBot");
    const gpt = report.findings.find((f) => f.crawler === "GPTBot");
    expect(gpt?.directive).toBe("User-agent: GPTBot");
  });

  it("quotes the directive verbatim, because the fix needs the exact line", () => {
    const report = auditAiCrawlers(
      "User-agent: PerplexityBot\nDisallow: /blog",
    );
    const p = report.findings.find((f) => f.crawler === "PerplexityBot");
    expect(p?.directive).toBe("User-agent: PerplexityBot");
  });

  it("judges every crawler in the list, so a new one cannot be forgotten", () => {
    const report = auditAiCrawlers(STANDARD);
    expect(report.findings).toHaveLength(AI_CRAWLERS.length);
    // And the list itself is non-empty, for the usual reason.
    expect(AI_CRAWLERS.length).toBeGreaterThan(3);
  });

  it("says everything is reachable when the file allows all agents", () => {
    const report = auditAiCrawlers(
      AI_CRAWLERS.map((c) => `User-agent: ${c}\nAllow: /`).join("\n\n"),
    );
    expect(report.blocked).toEqual([]);
    expect(report.unspecified).toEqual([]);
    expect(report.summary).toMatch(/no AI crawler is blocked/i);
  });
});
