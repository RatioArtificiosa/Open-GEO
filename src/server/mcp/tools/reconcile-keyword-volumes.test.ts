import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { reconcileKeywordVolumesTool } from "./reconcile-keyword-volumes";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
  fetchKeywordMetricsForList: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));

vi.mock("@/server/lib/dataforseo/keyword-metrics", () => ({
  fetchKeywordMetricsForList: mocks.fetchKeywordMetricsForList,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

// Parsed rather than asserted: the wire shape is the contract, so a drifting field is a
// failure here instead of a silent `undefined` in an assertion.
const structured = (result: { structuredContent?: unknown }) =>
  z
    .object({
      summary: z
        .object({
          total: z.number(),
          corroborated: z.number(),
          measuredHigher: z.number(),
          measuredLower: z.number(),
          uncomparable: z.number(),
          corroborationRate: z.number().nullable(),
        })
        .passthrough(),
      rows: z.array(
        z.object({
          keyword: z.string(),
          countryVolume: z.number().nullable(),
          globalVolume: z.number().nullable(),
          verdict: z.string(),
          note: z.string(),
        }),
      ),
    })
    .passthrough()
    .parse(result.structuredContent);

describe("reconcile_keyword_volumes", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.fetchKeywordMetricsForList.mockResolvedValue([
      { keyword: "plumber", searchVolume: 1_000 },
      { keyword: "emergency plumber", searchVolume: 1_000 },
    ]);
    mocks.createDataforseoClient.mockReturnValue({
      keywords: {
        clickstreamVolumes: vi.fn().mockResolvedValue([
          {
            keyword: "plumber",
            globalVolume: 900_000,
            countryDistribution: [
              { countryIsoCode: "US", searchVolume: 1_050, percentage: 12 },
            ],
          },
          {
            keyword: "emergency plumber",
            globalVolume: 400_000,
            countryDistribution: [
              { countryIsoCode: "US", searchVolume: 2_600, percentage: 21 },
            ],
          },
        ]),
      },
    });
  });

  it("compares each keyword against the country figure, not the global one", async () => {
    const result = await reconcileKeywordVolumesTool.handler(
      {
        projectId: "project_1",
        keywords: ["plumber", "emergency plumber"],
        countryIsoCode: "US",
      },
      toolContext,
    );

    const { rows } = structured(result);
    // `plumber` agrees (1,050 against 1,000) even though its global figure is 900,000 —
    // which is the whole point of reading the country split.
    expect(rows[0]).toMatchObject({
      keyword: "plumber",
      countryVolume: 1_050,
      globalVolume: 900_000,
      verdict: "corroborated",
    });
    expect(rows[1]).toMatchObject({
      keyword: "emergency plumber",
      countryVolume: 2_600,
      verdict: "measured-higher",
    });
    expect(structured(result).summary).toMatchObject({
      total: 2,
      corroborated: 1,
      measuredHigher: 1,
      corroborationRate: 0.5,
    });
  });

  it("spends one clickstream request for the batch, not one per keyword", async () => {
    const clickstreamVolumes = vi.fn().mockResolvedValue([]);
    mocks.createDataforseoClient.mockReturnValue({
      keywords: { clickstreamVolumes },
    });

    await reconcileKeywordVolumesTool.handler(
      {
        projectId: "project_1",
        keywords: ["a keyword", "b keyword"],
        countryIsoCode: "US",
      },
      toolContext,
    );

    // The endpoint is billed per call, so batching is what makes this affordable. The
    // two keywords travel together.
    expect(clickstreamVolumes).toHaveBeenCalledTimes(1);
    expect(clickstreamVolumes).toHaveBeenCalledWith({
      keywords: ["a keyword", "b keyword"],
    });
  });

  it("defaults the market from the project, including the label that is not an ISO code", async () => {
    // Britain is the single divergence between the picker's labels and ISO-3166: the label is
    // `UK` and the code is `GB`. The breakdown is keyed by ISO, so without that translation
    // every British keyword would come back `uncomparable` — honest, but useless, and it would
    // read like a vendor limitation rather than a missing line of code.
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2826,
      languageCode: "en",
    });
    mocks.fetchKeywordMetricsForList.mockResolvedValue([
      { keyword: "plumber", searchVolume: 1_000 },
    ]);
    mocks.createDataforseoClient.mockReturnValue({
      keywords: {
        clickstreamVolumes: vi.fn().mockResolvedValue([
          {
            keyword: "plumber",
            globalVolume: 900_000,
            countryDistribution: [
              { countryIsoCode: "GB", searchVolume: 1_050, percentage: 12 },
            ],
          },
        ]),
      },
    });

    const result = await reconcileKeywordVolumesTool.handler(
      // No countryIsoCode passed: the project's own market has to supply it.
      { projectId: "project_1", keywords: ["plumber"] },
      toolContext,
    );

    expect(structured(result).summary.corroborated).toBe(1);
    expect(textContent(result)).toMatch(/measured volume for GB/);
  });

  it("says plainly when nothing could be checked instead of implying agreement", async () => {
    mocks.createDataforseoClient.mockReturnValue({
      keywords: {
        clickstreamVolumes: vi.fn().mockResolvedValue([
          // A breakdown with no GB entry, which is what a UK project would hit.
          {
            keyword: "plumber",
            globalVolume: 900_000,
            countryDistribution: [
              { countryIsoCode: "US", searchVolume: 1_050, percentage: 12 },
            ],
          },
        ]),
      },
    });
    mocks.fetchKeywordMetricsForList.mockResolvedValue([
      { keyword: "plumber", searchVolume: 1_000 },
    ]);

    const result = await reconcileKeywordVolumesTool.handler(
      { projectId: "project_1", keywords: ["plumber"], countryIsoCode: "GB" },
      toolContext,
    );

    expect(structured(result).summary.corroborationRate).toBeNull();
    expect(structured(result).rows[0]?.note).toMatch(/no figure for GB/);
    // The honest headline: a run that could not check anything claims nothing, rather
    // than reading as "no disagreements found".
    expect(textContent(result)).toMatch(
      /No volume could be checked against GB/,
    );
    expect(textContent(result)).toMatch(/makes no claim about them/);
  });
});
