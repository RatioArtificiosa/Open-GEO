import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Values passed to `.values()`, captured so the write can be asserted without a database.
 * `vi.hoisted` because `vi.mock` is hoisted above every const in this file: a plain
 * `const` here is undefined when the factory runs, and the whole file fails to load rather
 * than reporting a failed test.
 */
const written = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// `@/db/schema` must be mocked too, not just `@/db`: the provider-aware barrel imports
// `cloudflare:workers` and cannot load under vitest, so importing it for real fails the file.
vi.mock("@/db/schema", () => ({ keywordOpportunityInputs: {} }));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          written.push(values);
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  },
}));

import {
  KeywordOpportunityInputsRepository,
  type OpportunityInputPoint,
} from "@/server/features/domain/repositories/KeywordOpportunityInputsRepository";

const base: Omit<OpportunityInputPoint, "languageCode"> = {
  projectId: "proj-1",
  keyword: "Best CRM",
  locationCode: 2840,
  keywordDifficulty: null,
  serpCompetitors: null,
  intent: null,
  aiNativeRatioBp: null,
  rankElasticityBp: null,
  scoreModelVersion: "1.0.0",
  requestedAt: "2026-10-08T02:00:00.000Z",
};

beforeEach(() => {
  written.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("KeywordOpportunityInputsRepository.insertPoint", () => {
  it("normalises the keyword, because the series promises it cannot fork on casing", async () => {
    await KeywordOpportunityInputsRepository.insertPoint(base);
    expect(written[0]?.keyword).toBe("best crm");
  });

  it("defaults the language rather than storing nothing, so a row is always readable", async () => {
    await KeywordOpportunityInputsRepository.insertPoint(base);
    expect(written[0]?.languageCode).toBe("en");
  });

  it("refuses an unstamped measurement before the insert, so the failure names the reason", async () => {
    await expect(
      KeywordOpportunityInputsRepository.insertPoint({
        ...base,
        scoreModelVersion: "  ",
      }),
    ).rejects.toThrow(/refuses to store a measurement with no model version/);
    expect(written).toHaveLength(0);
  });

  it("refuses an empty keyword rather than writing a row nothing can find again", async () => {
    await expect(
      KeywordOpportunityInputsRepository.insertPoint({
        ...base,
        keyword: "   ",
      }),
    ).rejects.toThrow(/needs a keyword/);
    expect(written).toHaveLength(0);
  });

  it("stores a null input as null, never as zero, so unmeasured cannot be read as measured", async () => {
    // The model's competitorEase(0) treats zero as a data gap precisely because a null here would
    // otherwise have been written as 0 by a careless default.
    await KeywordOpportunityInputsRepository.insertPoint(base);
    expect(written[0]?.keywordDifficulty).toBeNull();
    expect(written[0]?.serpCompetitors).toBeNull();
    expect(written[0]?.intent).toBeNull();
  });
});

describe("KeywordOpportunityInputsRepository.seriesFor", () => {
  it("returns the stored history for a keyword, normalised the same way on read as on write", async () => {
    const rows = await KeywordOpportunityInputsRepository.seriesFor({
      projectId: "proj-1",
      keyword: "Best CRM",
      locationCode: 2840,
    });
    expect(rows).toEqual([]);
  });
});
