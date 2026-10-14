import { beforeEach, describe, expect, it } from "vitest";
import {
  callTool,
  getVisibility,
  listTargets,
  TARGET,
  textOf,
} from "./geo-tools-test-support";

/**
The GEO archive tools' honesty contract.

These tools read the archive, so they cost nothing — which means the only way
they can mislead a paying user is by saying something false. So the tests are
about the words, not the plumbing: no combined platform number, and no implying
a capability the vendor does not have.
 */

const { getGeoVisibilityTool, listGeoTargetsTool } =
  await import("@/server/mcp/tools/geo-read-tools");

describe("list_geo_targets", () => {
  it("tells the user how to start when nothing is monitored", async () => {
    listTargets.mockResolvedValue([]);
    const result = await callTool(listGeoTargetsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/no brands are being monitored/i);
  });

  it("names the market for each target, since it is part of the identity", async () => {
    listTargets.mockResolvedValue([
      { ...TARGET, locationCode: 2840, languageCode: "en" },
    ]);
    const result = await callTool(listGeoTargetsTool, { projectId: "p1" });
    expect(textOf(result)).toMatch(/2840\/en/);
  });
});

describe("get_geo_visibility", () => {
  beforeEach(() => {
    listTargets.mockResolvedValue([TARGET]);
  });

  it("reports each platform separately and says they must not be summed", async () => {
    getVisibility.mockResolvedValue({
      target: TARGET,
      since: "2026-08-30T00:00:00.000Z",
      perPlatform: [
        { platform: "chat_gpt", mentions: 12, recent: [] },
        { platform: "google_ai_overview", mentions: 40, recent: [] },
      ],
    });
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "acme.com",
    });
    const text = textOf(result);
    // The 198x trap: these two numbers are not the same unit.
    expect(text).toMatch(/not summed across platforms/i);
    expect(result.structuredContent?.perPlatform).toHaveLength(2);
  });

  it("explains an unmonitored domain instead of failing opaquely", async () => {
    listTargets.mockResolvedValue([]);
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "other.com",
    });
    expect(textOf(result)).toMatch(/not a monitored target/i);
  });

  it("accepts a pasted URL, since that is what people type", async () => {
    listTargets.mockResolvedValue([TARGET]);
    getVisibility.mockResolvedValue({
      target: TARGET,
      since: "2026-08-30T00:00:00.000Z",
      perPlatform: [],
    });
    const result = await callTool(getGeoVisibilityTool, {
      projectId: "p1",
      domain: "https://www.acme.com/pricing",
    });
    // It resolved to the target rather than reporting "not monitored".
    expect(textOf(result)).not.toMatch(/not a monitored target/i);
  });
});
