import { describe, expect, it } from "vitest";
import {
  countTerms,
  findStuffedTerms,
  STUFFING_MIN_DENSITY,
  STUFFING_MIN_OCCURRENCES,
} from "@/server/lib/audit/keyword-density";

/**
 * A page whose body is one repeated term plus filler, at a chosen density.
 *
 * The filler words are **all distinct** on purpose. A single repeated filler ("lorem")
 * is itself a countable term, so it becomes the densest thing on the page and the
 * fixture reports it instead of the term under test. Distinct fillers each count once
 * and never clear the floor.
 */
function pageWith(
  term: string,
  uses: number,
  filler: number,
  prefix = term,
): string {
  // Prefixed with the term, so two calls concatenated in one test do not share filler
  // names. Shared names would each count twice and quietly move every density.
  const fillers = Array.from(
    { length: filler },
    (_, index) => `${prefix}filler${index}`,
  );
  return [...Array<string>(uses).fill(term), ...fillers].join(" ");
}

describe("countTerms", () => {
  it("lowercases, and drops stop words and very short tokens", () => {
    const counts = countTerms(
      "The Plumber and the plumber, a plumber in OF it",
    );
    expect(counts.get("plumber")).toBe(3);
    // "the", "and", "in", "of", "it", "a" are all filtered, so the map holds one key.
    expect([...counts.keys()]).toEqual(["plumber"]);
  });

  it("keeps contractions and hyphenated words as single terms", () => {
    const counts = countTerms("don't don't e-commerce e-commerce");
    expect(counts.get("don't")).toBe(2);
    expect(counts.get("e-commerce")).toBe(2);
  });
});

describe("findStuffedTerms", () => {
  it("reports a term past both floors, with its density", () => {
    // 10 uses in 50 counted words is 20%, well past both thresholds.
    const terms = findStuffedTerms(pageWith("plumber", 10, 40));
    expect(terms).toHaveLength(1);
    expect(terms[0]?.term).toBe("plumber");
    expect(terms[0]?.count).toBe(10);
    expect(terms[0]?.density).toBeCloseTo(0.2, 5);
  });

  it("needs the count as well as the density, so a short page cannot be stuffed", () => {
    // 3 uses in 4 words is 75% density, and still ordinary prose: the floor is what
    // stops a one-sentence page being reported as deliberate repetition.
    const shortPage = pageWith("plumber", 3, 1);
    expect(findStuffedTerms(shortPage)).toEqual([]);
    // The same page passes once the uses clear the floor, so the floor is the only
    // thing that was holding it back.
    expect(
      findStuffedTerms(pageWith("plumber", STUFFING_MIN_OCCURRENCES, 1)),
    ).toHaveLength(1);
  });

  it("needs the density as well as the count, so a long guide is not flagged", () => {
    // 10 uses across 5,000 words is 0.2%: a term used ten times in a long article is
    // ordinary English, and this is the case that makes a naive counter useless.
    expect(findStuffedTerms(pageWith("plumber", 10, 4990))).toEqual([]);
  });

  it("measures density over the words it counts, not over every token", () => {
    // The same 10 uses, with 40 stop words padding the page. If density were computed
    // over every token the term would read 20%; over counted words it reads 20% too,
    // because the padding is filtered from *both* sides. That is the point: the ratio
    // must not move because a page carries more navigation text.
    const padded = `${pageWith("plumber", 10, 40)} ${Array<string>(200).fill("the").join(" ")}`;
    const terms = findStuffedTerms(padded);
    expect(terms[0]?.density).toBeCloseTo(0.2, 5);
  });

  it("returns nothing for text with no countable terms", () => {
    // No division by zero, and no finding on an empty body.
    expect(findStuffedTerms("")).toEqual([]);
    expect(findStuffedTerms("the and of it")).toEqual([]);
  });

  it("ranks the strongest term first, breaks ties alphabetically, and caps the list", () => {
    // `mango` carries the largest share, so it leads. `apple` and `zebra` are tied, and
    // the alphabetical fallback decides between them. The cap keeps the report readable.
    // A stable order matters here because the issue row is written from this list.
    //
    // Note what is *not* being tested: within one page every term shares a denominator,
    // so density and raw count rank identically. Density earns its place in the filter,
    // which the two floors above cover.
    const text = `${pageWith("zebra", 8, 7)} ${pageWith("apple", 8, 7)} ${pageWith("mango", 16, 1)}`;
    const terms = findStuffedTerms(text, { max: 2 });
    expect(terms.map((term) => term.term)).toEqual(["mango", "apple"]);
  });

  it("honours an explicit threshold, so a caller can widen it", () => {
    const page = pageWith("plumber", 5, 45);
    expect(findStuffedTerms(page)).toEqual([]);
    expect(findStuffedTerms(page, { minOccurrences: 5 })[0]?.term).toBe(
      "plumber",
    );
  });
});

describe("the thresholds themselves", () => {
  it("stays conservative, and says so in one place", () => {
    // A gate on the numbers rather than the behaviour: raising them to where ordinary
    // pages get flagged would pass every case above while making the report useless.
    expect(STUFFING_MIN_DENSITY).toBeGreaterThanOrEqual(0.04);
    expect(STUFFING_MIN_DENSITY).toBeLessThanOrEqual(0.1);
    expect(STUFFING_MIN_OCCURRENCES).toBeGreaterThanOrEqual(5);
    expect(STUFFING_MIN_OCCURRENCES).toBeLessThanOrEqual(20);
  });
});
