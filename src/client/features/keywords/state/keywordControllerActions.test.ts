import { describe, expect, it } from "vitest";
import { buildKeywordSearchKey } from "./keywordControllerActions";
import type {
  KeywordSource,
  ResultLimit,
} from "@/client/features/keywords/keywordResearchTypes";

/**
 * The search cache key.
 *
 * A cache key that collides does not throw. It returns **the previous search's
 * results for a different query**, which is the worst failure a search page can
 * have: the numbers are plausible, the reader has no way to tell, and nothing in
 * the product logs that a query was never sent.
 *
 * So the key is pinned here against the specific collision that happened, rather
 * than left to a reader to reason about.
 */
describe("buildKeywordSearchKey", () => {
  // The real types, not literals I invented: `ResultLimit` is 150 | 300 | 500 and
  // the mode is `auto` or a named source. The first version of this file used
  // `10` and `"phrase"`, which is how a test ends up asserting behaviour against
  // values the product can never produce.
  const LIMIT = 150 satisfies ResultLimit;
  const SOURCE = "google" as KeywordSource;
  const base = {
    locationCode: 2840,
    resultLimit: LIMIT,
    mode: "auto",
    clickstream: false,
  } as const;

  it("keeps a keyword containing the separator distinct from two keywords", () => {
    // **The collision.** `a|b` is one keyword; `a,b` is two. With both joins using
    // `|`, the first produced `a|b` and the second produced `a|b` — the same
    // string — so searching for the two-keyword list served the single-keyword
    // search's cached results.
    const oneKeywordWithPipe = buildKeywordSearchKey({
      ...base,
      keyword: "a|b",
    });
    const twoKeywords = buildKeywordSearchKey({
      ...base,
      keyword: "a,b",
    });

    expect(oneKeywordWithPipe).not.toBe(twoKeywords);
  });

  it("is stable for the same query, or nothing is ever cached", () => {
    // The other half: a key that changes for identical input defeats the cache
    // entirely, which is a performance bug rather than a correctness one — and it
    // is the reason the test above has to compare two *different* queries rather
    // than one twice.
    expect(buildKeywordSearchKey({ ...base, keyword: "a,b" })).toBe(
      buildKeywordSearchKey({ ...base, keyword: "a,b" }),
    );
    // And order is part of the query, so `a,b` and `b,a` must differ.
    expect(buildKeywordSearchKey({ ...base, keyword: "a,b" })).not.toBe(
      buildKeywordSearchKey({ ...base, keyword: "b,a" }),
    );
  });

  it("separates every field, so no two field sets collide", () => {
    // The outer join has to separate its fields too, or a location and a limit
    // that happen to read alike would share a key.
    const a = buildKeywordSearchKey({ ...base, keyword: "x" });
    const b = buildKeywordSearchKey({
      ...base,
      keyword: "x",
      locationCode: 2826,
    });
    const c = buildKeywordSearchKey({ ...base, keyword: "x", clickstream: true });
    const d = buildKeywordSearchKey({ ...base, keyword: "x", mode: SOURCE });

    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("puts the separator in the value and not in the source", () => {
    // The separator is written as an escape precisely so the control-character
    // audit reads zero forbidden bytes in the repository. This does not check the
    // file — `scripts/prepublish-audit.test.ts` does that — it records *why* the
    // escape is there, so a later "tidy this into a literal" does not reintroduce
    // a raw control byte into the source.
    const key = buildKeywordSearchKey({ ...base, keyword: "a,b" });
    // The value legitimately carries the separator: that is the whole mechanism,
    // and the tests above show it keeps `a|b` and `a,b` apart. What must *not*
    // appear is a line break or any other control character, because those would
    // survive a round trip through a URL or a log line and re-split the key.
    expect(key).toContain("\u0001");
    expect(/[\r\n\t]/.test(key)).toBe(false);
    // eslint-disable-next-line no-control-regex
    const others = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    // The only control byte allowed in the value is U+0001 itself.
    const withoutSeparator = key.split("\u0001").join("");
    expect(others.test(withoutSeparator)).toBe(false);
  });
});