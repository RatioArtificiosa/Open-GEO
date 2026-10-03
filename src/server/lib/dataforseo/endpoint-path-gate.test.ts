import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sortBy } from "remeda";
import { describe, expect, it } from "vitest";

/**
 * Every DataForSEO client's endpoint path is asserted by its own test.
 *
 * The `ai-keywords` client shipped pointed at a URL that does not exist:
 * `/v3/ai_optimization/ai_keyword_data/keywords/search_volume/live` instead of
 * `keywords_search_volume`. Fourteen tests passed the whole time it was broken,
 * because every one of them asserted the request **body** and none asserted the
 * **destination** — a mocked `fetch` accepts any URL you hand it.
 *
 * That is the specific shape of the mistake this file exists to prevent:
 * a plausible-looking path that 404s on a *billed* call. DataForSEO charges per
 * request, so a wrong path is not a boot-time crash; it is a customer-visible
 * error after the money is spent. The tests cannot see it, so a gate must.
 *
 * The rule is deliberately the cheap one — "does the test file mention the path,
 * or a distinctive tail of it" — rather than demanding a particular assertion
 * style. A gate that prescribes how to write a test gets deleted the first time
 * it is inconvenient, and a deleted gate protects nothing.
 */

const CLIENTS_DIR = join(process.cwd(), "src/server/lib/dataforseo");

const clientFiles = readdirSync(CLIENTS_DIR).filter(
  (name) =>
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    !name.endsWith(".d.ts"),
);

const readIfPresent = (name: string): string | null => {
  try {
    return readFileSync(join(CLIENTS_DIR, name), "utf8");
  } catch {
    return null;
  }
};

/**
 * Blank out comments, keeping string literals — a comment is prose, not code.
 *
 * **Strings are kept**, unlike the comment-and-string stripper in `gates-about-gates`, which
 * needs the opposite: there the *fixture* was quoted source, here the subject **is** the
 * string. **Two gates in this repository need opposite treatment of string literals, and a
 * helper shared between them would have to be wrong for one.**
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Every endpoint path a DataForSEO client calls, however it spells it.
 *
 * ## Why this returns a LIST rather than the first match
 *
 * **The first version returned one path — the first `/v3/…` string in the file.** That is a
 * plausible-looking rule, and it made the gate report `backlinks.ts` and `labs.ts` as covered
 * while **four of five and nine of ten of their endpoints had never been gated.** A gate with
 * one verdict per *file* is not a weaker gate, it is a different gate, and it reads as though
 * it covers more than it does — which is worse than not existing, because the coverage is
 * believed.
 *
 * Every path is returned, so the report below is per **endpoint**, and an endpoint added to an
 * existing client is gated the day it is written rather than whenever that file happens to be
 * restructured so its first path changes.
 *
 * ## Comments are stripped first
 *
 * **A path in a doc block is not a call.** `core.ts` names paths in prose to explain the
 * throttle bug, and this file's own header quotes the broken `ai-keywords` URL. Counting
 * those would demand assertions for endpoints nothing calls — and a gate that demands the
 * impossible gets deleted rather than fixed.
 */
function detectPaths(source: string): string[] {
  const code = stripComments(source);
  const found = [
    ...code.matchAll(/["'`](\/v3\/[a-z0-9_\-/]+)["'`]/g),
    ...code.matchAll(/["'`](\/ai_optimization\/[a-z0-9_\-/]+)["'`]/g),
  ].map((m) => m[1]);

  // **Deduplicated**, because `assertOk(response, assertOptions(PATH))` repeats the path that
  // `dataforseoPost(PATH, …)` already declared — and a gate reporting the same path twice
  // reads as two endpoints where there is one.
  //
  // **No `!` on the capture.** `no-unnecessary-type-assertion` flagged it, and it was right:
  // `matchAll` on a pattern with exactly one capture group types the capture as `string`.
  return [...new Set(found)];
}

/**
 * Does the test file pin the path?
 *
 * Accepted: the full path, or the **whole** tail (its last two segments). A
 * single distinctive segment is *not* enough, and this file learned that the
 * hard way: an earlier version accepted any segment of 8+ characters, and
 * `search_volume` appears in both `keywords/search_volume` and
 * `keywords_search_volume` — so the detection could not tell the shipped bug
 * from the fix, and the self-test below caught that rather than a real gap.
 *
 * Matching is on the *delimited* form, so a test that says
 * `keywords/search_volume` is not satisfied by one that says
 * `keywords_search_volume`, and vice versa.
 */
function assertsPath(test: string, path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  const tail = segments.slice(-2).join("/");
  // The delimiters matter: a bare tail match would let `search_volume/live`
  // satisfy the `keywords_search_volume` path, since one contains the other.
  return (
    test.includes(path) ||
    test.includes(`/${tail}`) ||
    test.includes(`${tail}/`)
  );
}

const rawEndpoints = clientFiles.flatMap((name) => {
  const test = readIfPresent(name.replace(/\.ts$/, ".test.ts"));
  return detectPaths(readFileSync(join(CLIENTS_DIR, name), "utf8")).map(
    (path) => ({
      name,
      path,
      test,
    }),
  );
});

/**
 * One row per **endpoint**, sorted so the failure message reads as a diff.
 *
 * **Remeda's `sortBy` with a single bare projection.** `OrderRule<T>` is
 * `Projection<T> | [Projection<T>, direction]`, and a projection is just a function — so one
 * concatenated key sorts by both fields with no tuple and no direction constant. **The
 * codebase already uses this form** (`sortBy(a, identity())` in
 * `usePromptExplorerSearchHistory.ts`) and I read that line three times while guessing.
 *
 * **Not `toSorted` and not `Array#sort`.** `oxlint` asks for `toSorted`; `tsconfig.json`
 * answers why it cannot be used, on the `lib` line itself: *"toReversed, findLast, ... crash
 * Chromium <110. Don't bump this to fix a missing-method error — use Remeda's
 * sort/sortBy/findLast instead."* **A rule that cannot be satisfied without breaking a
 * documented runtime constraint is not a rule to suppress — it is a signal to use the tool the
 * codebase already chose.**
 */
const endpoints = sortBy(rawEndpoints, (e) => `${e.name} ${e.path}`);

const clients = clientFiles.map((name) => ({
  name,
  path: detectPaths(readFileSync(join(CLIENTS_DIR, name), "utf8"))[0] ?? null,
  test: readIfPresent(name.replace(/\.ts$/, ".test.ts")),
}));

/**
 * The URL a mocked `fetch` was called with.
 *
 * `fetch` takes `RequestInfo` — a string, a `URL`, or a `Request` — so
 * `String(call)` is not safe: a `Request` stringifies to `[object Object]`, and a
 * path assertion built on that would pass for entirely the wrong reason.
 * `oxlint`'s `no-base-to-string` is right to flag it. The unwrapping lives in
 * `test-support.ts`; this is a re-export so the asserting tests in the other
 * files have one obvious place to import from.
 */
export { requestUrl } from "./test-support";

describe("DataForSEO client endpoint paths", () => {
  it("scans more than a handful of clients, so the gate is not vacuous", () => {
    // A source-scanning gate with a wrong directory passes forever by finding
    // nothing. Same lesson as the platform card rule.
    expect(clients.length).toBeGreaterThan(5);
  });

  it("finds an endpoint in the clients that declare one", () => {
    const withPath = clients.filter((c) => c.path !== null);
    expect(withPath.length).toBeGreaterThan(3);
  });

  it("sees every endpoint, not one per file — the defect this gate had", () => {
    // **What makes the per-endpoint change mean anything.** If `detectPaths` silently
    // regressed to returning one path, every other case here would still pass while the gate
    // quietly covered a fraction of what it reads as covering — and it has done exactly that,
    // which is how the ratio assertion came to exist.
    //
    // **A ratio, not a number**, so it stays true as clients are added: `toBe(30)` would
    // break on the next endpoint and the tempting fix would be to bump the constant, which is
    // how a pin becomes a rubber stamp.
    const perFile = clients.filter((c) => c.path !== null).length;
    expect(endpoints.length).toBeGreaterThan(perFile * 1.5);

    // The case that started this: `backlinks.ts` has six endpoints and the gate used to
    // speak about one of them.
    expect(
      endpoints.filter((e) => e.name === "backlinks.ts").length,
    ).toBeGreaterThan(2);
  });

  const unasserted = endpoints.filter(
    (e) => e.test !== null && !assertsPath(e.test, e.path),
  );

  it("are each pinned by their own test file", () => {
    // The failure message names the file and the path, because "some client is
    // wrong" is not actionable and this gate only helps if it is.
    const report = unasserted.map((e) => `  ${e.name}: ${e.path}`).join("\n");
    expect(
      unasserted.map((e) => `${e.name}: ${e.path}`),
      `These endpoints are never asserted by their client's test, so a wrong URL ` +
        `would pass every test and fail only on a billed request:\n${report}`,
    ).toEqual([]);
  });

  it("catches the exact transposition that shipped, if reintroduced", () => {
    // A gate that cannot fail proves nothing, so the detection is exercised
    // against the known-bad statement rather than only trusted.
    const wrong =
      "/v3/ai_optimization/ai_keyword_data/keywords/search_volume/live";
    const right =
      "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live";
    // A test asserting the correct path does NOT satisfy the wrong one, because
    // the wrong path's tail is `keywords/search_volume` and no test says that.
    expect(assertsPath(`expect(url).toContain("${right}")`, wrong)).toBe(false);
    expect(assertsPath(`expect(url).toContain("${wrong}")`, wrong)).toBe(true);
  });
});
