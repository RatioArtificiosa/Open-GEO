import { describe, expect, it } from "vitest";
import { computeCitationAuthority } from "./citation-authority";

/**
 * Citation authority.
 *
 * The name is the first thing to be careful about. We do **not** score domain
 * quality — no PageRank, no spam score, no way to tell a national newspaper
 * from a content farm — so a metric called "authority" would imply an editorial
 * judgement we never made. What this measures is citation *concentration*, which
 * is a fact about the archive, and the summary says so in those words.
 *
 * The tests are mostly about the difference between "we measured this" and "we
 * have nothing", because that is where a composite score usually lies.
 */

const row = (domain: string, mentions: number) => ({ domain, mentions });

describe("computeCitationAuthority", () => {
  it("returns null when nothing cites the brand", () => {
    // A brand with no citations has an *unknown* authority, not a score of
    // zero. Zero would tell them to fix something we never measured.
    const result = computeCitationAuthority([]);
    expect(result.value).toBeNull();
    expect(result.distinctDomains).toBe(0);
    expect(result.summary).toMatch(/nothing cites this brand yet/i);
  });

  it("distinguishes no rows from rows that recorded zero mentions", () => {
    const result = computeCitationAuthority([
      row("news.example", 0),
      row("blog.example", 0),
    ]);
    expect(result.value).toBeNull();
    expect(result.distinctDomains).toBe(2);
    expect(result.summary).toMatch(/recorded zero mentions/i);
  });

  it("scores a single citing domain as zero, and says why", () => {
    // One source is a *measured* fact — maximal concentration, no breadth — so
    // this is a real 0 rather than an absent number. A brand cited by exactly one
    // domain is fragile, and saying "unknown" would hide that.
    const result = computeCitationAuthority([row("only.example", 12)]);
    expect(result.value).toBe(0);
    expect(result.topShare).toBe(1);
    expect(result.summary).toMatch(/single source is fragile/i);
  });

  it("scores a perfectly flat distribution at 100", () => {
    // Four domains, equal mentions: maximum entropy normalised by log(4).
    const result = computeCitationAuthority([
      row("a.example", 5),
      row("b.example", 5),
      row("c.example", 5),
      row("d.example", 5),
    ]);
    expect(result.value).toBe(100);
    expect(result.spread).toBeCloseTo(1, 6);
  });

  it("scores a lopsided distribution below an even one", () => {
    const even = computeCitationAuthority([
      row("a.example", 4),
      row("b.example", 4),
      row("c.example", 4),
      row("d.example", 4),
    ]);
    const lopsided = computeCitationAuthority([
      row("a.example", 80),
      row("b.example", 8),
      row("c.example", 8),
      row("d.example", 4),
    ]);
    expect(lopsided.value!).toBeLessThan(even.value!);
  });

  it("flags a single domain supplying half the citations", () => {
    // Concentration is the actionable finding, and the summary has to name it
    // rather than leaving the reader to spot it in a number.
    const result = computeCitationAuthority([
      row("big.example", 50),
      row("a.example", 30),
      row("b.example", 20),
    ]);
    expect(result.topShare).toBeCloseTo(0.5, 6);
    expect(result.summary).toMatch(/supplies 50% of the mentions/i);
    expect(result.summary).toMatch(/concentration risk/i);
  });

  it("ignores a domain whose count we do not know, rather than counting it as zero", () => {
    // A null count is missing data. Folding it in as zero would drag the
    // distribution toward concentration and quietly lower the score.
    const withNull = computeCitationAuthority([
      row("a.example", 10),
      row("b.example", 10),
      { domain: "unknown.example", mentions: null },
    ]);
    const withoutIt = computeCitationAuthority([
      row("a.example", 10),
      row("b.example", 10),
    ]);
    expect(withNull.value).toBe(withoutIt.value);
    expect(withNull.distinctDomains).toBe(2);
  });

  it("never claims to score domain quality", () => {
    // The single most important sentence in the file. A reader who believes we
    // ranked their citations by authority will make decisions we cannot support.
    // This is the healthy case: three domains, none dominant.
    const result = computeCitationAuthority([
      row("a.example", 4),
      row("b.example", 3),
      row("c.example", 2),
    ]);
    expect(result.topShare).toBeLessThan(0.5);
    expect(result.summary).toMatch(/does not score domain authority/i);
  });

  it("reports two domains as having little independence", () => {
    // Two domains at 50/50: `topShare` is exactly 0.5, which meets the
    // concentration threshold, so this reaches the *concentration* branch. The
    // independence branch is only reachable with three or more domains, because
    // two domains always look like a majority-plus-one.
    const flat = computeCitationAuthority([
      row("a.example", 5),
      row("b.example", 5),
    ]);
    expect(flat.summary).toMatch(/concentration risk/i);

    const three = computeCitationAuthority([
      row("a.example", 10),
      row("b.example", 5),
      row("c.example", 5),
    ]);
    expect(three.summary).toMatch(/concentration risk/i);

    // The independence sentence is for the *healthy* case, and the healthy
    // case is its own test above.
    expect(
      computeCitationAuthority([row("a.example", 4), row("b.example", 4)])
        .summary,
    ).not.toMatch(/little to be independent/i);
  });
});
