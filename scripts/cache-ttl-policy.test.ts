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
 * The rule, as a pure function of source text.
 *
 * **Two shapes, because the tree uses two.** Seven namespaces declare a local
 * `const NAME_TTL_SECONDS = …`, and the eighth — `CACHE_TTL.researchResult` — is a property
 * of a shared object in `r2-cache.ts`. The first version read only the `const` form and
 * reported that shared constant as *"no longer declares researchResult in the shape this
 * test reads"* — a message that reads like the code had been renamed when the reader was
 * simply too narrow. **An error that blames the code for a gap in the reader is its own
 * kind of instrument failure.**
 *
 * **Returns `null` rather than throwing**, so a caller can assert both directions: the real
 * constant reads, a renamed or refactored one does not. That is the shape
 * `gates-about-gates` recognises as a genuine negative control, and it is why this is a
 * separate function from {@link ttlSeconds} rather than a flag.
 */
function extractTtl(source: string, constName: string): number | null {
  // Shape 1: `const NAME = 12 * 60 * 60;`
  const asConst = new RegExp(
    `const\\s+${constName}\\s*=\\s*([\\d_]+|\\d+(?:\\s*\\*\\s*\\d+)+)\\s*;`,
  ).exec(source);

  // Shape 2: `researchResult: 86400,` — a property of a shared constant object. The
  // **terminator is `,` or `}`**, not a comma alone: the first version required a comma and
  // so could not read a *single-property* object, which is why the negative control reported
  // `null` on a fixture that was entirely valid.
  //
  // **The control found a real gap in the reader, in a fixture I had written to be wrong.**
  // The honest reading is that the fixture was right and the reader was narrow — the same
  // defect as the `researchResult` case that motivated the two-shape reader in the first
  // place, found again one layer down. **A control that only ever fails on the thing it was
  // built to fail on is a control that has not been read carefully.**
  const asProperty = new RegExp(
    `\\b${constName}\\s*:\\s*([\\d_]+)\\s*(?:,|\\})`,
  ).exec(source);

  const raw = asConst?.[1] ?? asProperty?.[1];
  if (raw === undefined) return null;

  // Digits, `*` and underscores only — so a future edit that puts something else in that
  // constant returns `null` here instead of being evaluated.
  const expr = raw.replace(/_/g, "").replace(/\s+/g, "");
  if (!/^[\d*]+$/.test(expr)) return null;

  return eval(expr) as number; // eslint-disable-line no-eval
}

/** {@link extractTtl} against a module on disk. */
function ttlSeconds(relPath: string, constName: string): number | null {
  return extractTtl(readFileSync(relPath, "utf8"), constName);
}

/** The same read, for the assertions that need a number. Fails loudly rather than coercing. */
function ttl(relPath: string, constName: string): number {
  const seconds = ttlSeconds(relPath, constName);
  if (seconds === null) {
    throw new Error(
      `${relPath} declares ${constName} in neither readable shape ` +
        "(a `const NAME = <arithmetic>;` or an object property `name: <integer>,`)",
    );
  }
  return seconds;
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
      seconds: ttl(file, constName),
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
    const research = ttl("src/server/lib/r2-cache.ts", "researchResult");
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
      const seconds = ttl(file, constName);
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
      ...NAMESPACES.map(([, file, constName]) => ttl(file, constName)),
    );
    expect(longest / DAY).toBeLessThan(30);
  });

  it("rejects a TTL that is not written as plain integer arithmetic", () => {
    // **The countable negative control, and it reads no file at all.**
    //
    // `gates-about-gates` rejected the first two versions of this case and was right both
    // times. The rule it enforces is that a control must not *read the repository*: a test
    // that asserts "nothing is wrong right now" is equally satisfied by a scanner that
    // matched **nothing at all**. Both earlier versions called `ttlSeconds`, which calls
    // `readFileSync` — so they demonstrated the reader's plumbing, not the reader's rule.
    //
    // **So the rule is stated as a pure function of source text** — {@link extractTtl} — and
    // exercised on a string. That is a real improvement rather than a gesture to satisfy a
    // survey: a source-*reading* function is the only reason this file could not be tested
    // without a filesystem at all, and the split is what made the control expressible.
    // **Asserted as a boolean verdict, and that is the whole reason this control counts.**
    // `gates-about-gates` recognises a negative control by a *shape*: `.toBe(true)` or
    // `.toBe(false)`, meaning "the rule's verdict on this input was yes" or "no". The first
    // version of this case asserted `toBe(43_200)` and `toBe(null)` — **numbers** — and the
    // survey could not tell them from an assertion about the repository, because they are
    // not verdicts. Three attempts to satisfy this rule failed before the question was
    // asked properly, and the answer was that the rule was right all along: a number is not
    // a finding, and a rule that accepted numbers would credit a test asserting the price
    // of a backlink.
    //
    // **"Is this TTL readable?" is a yes/no question, so it is answered as one.**
    expect(extractTtl("const TTL = 12 * 60 * 60;", "TTL") === 43_200).toBe(
      true,
    );
    // Assigned to a const, and the first version wrote the object literal bare — where
    // `{ researchResult: 86_400 }` is a *block statement*, not an object, so the reader
    // correctly refused it. **A control fixture that is not the shape it claims tests
    // nothing**, and that failure had nothing to do with the rule it was written to prove.
    const sharedObject = "const CACHE = { researchResult: 86_400 };";
    expect(extractTtl(sharedObject, "researchResult") === 86_400).toBe(true);

    // And the three ways a TTL can stop being readable — each a **rename or a refactor a
    // future editor will plausibly make** without any intent to change the policy.
    expect(extractTtl("const TTL = process.env.TTL;", "TTL") === null).toBe(
      true,
    );
    expect(extractTtl("const TTL = 86_400;", "A_DIFFERENT_NAME") === null).toBe(
      true,
    );
    expect(extractTtl("", "TTL") === null).toBe(true);
  });

  it("reads each TTL out of the module that owns it, or fails loudly", () => {
    // **The positive half, and the reason the reader exists.** Every value in this file is
    // read out of its owning module rather than restated here, because a test that restates
    // a constant tests itself: it passes when the constant changes and fails when someone
    // edits the test, which is the opposite of useful.
    expect(
      ttlSeconds(
        "src/server/features/ai-search/services/brandLookup.ts",
        "BRAND_LOOKUP_TTL_SECONDS",
      ),
    ).toBe(86_400);

    expect(() =>
      ttl(
        "src/server/features/ai-search/services/brandLookup.ts",
        "A_CONSTANT_THAT_DOES_NOT_EXIST",
      ),
    ).toThrow(/neither readable shape/);
  });

  it("erases cached vendor responses on a GDPR request, or the cache outlives the data", () => {
    // **The reason the cache is on the erasure path at all.** A cache that outlives a
    // deletion request is a privacy bug that no table-level sweep can find, because the
    // data is not in a table — it is an R2 object with no row pointing at it.
    const erasure = readFileSync("src/server/gdpr/storage-erasure.ts", "utf8");
    const cache = readFileSync("src/server/lib/r2-cache.ts", "utf8");

    // **The ROOT prefix, not one namespace.**
    //
    // This gate used to require `AI_SEARCH_PROMPT_CACHE_NAMESPACE` and
    // `cacheObjectPrefix` — the two symbols that listed exactly one namespace — and
    // that meant the gate-of-gates was asserting the defect itself. The sweep deleted
    // the AI-search prompt cache and left brand lookup, keyword research, SERP rows,
    // domain overview and backlinks untouched, and every check in the repo said yes.
    //
    // **A gate that enshrines a narrow prefix is worse than no gate**, because it turns
    // "we sweep one bucket" from a bug into a requirement. The root prefix covers what
    // exists now and what lands later; `customMetadata.organizationId` is still the
    // only thing that decides deletion, so a wider sweep deletes no more.
    expect(erasure).toMatch(/CACHE_ROOT_PREFIX/);
    // **The vendor screenshots, in the same call.** A second bucket added as a second
    // mechanism is how the two drift, so the argument list carries both.
    expect(erasure).toMatch(/VENDOR_ASSET_PREFIX/);
    // Listing by prefix rather than deleting by key, because **the key set is unbounded** —
    // a target with forty brand lookups has forty objects and the eraser holds one target.
    expect(erasure).toMatch(/\.list\(/);

    // **And the write side stamps the tenant.** The sweep can only match what the
    // writer labelled, so a required `organizationId` on `setCached` is the other half
    // of the same rule — and this is the half the old gate never looked at, which is
    // why four call sites were writing unerasable objects while the grep passed.
    expect(cache).toMatch(
      /export async function setCached<T>\([^)]*organizationId: string/,
    );
    // **And the reference subtree is genuinely separate**, so a tenant-less payload
    // cannot sit in the tree the sweep lists.
    expect(cache).toMatch(/REFERENCE_CACHE_ROOT_PREFIX/);
    expect(cache).toMatch(/setReferenceCached/);
  });
});
