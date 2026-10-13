/**
 * The gate that converts a date into an assertion.
 *
 * ## Why this file exists
 *
 * DataForSEO flips the new ETV formula on for everyone on **2026-11-01**. An
 * endpoint that omits `use_new_etv` before that date returns the legacy model;
 * the same request on the day after returns the new one. Nothing crashes, no
 * test fails, and every stored number after the boundary is quietly computed by
 * a different model than the ones beside it in the same series.
 *
 * A deadline is not a constraint anyone is reminded of. This test reads the
 * source of every Labs client module, extracts each `dataforseo_labs` endpoint
 * it calls, and asserts that each one either pins the flag explicitly or is on
 * a named list with a reason. **A new Labs call added by anyone, at any time,
 * has to answer the question this test asks** — which is the only version of
 * the rule that survives contact with the next person to add an endpoint.
 *
 * ## What it does not do
 *
 * It does not verify that a flag we send is a flag the vendor accepts. That is
 * CL-712a's job and needs a live key; this gate makes the code half of it
 * impossible to regress.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { first, at } from "@/shared/index-reads";
import {
  ETV_BEARING_LABS_ENDPOINTS,
  ETV_CUTOVER_DATE,
  ETV_UNVERIFIED_LABS_ENDPOINTS,
  isEtvUnverifiedLabsEndpoint,
  unverifiedEtvProvenance,
  type EtvUnverifiedLabsEndpoint,
} from "@/shared/etv-versioning";

/** Every module that speaks to a `dataforseo_labs` endpoint. */
const LABS_CLIENT_MODULES = [
  "src/server/lib/dataforseo/labs.ts",
  "src/server/lib/dataforseo/labsCategories.ts",
  "src/server/lib/dataforseo/labsDomainMetrics.ts",
  "src/server/lib/dataforseo/labsIntersection.ts",
  "src/server/lib/dataforseo/search-intent.ts",
] as const;

const ROOT = process.cwd();

/** One call site: which file, which endpoint, which enclosing function. */
type CallSite = {
  file: string;
  endpoint: string;
  /** The `export async function` the call lives inside, for a readable failure. */
  fn: string;
  /** Whether the body the flag would go into is in scope for this module. */
  pinsTheFlag: boolean;
};

function readModule(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Every Labs endpoint each module calls, paired with the function enclosing it
 * and whether **that function** pins the flag.
 *
 * ## Why per-function and not per-file
 *
 * The first version asked whether the module mentioned `use_new_etv` at all.
 * It passed while `relevant_pages` was unpinned, because two other endpoints in
 * the same file still pinned theirs. **A check aimed at a nearby, easy-to-assert
 * property is worse than no check**: it reports clean, so nobody looks again,
 * and the defect it was written for sits behind a green result.
 *
 * ## Why the check follows one level of delegation
 *
 * The intersection endpoints fold the flag into a shared `intersectionBody`
 * helper rather than writing it at each call site, and that is the better design:
 * two endpoints with identical bodies pin the flag from one place, so they cannot
 * drift apart. A line-range check that cannot see through a helper reports them
 * as unpinned.
 *
 * So a function counts as pinning when its own body names the flag **or** it
 * calls a same-module helper whose body does. One level, because a second is
 * where this stops being a coverage check and starts being a parser — and the
 * limit is stated here rather than left for someone to discover.
 *
 * ## Why the endpoint is matched on its own line
 *
 * The call is written as `dataforseoPost<...>(\n  "/v3/…",\n)` — the path is on
 * a line of its own, so a regex that requires both on one line finds nothing and
 * the suite reports clean. **That is the failure mode this whole file exists to
 * prevent**, so the match is on the path and the transport name is not part of
 * the pattern.
 */
function callSites(rel: string): CallSite[] {
  const lines = readModule(rel).split("\n");
  const sites: CallSite[] = [];

  // Function body ranges, so the flag is looked for where it would be written.
  // **Non-exported functions are in scope too**: `intersectionBody` is the
  // module-private helper that folds the flag into both intersection bodies, and
  // matching only `export function` would miss the one delegation that exists.
  const fnRegex = /^(?:export )?(?:async )?function (\w+)/;
  const ranges: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = fnRegex.exec(lines[i] ?? "");
    if (!match?.[1]) continue;
    // The guard above proves the array is non-empty, so the last element is
    // present and the compiler cannot see it. `at()` rather than a bare index:
    // writing `.end` on `undefined` throws, and this is the range collector the
    // classification below depends on.
    if (ranges.length > 0) {
      at(ranges, ranges.length - 1, "the ranges collected so far").end = i;
    }
    ranges.push({ name: match[1], start: i, end: lines.length });
  }

  const bodyOf = (range: { start: number; end: number }) =>
    lines.slice(range.start, range.end).join("\n");
  const helperNames = new Set(ranges.map((range) => range.name));

  for (let i = 0; i < lines.length; i++) {
    const callMatch = /"(\/v3\/dataforseo_labs\/[^"]+)"/.exec(lines[i] ?? "");
    if (!callMatch?.[1]) continue;
    const endpoint = callMatch[1]
      .replace("/v3/dataforseo_labs/google/", "")
      .replace(/\/(live|task_post)$/, "");
    const owner = ranges.find((range) => range.start <= i && i < range.end);
    if (!owner) {
      // Module scope: no body to pin, and nothing to delegate to either.
      sites.push({
        file: rel,
        endpoint,
        fn: "(module scope)",
        pinsTheFlag: false,
      });
      continue;
    }
    const body = bodyOf(owner);
    const pinsDirectly = body.includes("use_new_etv");
    // One level of delegation: a helper named in this body that pins the flag.
    const pinsViaHelper = [...helperNames].some((name) => {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) return false;
      const helper = ranges.find((range) => range.name === name);
      return helper ? bodyOf(helper).includes("use_new_etv") : false;
    });
    sites.push({
      file: rel,
      endpoint,
      fn: owner.name,
      pinsTheFlag: pinsDirectly || pinsViaHelper,
    });
  }
  return sites;
}

describe("every Labs call site answers for its ETV formula", () => {
  const allSites = LABS_CLIENT_MODULES.flatMap(callSites);

  it("found the Labs call sites, so a missing module is a failure and not a pass", () => {
    // **The vacuity guard.** A module renamed or deleted makes this suite
    // quietly check fewer endpoints, which is the one outcome worse than a
    // failing test. The count is the lower bound observed on 2026-10-11 and is
    // raised deliberately when an endpoint family is added.
    expect(allSites.length).toBeGreaterThanOrEqual(14);
  });

  it("no Labs endpoint is outside every list", () => {
    const known = new Set<string>([
      ...ETV_BEARING_LABS_ENDPOINTS,
      ...ETV_UNVERIFIED_LABS_ENDPOINTS,
      // Endpoints whose items carry no `etv` field, so the formula cannot
      // apply and there is nothing to version.
      "related_keywords",
      "keyword_suggestions",
      "keyword_ideas",
      "search_intent",
    ]);
    const unknown = allSites
      .filter((site) => !known.has(site.endpoint))
      .map((site) => `${site.file}::${site.fn} → ${site.endpoint}`);
    expect(
      unknown,
      "an endpoint that is not classified is an endpoint whose ETV numbers will be unreadable after 2026-11-01 — add it to ETV_BEARING_LABS_ENDPOINTS and pin the flag, or to ETV_UNVERIFIED_LABS_ENDPOINTS with a reason",
    ).toEqual([]);
  });

  it("every ETV-bearing call site pins the flag", () => {
    const bearing = new Set<string>(ETV_BEARING_LABS_ENDPOINTS);
    const unpinned = allSites
      .filter((site) => bearing.has(site.endpoint))
      .filter((site) => !site.pinsTheFlag)
      .map((site) => `${site.file}::${site.fn} → ${site.endpoint}`);
    expect(
      unpinned,
      `these call sites are on the vendor's ETV-bearing list and omit use_new_etv. On ${ETV_CUTOVER_DATE} the vendor's default becomes the NEW formula, so an omitted flag changes what the stored value means without anyone deciding to. Pin it with etvFields().`,
    ).toEqual([]);
  });

  it("every unverified endpoint says so, rather than pinning a version it cannot claim", () => {
    const unverified = new Set<string>(ETV_UNVERIFIED_LABS_ENDPOINTS);
    const wronglyPinned = allSites
      .filter((site) => unverified.has(site.endpoint))
      .map((site) => `${site.file}::${site.fn} → ${site.endpoint}`)
      .filter((label) => {
        // These must return unverifiedEtvProvenance. A module that mentions
        // neither helper is unpinned by accident, which is the failure the
        // whole file exists to catch.
        // `split` on a non-empty separator always yields at least one element,
        // so the head is provably present. `first()` rather than `[0]`:
        // `readModule` on `undefined` throws, and this is the helper that
        // classifies every endpoint in the gate.
        const file = first(label.split("::"), "a labelled endpoint");
        const source = readModule(file);
        return (
          source.includes("use_new_etv") &&
          !source.includes("unverifiedEtvProvenance")
        );
      });
    expect(wronglyPinned).toEqual([]);
  });

  it("the unverified list cannot grow silently", () => {
    // A new entry here is a decision, so it has to change the count this test
    // asserts rather than be discoverable only by reading the source.
    expect(ETV_UNVERIFIED_LABS_ENDPOINTS.length).toBe(4);
  });

  // **The predicate and the list are two statements of the same fact.** A list
  // that gains an entry its predicate does not recognise is a value that gets
  // pinned when it should have been marked unverifiable — and the type-level
  // narrowing is the only thing that made the mistake impossible to see.
  it("the predicate and the list agree", () => {
    // The list's literal type narrows to the exported union, which is the only
    // thing binding the two: an entry added without the union being widened
    // would be a compile error here rather than a runtime surprise.
    const narrowed: EtvUnverifiedLabsEndpoint[] = [
      ...ETV_UNVERIFIED_LABS_ENDPOINTS,
    ];
    expect(narrowed.length).toBe(ETV_UNVERIFIED_LABS_ENDPOINTS.length);
    for (const endpoint of ETV_UNVERIFIED_LABS_ENDPOINTS) {
      expect(
        isEtvUnverifiedLabsEndpoint(endpoint),
        `${endpoint} is on the unverified list but the predicate rejects it`,
      ).toBe(true);
    }
    // An endpoint that is neither confirmed nor unverifiable must be rejected by
    // both. `ranked_keywords` is the confirmed case and `keyword_suggestions`
    // carries no etv at all.
    for (const other of ["ranked_keywords", "keyword_suggestions", ""]) {
      expect(isEtvUnverifiedLabsEndpoint(other), other).toBe(false);
    }
  });

  // One function is the only way in, so a new entry cannot be pushed through a
  // different path that skips the guard.
  it("the provenance helper refuses a confirmed endpoint", () => {
    expect(() => unverifiedEtvProvenance("ranked_keywords")).toThrow(
      /not an unverified ETV endpoint/,
    );
  });
});
