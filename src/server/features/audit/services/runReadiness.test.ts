import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/audit/discovery", () => ({
  fetchLlmsTxt: vi.fn(),
  fetchRobotsTxtText: vi.fn(),
}));

import { fetchLlmsTxt, fetchRobotsTxtText } from "@/server/lib/audit/discovery";
import { runReadiness } from "./runReadiness";

/**
 * The seam's job is not the report — `runAudit` has 19 tests for that. Its job is
 * **what it does with an input it could not get**, so these tests are about the
 * gaps and not about the findings.
 */

const robotsMock = vi.mocked(fetchRobotsTxtText);
const llmsMock = vi.mocked(fetchLlmsTxt);

const ORIGIN = "https://acme.com";

const ROBOTS_ALLOWING = "User-agent: GPTBot\nAllow: /\n";

beforeEach(() => {
  robotsMock.mockReset();
  llmsMock.mockReset();
  robotsMock.mockResolvedValue(ROBOTS_ALLOWING);
  llmsMock.mockResolvedValue("# Acme\n\n- [Docs](https://acme.com/docs)\n");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runReadiness", () => {
  it("passes the origin through so relative llms.txt links resolve", async () => {
    const result = await runReadiness({ origin: ORIGIN, pages: [] });

    expect(robotsMock).toHaveBeenCalledWith(ORIGIN);
    expect(llmsMock).toHaveBeenCalledWith(ORIGIN);
    expect(result.fixes.length).toBeGreaterThan(0);
  });

  it("reads a site with no llms.txt without treating it as our failure", async () => {
    // The two are different facts about different problems: a site that does not
    // publish one is a *finding*, and reporting it as "we could not check" would
    // soften a fixable problem into a gap in our coverage.
    llmsMock.mockResolvedValue(null);

    const result = await runReadiness({ origin: ORIGIN, pages: [] });

    const note = result.notes.find((entry) => entry.what === "/llms.txt");
    expect(note?.because).toContain("does not publish one");
  });

  it("records a fetch that threw as a gap, and still reports the rest", async () => {
    // One source failing must not discard the other — every check here is
    // independent of the others, and a report with fewer findings beats no report.
    robotsMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runReadiness({ origin: ORIGIN, pages: [] });

    const note = result.notes.find((entry) => entry.what === "robots.txt");
    expect(note?.because).toContain("could not read it");
    // The llms.txt check still ran and still contributed.
    expect(llmsMock).toHaveBeenCalled();
    expect(result.coverage.some((line) => line.includes("llms.txt"))).toBe(
      true,
    );
  });

  it("strips newlines from an upstream error before it reaches the report", async () => {
    // **A control character can forge a second line in any rendered output**, and
    // this string is shown to a customer. A proxy returning an HTML error page
    // would otherwise put arbitrary text into the report.
    robotsMock.mockRejectedValue(
      new Error("upstream said\n\nERROR: forged line"),
    );

    const result = await runReadiness({ origin: ORIGIN, pages: [] });

    const note = result.notes.find((entry) => entry.what === "robots.txt");
    expect(note?.because).not.toMatch(/[\r\n]/);
    expect(note?.because).toContain("forged line");
  });

  it("truncates a very long upstream error", async () => {
    robotsMock.mockRejectedValue(new Error("x".repeat(500)));

    const result = await runReadiness({ origin: ORIGIN, pages: [] });

    const note = result.notes.find((entry) => entry.what === "robots.txt");
    expect((note?.because.length ?? 0) < 200).toBe(true);
  });

  it("says how many crawled pages it could not analyse", async () => {
    // **Three pages is not a site.** Presenting the analysed subset as the whole
    // structure is the difference between a finding and a sample, and the reader
    // has no other way to tell which they are looking at.
    const result = await runReadiness({
      origin: ORIGIN,
      pagesAttempted: 50,
      pages: [
        {
          url: `${ORIGIN}/a`,
          headings: [{ title: "A", level: 1 }],
          schemaTypes: ["Article"],
          citationsObserved: 1,
          answersObserved: 2,
          competingPagesCited: 3,
        },
      ],
    });

    const note = result.notes.find((entry) => entry.what.includes("49 of 50"));
    expect(note).toBeDefined();
    expect(note?.because).toContain("nothing is known about their structure");
  });

  it("does not claim missing pages when every page was analysed", async () => {
    // The counterpart: a note that fires unconditionally trains readers to ignore
    // it, and this one would be wrong on the common case of a clean crawl.
    const result = await runReadiness({
      origin: ORIGIN,
      pagesAttempted: 1,
      pages: [
        {
          url: `${ORIGIN}/a`,
          headings: [{ title: "A", level: 1 }],
          schemaTypes: ["Article"],
          citationsObserved: 1,
          answersObserved: 2,
          competingPagesCited: 3,
        },
      ],
    });

    expect(
      result.notes.some((entry) => /\d+ of \d+ crawled pages/.test(entry.what)),
    ).toBe(false);
  });

  it("passes heading text and schema types through to the report", async () => {
    // The seam's whole reason for existing: data the crawl already captured and
    // the rubric needs. If this stops flowing, the report silently scores less.
    const result = await runReadiness({
      origin: ORIGIN,
      pages: [
        {
          url: `${ORIGIN}/guide`,
          headings: [
            { title: "What is GEO?", level: 1 },
            { title: "How does it work?", level: 2 },
          ],
          schemaTypes: ["Article"],
          citationsObserved: 4,
          answersObserved: 6,
          competingPagesCited: 12,
        },
      ],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.coverage).toBeCloseTo(1, 5);
  });

  it("leaves a page the crawl could not parse as mostly unmeasured", async () => {
    // `null` headings means the parse did not run. Forwarding an empty array
    // instead would tell the rubric "this page has no headings", which is a
    // finding, and it is one we did not earn.
    //
    // **Coverage is 0.12, not 0**, because `crawlable` is a site-wide factor and
    // robots.txt allows GPTBot in this fixture. So the page is still scored on the
    // one thing we do know — the whole point of the distinction, since a hard 0
    // would have thrown away a true measurement along with the unknown ones.
    const result = await runReadiness({
      origin: ORIGIN,
      pages: [
        {
          url: `${ORIGIN}/broken`,
          headings: null,
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        },
      ],
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.coverage).toBeCloseTo(0.12, 5);
  });

  it("drops a page entirely when nothing at all is known about it", async () => {
    // robots.txt unreadable too, so even the site-wide factor is unknown. Nothing
    // is measurable, and the report says nothing rather than showing a score it
    // cannot justify.
    robotsMock.mockResolvedValue(null);

    const result = await runReadiness({
      origin: ORIGIN,
      pages: [
        {
          url: `${ORIGIN}/broken`,
          headings: null,
          schemaTypes: null,
          citationsObserved: null,
          answersObserved: null,
          competingPagesCited: null,
        },
      ],
    });

    expect(result.pages).toEqual([]);
  });
});
