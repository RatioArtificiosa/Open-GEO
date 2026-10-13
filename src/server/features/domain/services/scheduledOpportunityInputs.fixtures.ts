/**
 * Doubles and factories for the nightly opportunity-input capture.
 *
 * Extracted because the capture has **two** public entry points — the per-project
 * unit and the nightly sweep — and they share the same vendor surface. The repo's
 * own convention (`ga4-test-fixtures.ts`, `tool-test-support.ts`) is to extract a
 * shape that two test files both assert on, and this is that shape.
 *
 * Every double is typed from the **metered client's** method, never from the raw
 * section fetcher and never `as never`: a double that stops matching the client is
 * a compile error rather than a test that quietly passes against a stale shape.
 * That is also the CL-202 lesson — the capture used to inject the raw fetchers,
 * which is how three charged Labs calls a night ran with no credit gate at all.
 */

import { vi } from "vitest";
import type { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { KeywordOpportunityInputsRepository } from "@/server/features/domain/repositories/KeywordOpportunityInputsRepository";

/**
 * The metered reads the capture makes, as the client provides them.
 *
 * Type alias rather than the client's own type, so the doubles and the
 * production code name the same three methods from one place.
 */
type MeteredReads = Pick<
  ReturnType<typeof createDataforseoClient>["labs"],
  "keywordOverview" | "serpCompetitors" | "searchIntent"
>;

/** What the client's `keywordOverview` returns: the unwrapped vendor rows. */
type OverviewFn = MeteredReads["keywordOverview"];
type CompetitorsFn = MeteredReads["serpCompetitors"];
type SearchIntentFn = MeteredReads["searchIntent"];

/**
 * Wraps a double and counts its calls, so a test can assert one did not run.
 *
 * Typed with the double's own parameters rather than a generic `as T`: the whole
 * point of this module is that a shape change is a compile error, and a cast that
 * erases the parameter list would defeat it.
 */
export function counting<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
) {
  let calls = 0;
  const wrapped = async (...args: Args) => {
    calls += 1;
    return fn(...args);
  };
  return { wrapped, calls: () => calls };
}

/**
 * The repository write, spied so a test can inspect what would be stored
 * without a database. `insertPoint` is the only collaborator that reaches `@/db`.
 */
export function captureWrites() {
  const captured: Parameters<
    typeof KeywordOpportunityInputsRepository.insertPoint
  >[0][] = [];
  vi.spyOn(
    KeywordOpportunityInputsRepository,
    "insertPoint",
  ).mockImplementation(async (input) => {
    captured.push(input);
  });
  return captured;
}

/**
 * A vendor `keyword_overview` response — **in the shape the vendor actually
 * sends**, with `keyword_difficulty` nested under `keyword_properties`, and as
 * the client hands it over: the rows themselves, since `meter` unwraps `.data`.
 *
 * This is the detail that matters. The first draft of the service read
 * `row.keyword_difficulty` and `row.competitors` off the same row, which the real
 * endpoint never sends: `keyword_overview` nests the former and carries no
 * `competitors` field at all (`serp_competitors` is a separate endpoint). A
 * double written in that invented flat shape makes every test pass while the
 * production capture stores nothing but nulls.
 *
 * Echoes only the keywords it is asked for, which is what the vendor does, so a
 * double cannot smuggle in rows the service never requested.
 */
export const overviewRows =
  (rows: Array<{ keyword: string; keyword_difficulty?: number }>): OverviewFn =>
  async ({ keywords }) =>
    keywords.flatMap((keyword) => {
      // Matched case-insensitively, because the service lowercases what it sends
      // while a real keyword is stored however it was typed. A case-sensitive
      // match made the double return `[]` for "Hiking Boots" → "hiking boots",
      // which read as a capture bug for an hour.
      const match = rows.find(
        (row) => row.keyword.trim().toLowerCase() === keyword,
      );
      if (!match) return [];
      return [
        {
          keyword: match.keyword,
          keyword_properties:
            match.keyword_difficulty === undefined
              ? null
              : { keyword_difficulty: match.keyword_difficulty },
        },
      ];
    });

/**
 * A vendor `serp_competitors` response: one row per competing **domain**, for the
 * whole request. The endpoint does not attribute a row to a keyword, so the
 * capture counts distinct domains rather than inventing a per-keyword split.
 */
export const competitorRows =
  (domains: string[]): CompetitorsFn =>
  async () =>
    domains.map((domain) => ({ domain }));

/**
 * The vendor's closed set of intent labels, mirrored.
 *
 * `search-intent.ts` keeps these module-private, and `SearchIntentItem.intent` is
 * typed as the union — so a double that accepted `string` would have to assert
 * into the real type on every row, which is exactly the silent cast this file
 * exists to avoid. Mirroring the union means an invalid label is a **compile
 * error** here, and if the vendor's set changes, this stops compiling the day the
 * fetcher's type does.
 *
 * Source of truth: `SEARCH_INTENT_LABELS` in
 * `@/server/lib/dataforseo/search-intent`.
 */
type IntentLabel =
  | "informational"
  | "navigational"
  | "commercial"
  | "transactional"
  | "unknown";

/**
 * A vendor `search_intent` response, which carries no market at all.
 *
 * `probability` and `secondaryIntents` are required by the real item type. The
 * capture reads only `keyword` and `intent`, but a double that omitted the others
 * would fail to compile against the client's method — which is the whole point of
 * typing every factory from it.
 */
export const intentRows =
  (rows: Array<{ keyword: string; intent: IntentLabel }>): SearchIntentFn =>
  async () => ({
    items: rows.map((row) => ({
      keyword: row.keyword,
      intent: row.intent,
      probability: 1,
      secondaryIntents: [],
    })),
  });

/** Nothing at all returned — the shape a rate-limited or empty call gives. */
export const emptyOverview = overviewRows([]);
export const emptyCompetitors = competitorRows([]);
export const emptyIntent = intentRows([]);

/** A tracked keyword as `saved_keywords` returns it. */
export const keywordRow = (
  keyword: string,
  overrides: Partial<{
    projectId: string;
    locationCode: number;
    languageCode: string;
  }> = {},
) => ({
  projectId: "p1",
  keyword,
  locationCode: 2840,
  languageCode: "en",
  ...overrides,
});

/** Three competing domains — a SERP that is measurably crowded but not saturated. */
export const someCompetitors = ["a.com", "b.com", "c.com"];
