import { describe, expect, it } from "vitest";
import { normalisePrompt } from "@/shared/prompt-normalisation";
import {
  buildPromptSet,
  DEFAULT_MAX_PROMPTS,
  type PromptSeedKeyword,
} from "./promptSetGenerator";

const keyword = (
  name: string,
  intent: PromptSeedKeyword["intent"],
  aiSearchVolume: number | null = null,
): PromptSeedKeyword => ({ keyword: name, intent, aiSearchVolume });

const build = (input: {
  mentionQuestions?: string[];
  keywords?: PromptSeedKeyword[];
  maxPrompts?: number;
}) =>
  buildPromptSet({
    mentionQuestions: input.mentionQuestions ?? [],
    keywords: input.keywords ?? [],
    maxPrompts: input.maxPrompts,
  });

describe("the prompt-set generator", () => {
  it("keeps a mention question verbatim, and first", () => {
    // The only observed language in the set. Rewriting it would replace evidence
    // with a template, and the vendor already asked this exact question.
    const set = build({
      mentionQuestions: ["Is OpenGeo worth switching to?"],
      keywords: [keyword("geo tools", "commercial", 900)],
    });
    expect(set[0]).toEqual({
      prompt: "Is OpenGeo worth switching to?",
      intent: "informational",
      source: "mention",
      aiSearchVolume: null,
    });
    expect(set[1]?.source).toBe("keyword");
  });

  it("poses each intent's question form", () => {
    const set = build({
      keywords: [
        keyword("technical seo", "informational"),
        keyword("ai visibility tools", "commercial"),
        keyword("rank tracking", "transactional"),
        keyword("opengeo", "navigational"),
      ],
    });
    expect(set.map((entry) => entry.prompt)).toEqual([
      "best ai visibility tools",
      "opengeo reviews",
      "rank tracking pricing",
      "what is technical seo",
    ]);
    expect(set.map((entry) => entry.intent)).toEqual([
      "commercial",
      "navigational",
      "transactional",
      "informational",
    ]);
  });

  it("asks the safest question when nothing classified a keyword", () => {
    // An unclassified topic still becomes a prompt: the alternative is a topic with
    // AI demand and no question, which is the gap this generator exists to close.
    const set = build({ keywords: [keyword("answer engine", null, 40)] });
    expect(set).toEqual([
      {
        prompt: "what is answer engine",
        intent: "informational",
        source: "keyword",
        aiSearchVolume: 40,
      },
    ]);
  });

  it("drops a composed question that duplicates an observed one", () => {
    // Same question, two sources: the mention is the better entry, and the run
    // would ask it once either way.
    const set = build({
      mentionQuestions: ["best ai visibility tools"],
      keywords: [keyword("ai visibility tools", "commercial", 500)],
    });
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({
      source: "mention",
      prompt: "best ai visibility tools",
    });
  });

  it("treats case, padding and inner runs of whitespace as one question", () => {
    // Two rows in the editor and one question posted reads as a bug, and the run
    // bills per prompt.
    expect(normalisePrompt("  Best   AI  Tools ")).toBe("best ai tools");
    const set = build({
      mentionQuestions: ["best ai tools", "  BEST   ai tools  "],
      keywords: [keyword("best ai tools", "commercial", 10)],
    });
    expect(set).toHaveLength(1);
    expect(set[0]?.prompt).toBe("best ai tools");
  });

  it("collapses a mention's line breaks, because a prompt is one line", () => {
    const set = build({ mentionQuestions: ["what is GEO?\n\nand why"] });
    expect(set[0]?.prompt).toBe("what is GEO? and why");
  });

  it("ranks measured demand above no data, then by demand, then by name", () => {
    const set = build({
      keywords: [
        keyword("no data", "informational", null),
        keyword("small", "informational", 5),
        keyword("big", "informational", 500),
        keyword("zeta tie", "informational", 5),
        keyword("alpha tie", "informational", 5),
      ],
    });
    expect(set.map((entry) => entry.aiSearchVolume)).toEqual([
      500,
      5,
      5,
      5,
      null,
    ]);
    // The two 5s and the 5th entry tie; the name breaks it, so the set is stable.
    expect(set.map((entry) => entry.prompt)).toEqual([
      "what is big",
      "what is alpha tie",
      "what is small",
      "what is zeta tie",
      "what is no data",
    ]);
  });

  it("keeps no-data as null, never as a zero", () => {
    // "no recorded demand" and "recorded zero demand" are different facts, and the
    // editor shows the value.
    const set = build({
      keywords: [keyword("unknown topic", "informational", null)],
    });
    expect(set[0]?.aiSearchVolume).toBeNull();
    expect(JSON.stringify(set[0])).not.toContain('"aiSearchVolume":0');
  });

  it("does not double a keyword that is already the question", () => {
    // The first version produced **"best best ai tools"**. A test caught it, and the
    // fix is pinned here: a set full of doubled words is a set nobody saves.
    const set = build({
      keywords: [
        keyword("best ai tools", "commercial", 3),
        keyword("rank tracking pricing", "transactional", 2),
        keyword("acme reviews", "navigational", 1),
        keyword("what is GEO", "informational", 0),
      ],
    });
    expect(set.map((entry) => entry.prompt)).toEqual([
      "best ai tools",
      "rank tracking pricing",
      "acme reviews",
      "what is GEO",
    ]);
  });

  it("caps the set, and the cap keeps the demand", () => {
    const set = build({
      maxPrompts: 2,
      mentionQuestions: ["keep me"],
      keywords: [
        keyword("low", "informational", 1),
        keyword("high", "informational", 1000),
        keyword("mid", "informational", 500),
      ],
    });
    expect(set).toHaveLength(2);
    expect(set.map((entry) => entry.prompt)).toEqual([
      "keep me",
      "what is high",
    ]);
  });

  it("uses the documented default when no cap is given", () => {
    const many = Array.from({ length: DEFAULT_MAX_PROMPTS + 10 }, (_, i) =>
      keyword(`topic ${i}`, "informational", 100 - i),
    );
    expect(build({ keywords: many })).toHaveLength(DEFAULT_MAX_PROMPTS);
  });

  it("returns nothing for a cap of zero or less, without throwing", () => {
    expect(
      build({
        maxPrompts: 0,
        mentionQuestions: ["x"],
        keywords: [keyword("y", null, 1)],
      }),
    ).toEqual([]);
    expect(build({ maxPrompts: -1, mentionQuestions: ["x"] })).toEqual([]);
  });

  it("ignores blank seeds and a blank mention", () => {
    const set = build({
      mentionQuestions: ["   ", ""],
      keywords: [
        keyword("  ", "informational", 5),
        keyword("real", "informational", 1),
      ],
    });
    expect(set.map((entry) => entry.prompt)).toEqual(["what is real"]);
  });

  it("returns an empty set for no seeds at all", () => {
    // An empty project is the common first case, and the editor says so rather than
    // the generator inventing a starting set.
    expect(build({})).toEqual([]);
  });
});
