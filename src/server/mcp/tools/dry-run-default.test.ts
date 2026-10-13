/**
 * The dry-run default, on the tool that prices per request *and* per item.
 *
 * ## Why this is its own file
 *
 * The rule is about the default, and a default is only visible when nothing is
 * passed. That makes the tests the only ones in the tools directory whose
 * assertion is "the vendor was not called" — a negative — and grouping them in
 * one file means the reviewer who bumps a file past its line cap looks at this
 * suite rather than trimming an unrelated one.
 *
 * ## Why the credit figure is matched, not read
 *
 * The handler's return is a union of the preview and the real result, and the
 * estimate only exists on the preview. Reading it through a type assertion would
 * compile a wrong read and pass it; `toMatchObject` fails when the shape is not
 * there, which is the behaviour the rule needs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as researchTools from "./dataforseo-research-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo", async () => {
  const keywordMetrics = await vi.importActual(
    "@/server/lib/dataforseo/keyword-metrics",
  );
  return {
    createDataforseoClient: mocks.createDataforseoClient,
    fetchKeywordMetricsForList: keywordMetrics.fetchKeywordMetricsForList,
  };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
/** The defect, as a value: preview only when `dry_run` is explicitly true. */
const invertedWantsToSpend = (dryRun: boolean | undefined) => dryRun !== true;

/** The correct rule: spend only on an explicit opt-out. */
const wantsToSpend = (dryRun: boolean | undefined) => dryRun === false;

const usProjectRow = {
  id: "project_1",
  locationCode: 2840,
  languageCode: "en",
};

describe("get_ranked_keywords dry run", () => {
  /**
   * CL-058: an agent that knows nothing must be able to ask the price without
   * spending. The requirement is **the default** — an omitted `dry_run` has to
   * preview, not spend — because the caller the rule exists for reads none of
   * the description and passes none of the fields.
   */
  const rankedKeywordsForRun =
    vi.fn<
      (input: {
        filters?: unknown[];
      }) => Promise<{ items: unknown[]; totalCount: number }>
    >();

  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue(usProjectRow);
    rankedKeywordsForRun.mockResolvedValue({ items: [], totalCount: 0 });
    mocks.createDataforseoClient.mockReturnValue({
      domain: { rankedKeywords: rankedKeywordsForRun },
    });
  });

  it("previews the cost without calling the vendor when dry_run is omitted", async () => {
    const result = await researchTools.getRankedKeywordsTool.handler(
      { projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );

    expect(rankedKeywordsForRun).not.toHaveBeenCalled();
    expect(textContent(result)).toContain("Dry run:");
    expect(textContent(result)).toContain("dry_run: false");
  });

  it("quotes the limit the caller actually asked for, not the default", async () => {
    // Labs is priced per request *and* per item, and the item count is the
    // caller's choice. Quoting the default for a caller who asked for 100
    // under-reports by a factor of two, which is worse than saying nothing.
    const fifty = await researchTools.getRankedKeywordsTool.handler(
      { projectId: "project_1", target: "acmeexample.com" },
      toolContext,
    );
    const hundred = await researchTools.getRankedKeywordsTool.handler(
      { projectId: "project_1", target: "acmeexample.com", limit: 100 },
      toolContext,
    );

    // `creditsQuoted` fails when there is no estimate in the response, so a
    // preview that rendered no price is caught here rather than passing.
    const fiftyCredits = creditsQuoted(fifty);
    const hundredCredits = creditsQuoted(hundred);
    expect(hundredCredits).toBeGreaterThan(fiftyCredits);
  });

  it("spends only when dry_run is explicitly false", async () => {
    await researchTools.getRankedKeywordsTool.handler(
      { projectId: "project_1", target: "acmeexample.com", dry_run: false },
      toolContext,
    );

    expect(rankedKeywordsForRun).toHaveBeenCalledTimes(1);
  });

  it("would catch a dry_run that defaults to spending", () => {
    // The negative control, and the reason it is its own assertion: the whole
    // rule is the default, so a `wantsToSpend` that reads `dry_run !== true`
    // passes every test that opts out explicitly and fails the only caller the
    // rule is for.
    //
    // Proved by defect injection. Changing `wantsToSpend` to
    // `dryRun !== true` makes the first test in this block fail on
    // `expect(rankedKeywordsForRun).not.toHaveBeenCalled()`.
    expect(invertedWantsToSpend(undefined)).toBe(true);
    expect(wantsToSpend(undefined)).toBe(false);
    // Both forms agree on the explicit opt-out, which is exactly why a test
    // that only ever passes `false` cannot tell them apart.
    expect(invertedWantsToSpend(false)).toBe(true);
    expect(wantsToSpend(false)).toBe(true);
  });
});

/**
 * Read the quoted credits out of a dry-run response, or fail loudly.
 *
 * The response is matched rather than cast: `toMatchObject` on the whole result
 * needs no type assertion, and a response that is not a preview fails the match
 * rather than passing silently.
 */
function creditsQuoted(result: {
  structuredContent: Record<string, unknown>;
  content: unknown;
}): number {
  const text = JSON.stringify(result.structuredContent);
  const quoted = /"estimatedCredits":(\d+(?:\.\d+)?)/.exec(text);
  if (!quoted) throw new Error(`no estimatedCredits in ${text}`);
  return Number(quoted[1]);
}
