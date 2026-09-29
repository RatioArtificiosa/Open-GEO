import { describe, expect, it } from "vitest";
import { computeSovMatrix, type SovMatrix } from "./sovMatrix";
import type { CrossOutcome } from "./shareOfVoice";
import type { LlmPlatform } from "@/server/lib/dataforseo";

/**
 * The share-of-voice matrix.
 *
 * The interesting property is what it refuses. A matrix is the most tempting
 * place in this product to show one big number — a row total, a "market share"
 * column — and every one of those would be either a 198×-wrong sum or a claim
 * about a platform that failed.
 *
 * The tests are therefore mostly about the refusals: null cells, missing
 * platforms, and brands nobody has data on.
 */

const ok = (
  platform: LlmPlatform,
  rows: Record<string, number | null>,
): CrossOutcome => ({
  platform,
  status: "success",
  items: Object.entries(rows).map(([key, mentions]) => ({
    key,
    platform: [{ key: platform, mentions, ai_search_volume: null }],
  })),
});

const failed = (platform: LlmPlatform): CrossOutcome => ({
  platform,
  status: "error",
  items: [],
});

const build = (
  outcomes: CrossOutcome[],
  attempted: LlmPlatform[],
  competitors = ["rival.com"],
): SovMatrix =>
  computeSovMatrix({
    outcomes,
    targetValue: "acme.com",
    competitors,
    attemptedPlatforms: attempted,
  });

const cellOf = (matrix: SovMatrix, label: string, platform: string) => {
  const row = matrix.rows.find((r) => r.label === label);
  return row?.cells[platform];
};

describe("computeSovMatrix", () => {
  it("computes each share against that platform's own total", () => {
    // Acme has 30 on ChatGPT and 5 on Google; rivals have 70 and 95. Both shares
    // are 30% — but they come from completely different denominators, and a
    // matrix that divided by a cross-platform total would report something else.
    const matrix = build(
      [
        ok("chat_gpt", { "acme.com": 30, "rival.com": 70 }),
        ok("google", { "acme.com": 5, "rival.com": 95 }),
      ],
      ["chat_gpt", "google"],
    );
    expect(cellOf(matrix, "acme.com", "chat_gpt")?.sharePct).toBeCloseTo(30, 5);
    expect(cellOf(matrix, "acme.com", "google")?.sharePct).toBeCloseTo(5, 5);
  });

  it("gives a failed platform a null cell, not a zero", () => {
    // ChatGPT at 100% because Google failed is "the only platform we could
    // measure", not "you own Google". A zero would be a claim about a platform
    // nobody asked.
    const matrix = build(
      [ok("chat_gpt", { "acme.com": 30, "rival.com": 70 }), failed("google")],
      ["chat_gpt", "google"],
    );
    const acmeGoogle = cellOf(matrix, "acme.com", "google");
    expect(acmeGoogle?.mentions).toBeNull();
    expect(acmeGoogle?.sharePct).toBeNull();
    expect(matrix.unavailablePlatforms).toEqual(["google"]);
    expect(matrix.measuredPlatforms).toEqual(["chat_gpt"]);
  });

  it("names the platforms it could not measure, in the summary", () => {
    const matrix = build(
      [ok("chat_gpt", { "acme.com": 30, "rival.com": 70 }), failed("google")],
      ["chat_gpt", "google"],
    );
    // Without this the reader sees a total that silently covers one platform and
    // assumes it covers both.
    expect(matrix.summary).toMatch(/not measured: google/i);
    expect(matrix.summary).toMatch(/only the platforms we could read/i);
  });

  it("keeps a brand nobody has data on as a row of nulls", () => {
    const matrix = build(
      [ok("chat_gpt", { "acme.com": 30 })],
      ["chat_gpt"],
      ["ghost.com"],
    );
    const ghost = matrix.rows.find((r) => r.label === "ghost.com");
    expect(ghost).toBeDefined();
    expect(ghost?.cells.chat_gpt.mentions).toBeNull();
    expect(ghost?.cells.chat_gpt.sharePct).toBeNull();
    expect(ghost?.totalMentions).toBeNull();
  });

  it("orders the target first and unknown-total brands last", () => {
    const matrix = build(
      [ok("chat_gpt", { "acme.com": 1, "rival.com": 90, "ghost.com": null })],
      ["chat_gpt"],
      ["rival.com", "ghost.com"],
    );
    // A brand we could not measure must not outrank one we could, or the
    // leaderboard implies a ranking we did not compute.
    expect(matrix.rows[0]?.label).toBe("acme.com");
    expect(matrix.rows.at(-1)?.label).toBe("ghost.com");
  });

  it("totals mentions across platforms, and only mentions", () => {
    // Mentions have the same unit on both platforms, so the row total is
    // meaningful. Demand does not, so no demand total exists anywhere in this
    // shape — and a test asserts the absence.
    const matrix = build(
      [
        ok("chat_gpt", { "acme.com": 30, "rival.com": 70 }),
        ok("google", { "acme.com": 5, "rival.com": 95 }),
      ],
      ["chat_gpt", "google"],
    );
    const acme = matrix.rows.find((r) => r.label === "acme.com");
    expect(acme?.totalMentions).toBe(35);
    for (const key of Object.keys(acme ?? {})) {
      expect(key.toLowerCase()).not.toMatch(/volume|demand/i);
    }
  });

  it("says so when every comparison failed", () => {
    const matrix = build(
      [failed("chat_gpt"), failed("google")],
      ["chat_gpt", "google"],
    );
    // An empty matrix with no explanation reads as "you have no share", which is
    // a finding. It is not one.
    expect(matrix.summary).toMatch(/not a zero share/i);
  });

  it("never sums a provider key we did not request", () => {
    // The provider echoes aggregation keys. An unexpected one must not widen the
    // set the percentages are computed over — that would silently lower every
    // share in the matrix.
    const matrix = build(
      [
        {
          platform: "chat_gpt",
          status: "success",
          items: [
            {
              key: "acme.com",
              platform: [
                { key: "chat_gpt", mentions: 10, ai_search_volume: null },
              ],
            },
            {
              key: "surprise.com",
              platform: [
                { key: "chat_gpt", mentions: 999, ai_search_volume: null },
              ],
            },
          ],
        },
      ],
      ["chat_gpt"],
      [],
    );
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]?.totalMentions).toBe(10);
  });

  it("de-duplicates a competitor that collides with the target", () => {
    // The same domain in both lists is one brand, and a second row would be a
    // wasted paid comparison slot.
    const matrix = build(
      [ok("chat_gpt", { "acme.com": 10 })],
      ["chat_gpt"],
      ["ACME.com", "rival.com"],
    );
    const labels = matrix.rows.map((r) => r.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("acme.com");
    expect(labels).toContain("rival.com");
  });
});
