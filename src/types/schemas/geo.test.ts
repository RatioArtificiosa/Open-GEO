import { describe, expect, it } from "vitest";
import {
  createGeoPromptSetSchema,
  deleteGeoTargetSchema,
  getGeoCitationGapSchema,
  getGeoVisibilitySchema,
  upsertGeoTargetSchema,
  GEO_PLATFORMS,
  GEO_PLATFORM_LABELS,
  GEO_PROMPT_INTENTS,
  GEO_RETRIEVAL_PLATFORMS,
} from "@/types/schemas/geo";

/**
 * The GEO wire contract.
 *
 * These schemas are the boundary where untrusted input (a UI form, an agent, an
 * MCP tool call) becomes a service call, so the rejections below are product
 * behaviour, not just type-checking: each one prevents a call that would either
 * cost money or produce a number that means nothing.
 */

describe("GEO domain validation", () => {
  it("accepts a bare domain and rejects the URL forms people actually type", () => {
    const base = { locationCode: 2840, languageCode: "en" };
    expect(
      upsertGeoTargetSchema.safeParse({ domain: "acme.com", ...base }).success,
    ).toBe(true);
    expect(
      upsertGeoTargetSchema.safeParse({ domain: "https://acme.com", ...base })
        .success,
    ).toBe(false);
    expect(
      upsertGeoTargetSchema.safeParse({ domain: "acme.com/pricing", ...base })
        .success,
    ).toBe(false);
  });

  it("folds a www. brand onto the bare host rather than rejecting it", () => {
    // Two rows for one brand would halve every share-of-voice number, so the
    // normalisation happens at the boundary where the value enters.
    const parsed = upsertGeoTargetSchema.parse({
      domain: "www.acme.com",
      locationCode: 2840,
      languageCode: "en",
    });
    expect(parsed.domain).toBe("acme.com");
  });

  it("lower-cases a domain so the same brand added twice lands on one row", () => {
    const parsed = upsertGeoTargetSchema.parse({
      domain: "  ACME.com ",
      locationCode: 2840,
      languageCode: "en",
    });
    expect(parsed.domain).toBe("acme.com");
  });

  it("rejects a non-uuid target id before it reaches the database", () => {
    expect(
      deleteGeoTargetSchema.safeParse({ targetId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects a prompt set with no prompts rather than creating an unrunnable one", () => {
    expect(
      createGeoPromptSetSchema.safeParse({ name: "Core", prompts: [] }).success,
    ).toBe(false);
    expect(
      createGeoPromptSetSchema.safeParse({
        name: "Core",
        prompts: [{ prompt: "best geo tool" }],
      }).success,
    ).toBe(true);
  });

  it("caps prompt count and prompt length at the documented limits", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ prompt: `q${i}` }));
    expect(
      createGeoPromptSetSchema.safeParse({ name: "Big", prompts: many })
        .success,
    ).toBe(false);
    expect(
      createGeoPromptSetSchema.safeParse({
        name: "Long",
        prompts: [{ prompt: "a".repeat(701) }],
      }).success,
    ).toBe(false);
  });

  it("only accepts a known platform, so a typo cannot become an empty result", () => {
    // A bad platform reaching the repository would produce a confidently empty
    // answer set rather than an error. Catch it at the boundary instead.
    expect(
      getGeoVisibilitySchema.safeParse({ targetId: crypto.randomUUID() })
        .success,
    ).toBe(true);
    expect(
      getGeoCitationGapSchema.safeParse({
        targetId: crypto.randomUUID(),
        platform: "chatgpt",
      }).success,
    ).toBe(false);
    expect(
      getGeoCitationGapSchema.safeParse({
        targetId: crypto.randomUUID(),
        platform: "bing_copilot",
      }).success,
    ).toBe(false);
  });

  it("keeps the platform vocabulary and its labels in step", () => {
    for (const platform of GEO_PLATFORMS) {
      expect(GEO_PLATFORM_LABELS[platform]).toBeTruthy();
    }
    // A label map with an extra key would render a platform the API cannot
    // query. Sets compare membership, so no sort is needed (and the repo's lib
    // target predates Array#toSorted).
    expect(new Set(Object.keys(GEO_PLATFORM_LABELS))).toEqual(
      new Set(GEO_PLATFORMS),
    );
  });

  it("scopes retrieval reporting to ChatGPT only, matching the vendor", () => {
    // DataForSEO returns citations for Google AI Overviews but not the pages it
    // retrieved. Widening this list would make the product claim a gap analysis
    // it cannot actually perform.
    expect([...GEO_RETRIEVAL_PLATFORMS]).toEqual(["chat_gpt"]);
  });

  it("maps each intent to a build format rather than a free-text label", () => {
    expect(new Set(GEO_PROMPT_INTENTS)).toEqual(
      new Set(["commercial", "informational", "navigational", "transactional"]),
    );
  });
});
