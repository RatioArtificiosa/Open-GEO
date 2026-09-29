import { describe, expect, it } from "vitest";
import { buildVisibilityCard } from "./visibilityCard";
import type { LlmTargetMetrics } from "@/server/lib/dataforseoLlmSchemas";
import type { LlmPlatform } from "@/server/lib/dataforseo";

/**
 * The AI Visibility Checker card.
 *
 * The design constraint is that the headline is visible **with no signup**, which
 * makes this the worst possible place for a number we cannot defend: the visitor
 * has no way to check it and we have no relationship to lose. So the tests are
 * mostly about what the card refuses — a combined platform figure, a score, and
 * a confident headline when the query returned nothing.
 */

const metrics = (
  platform: Array<{ key: string; mentions: number; ai_search_volume: number }>,
  sources: Array<{ key: string; mentions: number }> = [],
): LlmTargetMetrics =>
  ({
    aggregated_metrics: {
      platform,
      sources_domain: sources,
    },
  }) as LlmTargetMetrics;

const build = (
  m: LlmTargetMetrics | null,
  requested: LlmPlatform[] = ["chat_gpt", "google"],
) => buildVisibilityCard({ domain: "acme.com", metrics: m, requested });

describe("buildVisibilityCard", () => {
  it("names a platform per figure and never combines them", () => {
    // "and" between two populations is how a reader starts treating them as one
    // number. A free visitor has no way to check a total, so a total is the number
    // most likely to be wrong and least likely to be caught.
    const card = build(
      metrics([
        { key: "chat_gpt", mentions: 120, ai_search_volume: 5000 },
        { key: "google", mentions: 40, ai_search_volume: 900000 },
      ]),
    );
    expect(card.headline).toMatch(/chat_gpt: 120 mentions/i);
    expect(card.headline).toMatch(/google: 40 mentions/i);
    // The mention total is the one cross-platform figure offered — a mention is a
    // mention, and no demand figure is summed.
    expect(card.totalMentions).toBe(160);
    for (const platform of card.platforms) {
      expect(platform).toHaveProperty("platform");
    }
  });

  it("gives every requested platform a row even when the query missed it", () => {
    // An absent row is indistinguishable from a platform we never asked about.
    const card = build(
      metrics([{ key: "chat_gpt", mentions: 120, ai_search_volume: 5000 }]),
    );
    expect(card.platforms).toHaveLength(2);
    expect(
      card.platforms.find((p) => p.platform === "google")?.mentions,
    ).toBeNull();
  });

  it("does not treat a zero as a missing figure", () => {
    // Zero is a finding — the brand is mentioned and never. Null means the
    // platform did not come back, and the two lead to opposite conclusions.
    const card = build(
      metrics([
        { key: "chat_gpt", mentions: 0, ai_search_volume: 0 },
        { key: "google", mentions: 40, ai_search_volume: 100 },
      ]),
    );
    expect(
      card.platforms.find((p) => p.platform === "chat_gpt")?.mentions,
    ).toBe(0);
    expect(card.totalMentions).toBe(40);
  });

  it("says plainly when the query found nothing", () => {
    // "No AI mentions" is a real answer about *this query*; reading it as a
    // verdict on the brand is the failure mode.
    const card = buildVisibilityCard({
      domain: "acme.com",
      metrics: null,
      requested: ["chat_gpt", "google"],
    });
    expect(card.headline).toMatch(/no AI mentions/i);
    expect(card.headline).toMatch(/only about this query/i);
    expect(card.totalMentions).toBeNull();
  });

  it("always states its own limits on the card", () => {
    // A free tool that hides what it cannot show is a marketing tool, and the
    // visitor is the one who cannot see the missing features.
    const card = build(metrics([]));
    expect(card.limits).toMatch(/no history, no competitor comparison/i);
    expect(card.limits).toMatch(/no score/i);
  });

  it("offers no score and no letter grade", () => {
    // One call has no baseline to score against (CL-136) and no history. A
    // headline number implying a comparison we cannot make is the thing this
    // product refuses everywhere else.
    const card = build(
      metrics([{ key: "chat_gpt", mentions: 9999, ai_search_volume: 1 }]),
    );
    for (const key of Object.keys(card)) {
      expect(key.toLowerCase()).not.toMatch(/score|grade|rating/);
    }
  });

  it("drops a citing row with no domain rather than showing a blank", () => {
    const card = build(
      metrics(
        [{ key: "chat_gpt", mentions: 10, ai_search_volume: 1 }],
        [
          { key: "reddit.com", mentions: 8 },
          { key: "", mentions: 99 },
        ],
      ),
    );
    expect(card.topCitedDomains.map((d) => d.domain)).toEqual(["reddit.com"]);
  });

  it("names a single dominant source as a fragility, matching the archive metric", () => {
    // The same reading `citation-authority.ts` gives: citations resting on one
    // source are a single point of failure.
    const card = build(
      metrics(
        [{ key: "chat_gpt", mentions: 10, ai_search_volume: 1 }],
        [{ key: "reddit.com", mentions: 9 }],
      ),
    );
    expect(card.nextStep).toMatch(/single point of failure/i);
  });

  it("advises checking crawlability when nothing cites the brand at all", () => {
    const card = build(
      metrics([{ key: "chat_gpt", mentions: 0, ai_search_volume: 0 }]),
    );
    expect(card.nextStep).toMatch(/llms\.txt/i);
    expect(card.nextStep).toMatch(/crawler/i);
  });

  it("says when it has no advice rather than inventing some", () => {
    // Mentioned, but no source returned: the honest answer names the missing
    // feature instead of guessing.
    const card = build(
      metrics([{ key: "chat_gpt", mentions: 5, ai_search_volume: 1 }]),
    );
    expect(card.nextStep).toMatch(/citation archive/i);
  });

  it("returns no next step at all when the query returned nothing", () => {
    const card = buildVisibilityCard({
      domain: "acme.com",
      metrics: null,
      requested: ["chat_gpt"],
    });
    expect(card.nextStep).toBeNull();
  });
});
