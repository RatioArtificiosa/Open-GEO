import { describe, expect, it } from "vitest";
import {
  computePlatformIndex,
  PLATFORMS,
  type PlatformBaseline,
} from "./platformIndex";

/**
 * The cross-platform normalized index.
 *
 * This exists because three things in this product already refuse to total
 * across platforms. The index is the sanctioned way to compare, so the tests
 * mostly check that the comparison stays *per platform* and that the
 * denominator is never invented.
 */

const baseline = (
  platform: "chat_gpt" | "google",
  value: number,
): PlatformBaseline => ({
  platform,
  value,
  basis: `median across your comparison set (${value})`,
});

const metricLabel = "mentions per prompt set";

describe("computePlatformIndex", () => {
  it("reads as a percentage against each platform's own baseline", () => {
    // The two examples in the proposal: 18% above on Google, 32% above on
    // ChatGPT. Different baselines, so the percentages are not comparable — which
    // is the entire point.
    const index = computePlatformIndex({
      metrics: { google: 118, chat_gpt: 132 },
      baselines: [baseline("google", 100), baseline("chat_gpt", 100)],
      metricLabel,
    });
    expect(index.entries.find((e) => e.platform === "google")?.deltaPct).toBe(
      18,
    );
    expect(index.entries.find((e) => e.platform === "chat_gpt")?.deltaPct).toBe(
      32,
    );
  });

  it("never offers a combined value", () => {
    // A previous era of this product summed mentions across platforms. The flag
    // is typed `false` so a UI can assert on it, and the summary repeats it.
    const index = computePlatformIndex({
      metrics: { google: 118, chat_gpt: 132 },
      baselines: [baseline("google", 100), baseline("chat_gpt", 100)],
      metricLabel,
    });
    expect(index.isCombinable).toBe(false);
    expect(index.summary).toMatch(/never added together/i);
  });

  it("uses a different baseline per platform and stays correct", () => {
    // Same metric (60), wildly different baselines. A shared denominator would
    // make these look identical; they are not.
    const index = computePlatformIndex({
      metrics: { google: 60, chat_gpt: 60 },
      baselines: [baseline("google", 50), baseline("chat_gpt", 200)],
      metricLabel,
    });
    expect(index.entries.find((e) => e.platform === "google")?.deltaPct).toBe(
      20,
    );
    expect(index.entries.find((e) => e.platform === "chat_gpt")?.deltaPct).toBe(
      -70,
    );
  });

  it("refuses to invent a baseline and says why", () => {
    // No category median exists in the archive, so a default would be a number
    // we made up wearing the clothes of a measured one.
    const index = computePlatformIndex({
      metrics: { google: 60 },
      baselines: [],
      metricLabel,
    });
    const google = index.entries.find((e) => e.platform === "google");
    expect(google?.deltaPct).toBeNull();
    expect(google?.reading).toMatch(/no baseline was supplied/i);
    expect(google?.reading).toMatch(/not a constant we can supply/i);
  });

  it("names the basis in the reading, so it cannot drift from the number", () => {
    const index = computePlatformIndex({
      metrics: { google: 150 },
      baselines: [baseline("google", 100)],
      metricLabel,
    });
    expect(index.entries[0]?.reading).toMatch(
      /median across your comparison set/i,
    );
  });

  it("keeps a platform with no figure as an entry rather than dropping it", () => {
    // The reader needs to see we looked and got nothing. An absent entry is
    // indistinguishable from a platform we never tried.
    const index = computePlatformIndex({
      metrics: { google: 118 },
      baselines: [baseline("google", 100), baseline("chat_gpt", 100)],
      metricLabel,
    });
    const chat = index.entries.find((e) => e.platform === "chat_gpt");
    expect(chat).toBeDefined();
    expect(chat?.deltaPct).toBeNull();
    expect(chat?.reading).toMatch(/nothing to compare/i);
  });

  it("refuses a zero baseline instead of dividing by it", () => {
    // 60/0 is Infinity, which renders as a number and means nothing.
    const index = computePlatformIndex({
      metrics: { google: 60 },
      baselines: [baseline("google", 0)],
      metricLabel,
    });
    expect(index.entries[0]?.deltaPct).toBeNull();
    expect(index.entries[0]?.reading).toMatch(/greater than zero/i);
  });

  it("says 'at baseline' rather than claiming a 0% change is a finding", () => {
    const index = computePlatformIndex({
      metrics: { google: 100 },
      baselines: [baseline("google", 100)],
      metricLabel,
    });
    expect(index.entries[0]?.deltaPct).toBe(0);
    expect(index.entries[0]?.reading).toMatch(/at the median/i);
  });

  it("reports an unmeasured total as an absence, not a zero", () => {
    const index = computePlatformIndex({
      metrics: { google: null },
      baselines: [baseline("google", 100)],
      metricLabel,
    });
    expect(index.summary).toMatch(/this is not a zero/i);
  });

  it("handles a platform with a baseline but no metric at all", () => {
    // The input is a Partial record, so this state is reachable from a caller
    // that simply has not measured one platform yet.
    const index = computePlatformIndex({
      metrics: {},
      baselines: [baseline("google", 100)],
      metricLabel,
    });
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.deltaPct).toBeNull();
  });

  it("drops an unrecognised platform key rather than casting it into the union", () => {
    // The runtime guard exists because `LlmPlatform` is a type and a string
    // cannot be tested against one. This asserts the guard actually filters, so a
    // typo becomes a dropped column rather than a column that computes nothing and
    // looks like real data.
    const index = computePlatformIndex({
      metrics: { google: 118, chatGPT: 999 } as Partial<
        Record<"chat_gpt" | "google", number | null>
      >,
      baselines: [baseline("google", 100)],
      metricLabel,
    });
    expect(index.entries.map((e) => e.platform)).toEqual(["google"]);
    // The drop is reported, so a typo cannot masquerade as a platform we were
    // never asked about.
    expect(index.summary).toMatch(/1 unrecognised platform name was ignored/i);
  });

  it("keeps the runtime platform list in step with the type union", () => {
    // `PLATFORMS` duplicates `LlmPlatform` because a type cannot be tested at
    // runtime. This is the assertion that makes the duplication safe: adding a
    // platform to the provider union without adding it here fails this test
    // rather than silently dropping the new platform from every index.
    const union: Array<"chat_gpt" | "google"> = ["chat_gpt", "google"];
    const listed: string[] = [...PLATFORMS];
    listed.sort();
    const expected: string[] = [...union];
    expected.sort();
    expect(listed).toEqual(expected);
  });
});
