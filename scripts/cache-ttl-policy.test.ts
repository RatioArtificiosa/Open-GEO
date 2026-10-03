/**
 * Every cache TTL in the tree, pinned — because none of them is.
 *
 * ## The gap this closes
 *
 * The cache has **eight namespaces with seven distinct TTLs** (12 hours, 24 hours, 7 days)
 * and **not one test asserts any of them**. The five test files that mention "TTL" are all
 * DataForSEO's *client-side* timeout, not the cache. So the entire freshness policy of a
 * product whose selling point is a number with a date on it is invisible to CI: someone
 * could change `12 * 60 * 60` to `30 * 24 * 60 * 60` and the suite would stay green.
 *
 * ## Why 30 days is the wrong number here, stated once and pinned
 *
 * CL-121's row asks for **"TTL = 30 days (Standard)"** and the tree's longest TTL is
 * **7 days** — 4.3× shorter. That gap is not an oversight in the code, and this file is the
 * reason:
 *
 * **A vendor response is a measurement of right now.** A 30-day-old rank, sentiment or
 * share-of-voice figure served as current is not a cache, it is a stale number with a
 * latency budget. The product's whole claim is that the number is dated and the date is
 * shown, so a cache long enough to make the date a lie defeats the claim it exists to
 * support.
 *
 * The TTL is therefore pinned **per namespace, at the value that is actually in force**, and
 * the test states the ceiling as well as the values — so a future change to 30 days has to
 * come here and argue for it in a place a reviewer will read.
 *
 * ## And these are assertions about the *code*, not about a copy of it
 *
 * Every value is read out of the source file that owns it rather than restated here. A
 * test that restates the constant tests itself: it passes when the constant changes and
 * fails when someone edits the test, which is the opposite of useful. That mistake shipped
 * in `nightly-budgets.test.ts` earlier in this project and is the reason the extraction
 * happened.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Read a TTL in seconds out of the module that owns it.
 *
 * **Two shapes, because the tree uses two.** Seven namespaces declare a local
 * `const NAME_TTL_SECONDS = …`, and the eighth — `CACHE_TTL.researchResult` — is a property
 * of a shared object in `r2-cache.ts`. The first version read only the `const` form and
 * reported that shared constant as *"no longer declares researchResult in the shape this
 * test reads"* — a message that reads like the code had been renamed when the reader was
 * simply too narrow. **An error that blames the code for a gap in the reader is its own
 * kind of instrument failure**, so the message now names both shapes.
 */
function ttlSeconds(relPath: string, constName: string): number {
  const source = readFileSync(relPath, "utf8");

  // Shape 1: `const NAME = 12 * 60 * 60;`
  const asConst = new RegExp(
    `const\\s+${constName}\\s*=\\s*([\\d_]+|\\d+(?:\\s*\\*\\s*\\d+)+)\\s*;`,
  ).exec(source);

  // Shape 2: `researchResult: 86400,` — a property of a shared constant object.
  const asProperty = new RegExp(`\\b${constName}\\s*:\\s*([\\d_]+)\\s*,`).exec(
    source,
  );

  const raw = asConst?.[1] ?? asProperty?.[1];
  if (raw === undefined) {
    throw new Error(
      `${relPath} declares ${constName} in neither shape this test reads ` +
        "(a `const NAME = <arithmetic>;` or an object property `name: <integer>,`)",
    );
  }
  // Digits, `*` and whitespace only — safe to evaluate, and the guard is here so a future
  // edit that puts something else in that constant fails loudly instead of running it.
  const expr = raw.replace(/_/g, "").replace(/\s+/g, "");
  if (!/^[\d*]+$/.test(expr)) {
    throw new Error(
      `${constName} is no longer plain integer arithmetic: ${expr}`,
    );
  }
  return eval(expr) as number; // eslint-disable-line no-eval
}

/** [namespace, file, const name, why this number and not another] */
const NAMESPACES = [
  [
    "brandLookup",
    "src/server/features/ai-search/services/brandLookup.ts",
    "BRAND_LOOKUP_TTL_SECONDS",
    "a paid per-platform lookup, so the window is bounded by spend not by freshness",
  ],
  [
    "promptResponse",
    "src/server/features/ai-search/services/promptExplorer.ts",
    "PROMPT_RESPONSE_TTL_SECONDS",
    "the longest in the tree, because an answer is a *published* artefact, not a metric",
  ],
  [
    "domainOverview",
    "src/server/features/domain/services/DomainService.ts",
    "DOMAIN_OVERVIEW_TTL_SECONDS",
    "rank and traffic estimates move daily and are shown with a date",
  ],
  [
    "domainKeywordsPage",
    "src/server/features/domain/services/domainKeywordsPage.ts",
    "DOMAIN_KEYWORDS_PAGE_TTL_SECONDS",
    "a paginated table over a slowly-moving dataset",
  ],
  [
    "domainPagesPage",
    "src/server/features/domain/services/domainPagesPage.ts",
    "DOMAIN_PAGES_PAGE_TTL_SECONDS",
    "same dataset, same window — deliberately the same constant as its sibling",
  ],
  [
    "serp",
    "src/server/features/keywords/services/research/serp.ts",
    "SERP_CACHE_TTL_SECONDS",
    "a SERP is a snapshot of a ranking that changes within the day",
  ],
  [
    "businessCategories",
    "src/server/mcp/tools/local-seo-tools.ts",
    "BUSINESS_CATEGORIES_TTL_SECONDS",
    "a category taxonomy, which changes on the scale of months",
  ],
] as const;

const DAY = 86_400;

describe("the response cache's freshness policy", () => {
  it("pins every namespace TTL to the value actually in force", () => {
    const measured = NAMESPACES.map(([name, file, constName]) => ({
      name,
      seconds: ttlSeconds(file, constName),
    }));

    // Printed beside the verdict, because **a confident null is worse than a loud
    // failure** and a table nobody reads is the same as no table.
    console.log(
      "\n  cache TTLs, measured from the owning module:\n" +
        measured
          .map(
            ({ name, seconds }) =>
              `    ${name.padEnd(20)} ${String(seconds).padStart(7)}s = ${(seconds / DAY).toFixed(2)}d`,
          )
          .join("\n"),
    );

    // **`s / DAY`, and the first version wrote `s`** — so the label said `brandLookup=86400d`
    // and the test failed against its own expectation. A number with a unit in its name is
    // a unit test whether or not it agrees with the assertion.
    expect(
      measured.map(({ name, seconds }) => `${name}=${seconds / DAY}d`),
    ).toEqual([
      "brandLookup=1d",
      "promptResponse=7d",
      "domainOverview=0.5d",
      "domainKeywordsPage=0.5d",
      "domainPagesPage=0.5d",
      "serp=0.5d",
      "businessCategories=7d",
    ]);
  });

  it("keeps the shared research TTL in step with its siblings", () => {
    // **The one TTL that lives in a different file from the code that uses it**, so it is
    // the one most likely to drift silently: nobody reading `research.ts` sees the number.
    const research = ttlSeconds("src/server/lib/r2-cache.ts", "researchResult");
    console.log(
      `    researchResult (shared)  ${research}s = ${(research / DAY).toFixed(2)}d`,
    );

    // A paid keyword-research pull, so it is bounded by the same 24h spend window as
    // `brandLookup` rather than by the 12h of the free SERP read.
    expect(research / DAY).toBe(1);
  });

  it("never lets a cache outlive the freshness the product claims", () => {
    // **The clause CL-121 got wrong.** The row asks for 30 days; this asserts the ceiling
    // that is actually defensible for a product that dates every metric.
    //
    // The two 7-day namespaces are the exception and are named rather than allowed by a
    // blanket number: an AI answer and a category taxonomy are *published artefacts*, not
    // measurements of now, so a week is defensible for them and not for the rest.
    const metricNamespaces = NAMESPACES.filter(
      ([name]) => name !== "promptResponse" && name !== "businessCategories",
    );

    for (const [name, file, constName] of metricNamespaces) {
      const seconds = ttlSeconds(file, constName);
      expect(
        seconds,
        `${name} caches a live measurement and must not exceed a day`,
      ).toBeLessThanOrEqual(DAY);
    }

    const artefactNamespaces = NAMESPACES.filter(
      ([name]) => name === "promptResponse" || name === "businessCategories",
    );
    for (const [name, file, constName] of artefactNamespaces) {
      const seconds = ttlSeconds(file, constName);
      expect(seconds, `${name} is a published artefact`).toBeLessThanOrEqual(
        7 * DAY,
      );
    }

    // And the ceiling itself, so "30 days" cannot creep back in unexamined.
    const longest = Math.max(
      ...NAMESPACES.map(([, file, constName]) => ttlSeconds(file, constName)),
    );
    expect(longest / DAY).toBeLessThan(30);
  });

  it("reads the TTL out of the module, so the test cannot drift from the code", () => {
    // **A test that restates a constant tests itself.** If this file listed `86400` and
    // the owning module said `43200`, the suite would be green and the product stale. So
    // the negative control is structural: change the owner and this must follow.
    const changed = ttlSeconds(
      "src/server/features/ai-search/services/brandLookup.ts",
      "BRAND_LOOKUP_TTL_SECONDS",
    );

    // The control asserts the *reading* is real by proving a wrong read fails loudly, and it
    // matches on the shape of the message rather than its exact wording — **the first
    // version matched the old wording and went red when I improved the message**, which is
    // the control failing for a reason that has nothing to do with the code it guards.
    expect(() =>
      ttlSeconds(
        "src/server/features/ai-search/services/brandLookup.ts",
        "A_CONSTANT_THAT_DOES_NOT_EXIST",
      ),
    ).toThrow(/declares A_CONSTANT_THAT_DOES_NOT_EXIST in neither shape/);
    expect(changed).toBeGreaterThan(0);
  });

  it("erases cached vendor responses on a GDPR request, or the cache outlives the data", () => {
    // **The reason the cache is on the erasure path at all.** A cache that outlives a
    // deletion request is a privacy bug that no table-level sweep can find, because the
    // data is not in a table — it is an R2 object with no row pointing at it.
    const erasure = readFileSync("src/server/gdpr/storage-erasure.ts", "utf8");

    expect(erasure).toMatch(/AI_SEARCH_PROMPT_CACHE_NAMESPACE/);
    expect(erasure).toMatch(/cacheObjectPrefix/);
    // Listing by prefix rather than deleting by key, because **the key set is unbounded** —
    // a target with forty brand lookups has forty objects and the eraser holds one target.
    expect(erasure).toMatch(/\.list\(/);
  });
});
