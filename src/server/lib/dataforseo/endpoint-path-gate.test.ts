import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** The endpoint, however the client spells it. */
function detectPath(source: string): string | null {
  const match =
    /["'`](\/v3\/[a-z0-9_\-/]+)["'`]/.exec(source) ??
    /["'`](\/ai_optimization\/[a-z0-9_\-/]+)["'`]/.exec(source);
  return match?.[1] ?? null;
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

const clients = clientFiles.map((name) => {
  const source = readFileSync(join(CLIENTS_DIR, name), "utf8");
  return {
    name,
    path: detectPath(source),
    test: readIfPresent(name.replace(/\.ts$/, ".test.ts")),
  };
});

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

  const unasserted = clients.filter(
    (c) => c.path !== null && c.test !== null && !assertsPath(c.test, c.path),
  );

  it("are each pinned by their own test file", () => {
    // The failure message names the file and the path, because "some client is
    // wrong" is not actionable and this gate only helps if it is.
    const report = unasserted.map((c) => `  ${c.name}: ${c.path}`).join("\n");
    expect(
      unasserted.map((c) => `${c.name}: ${c.path}`),
      `These clients' tests never assert their endpoint path, so a wrong URL ` +
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
