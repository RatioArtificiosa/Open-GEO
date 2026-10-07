import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The prompt-set generator's wiring.
 *
 * `buildPromptSet` is tested on its own, and the three reads are tested against real
 * SQLite. **What is left is the glue, and the glue is where this repository has found
 * twelve bugs** — every one of them a rule that was correct, tested and fed nothing.
 * Three claims live only here:
 *
 * 1. **The intent read is asked about the right keywords.** It is keyed on the demand
 *    read's output, so a keyword list assembled one step too late returns an empty
 *    map and every prompt becomes informational — a working-looking set with no
 *    classification in it.
 * 2. **`unknown` is not informational.** The keywords feature's fifth value means
 *    nobody classified the keyword, and the generator's own documented fallback is
 *    what should apply. Mapping it to `informational` would look identical in the
 *    output and would be a small lie about what the product knows.
 * 3. **The seed counts reach the caller**, because they are the only thing that tells
 *    two empty drafts apart.
 */

const listAiKeywordDemand = vi.fn();
const listRecentArchivedPrompts = vi.fn();
const listKeywordIntents = vi.fn();

vi.mock("@/server/features/geo/repositories/GeoRunRepository", () => ({
  GeoRunRepository: {
    listAiKeywordDemand,
    listRecentArchivedPrompts,
    listKeywordIntents,
  },
}));

// `geoPromptSets` also holds the writing half of the module, which reaches `@/db`
// and the Worker runtime. Neither is exercised here, and importing without these
// mocks builds a real database handle — an error about the database raised by a test
// about prompt text, which is the least diagnosable kind.
vi.mock("@/db/runBatch", () => ({
  runBatch: vi.fn(),
  executeInBatches: async (
    rows: readonly unknown[],
    run: (tx: unknown, row: unknown) => unknown,
  ) => {
    for (const row of rows) await run(undefined, row);
  },
}));
vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: {},
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { generatePromptSet } = await import("./geoPromptSets");

beforeEach(() => {
  vi.clearAllMocks();
  listAiKeywordDemand.mockResolvedValue([]);
  listRecentArchivedPrompts.mockResolvedValue([]);
  listKeywordIntents.mockResolvedValue([]);
});

describe("generatePromptSet", () => {
  it("asks for intents about exactly the keywords demand returned", async () => {
    listAiKeywordDemand.mockResolvedValue([
      { keyword: "crm", aiSearchVolume: 900 },
      { keyword: "seo", aiSearchVolume: 10 },
    ]);

    await generatePromptSet("project_1");

    expect(listKeywordIntents).toHaveBeenCalledWith("project_1", [
      "crm",
      "seo",
    ]);
  });

  it("applies the cached intent to the prompt it composes", async () => {
    listAiKeywordDemand.mockResolvedValue([
      { keyword: "crm software", aiSearchVolume: 900 },
    ]);
    listKeywordIntents.mockResolvedValue([
      { keyword: "crm software", intent: "commercial" },
    ]);

    const { prompts } = await generatePromptSet("project_1");
    expect(prompts).toEqual([
      {
        prompt: "best crm software",
        intent: "commercial",
        source: "keyword",
        aiSearchVolume: 900,
      },
    ]);
  });

  it("treats the keywords feature's `unknown` as unclassified, not as informational", async () => {
    // The mapping that only exists here. `unknown` means nobody classified it, so the
    // generator's fallback applies — it happens to be informational, and the
    // difference is that the *intent* recorded is the fallback rather than a claim
    // the classifier never made.
    listAiKeywordDemand.mockResolvedValue([
      { keyword: "vague", aiSearchVolume: 1 },
    ]);
    listKeywordIntents.mockResolvedValue([
      { keyword: "vague", intent: "unknown" },
    ]);

    const { prompts } = await generatePromptSet("project_1");
    expect(prompts[0]).toMatchObject({
      prompt: "what is vague",
      intent: "informational",
    });
  });

  it("reports the seed counts, because two empty drafts are not the same sentence", async () => {
    listAiKeywordDemand.mockResolvedValue([
      { keyword: "crm", aiSearchVolume: null },
    ]);
    listRecentArchivedPrompts.mockResolvedValue(["is acme reliable"]);

    const { prompts, seedCounts } = await generatePromptSet("project_1");
    expect(seedCounts).toEqual({ aiKeywords: 1, archivedPrompts: 1 });
    // Observed questions first, composed ones after — the generator's ordering, seen
    // through the service rather than only in its own test.
    expect(prompts.map((entry) => entry.source)).toEqual([
      "mention",
      "keyword",
    ]);
  });

  it("keeps no recorded demand as null all the way to the draft", async () => {
    listAiKeywordDemand.mockResolvedValue([
      { keyword: "crm", aiSearchVolume: null },
    ]);
    const { prompts } = await generatePromptSet("project_1");
    expect(prompts[0]?.aiSearchVolume).toBeNull();
  });
});
