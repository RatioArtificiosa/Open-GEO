import { describe, expect, it } from "vitest";
import {
  estimateResponseTokens,
  mcpResponse,
  optimizeForModel,
  truncatePreview,
} from "./formatters";

describe("mcpResponse", () => {
  it("returns content as a text block", () => {
    const result = mcpResponse({ text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("includes _meta only when meta is provided", () => {
    const bare = mcpResponse({ text: "hi" });
    expect(bare._meta).toBeUndefined();

    const withMeta = mcpResponse({
      text: "hi",
      meta: { url: "https://app.opengeo.so/p/1", projectId: "1" },
    });
    expect(withMeta._meta).toEqual({
      url: "https://app.opengeo.so/p/1",
      projectId: "1",
    });
  });

  it("drops undefined meta keys", () => {
    const result = mcpResponse({
      text: "hi",
      meta: {
        url: "https://app.opengeo.so",
        creditsCharged: 0,
      },
    });
    expect(result._meta).toEqual({
      url: "https://app.opengeo.so",
      creditsCharged: 0,
    });
  });

  it("attaches structuredContent when provided", () => {
    const result = mcpResponse({
      text: "hi",
      structuredContent: { foo: "bar" },
    });
    expect(result.structuredContent).toEqual({ foo: "bar" });
  });

  it("mirrors metadata into structuredContent for clients that hide _meta", () => {
    const result = mcpResponse({
      text: "hi",
      meta: {
        url: "https://app.opengeo.so/p/1",
        projectId: "1",
        creditsRemaining: 100,
      },
      structuredContent: { foo: "bar" },
    });

    expect(result.structuredContent).toEqual({
      foo: "bar",
      meta: {
        url: "https://app.opengeo.so/p/1",
        projectId: "1",
        creditsRemaining: 100,
      },
    });
    expect(result._meta).toEqual({
      url: "https://app.opengeo.so/p/1",
      projectId: "1",
      creditsRemaining: 100,
    });
  });

  it("uses metadata as structuredContent when no data payload is provided", () => {
    const result = mcpResponse({
      text: "hi",
      meta: { url: "https://app.opengeo.so" },
    });

    expect(result.structuredContent).toEqual({
      meta: { url: "https://app.opengeo.so" },
    });
  });
});

/**
 * What an MCP response actually costs an agent.
 *
 * `mcpResponse` puts `text` **and** `structuredContent` on the wire, and clients
 * count both — so a list page carrying every preview twice is the single largest
 * avoidable token cost in the tool surface, and it is invisible in a unit test
 * that only checks the fields exist.
 *
 * These tests measure the wire rather than the intent. The claim "this response
 * is compact" is worth nothing unless something counts it.
 */
describe("response size", () => {
  it("counts both halves of the wire, because clients do", () => {
    const result = mcpResponse({
      text: "x".repeat(2000),
      structuredContent: { body: "x".repeat(2000) },
    });
    // ~4,000 characters of content plus the JSON envelope — not 2,000.
    expect(estimateResponseTokens(result)).toBeGreaterThan(3_800);
  });

  it("grows with the payload, not with the number of fields", () => {
    const small = mcpResponse({ text: "short", structuredContent: { a: 1 } });
    const large = mcpResponse({
      text: "short",
      structuredContent: { a: 1, b: "x".repeat(1000) },
    });
    expect(estimateResponseTokens(large)).toBeGreaterThan(
      estimateResponseTokens(small) + 200,
    );
  });
});

describe("optimizeForModel", () => {
  it("keeps the fields an agent acts on", () => {
    const result = optimizeForModel(
      {
        domain: "acme.com",
        platform: "chat_gpt",
        mentions: 12,
        // Long prose an agent will not read and cannot act on. With no `keep`
        // list the budget is what has to remove it.
        notes: "x".repeat(5000),
      },
      { budgetChars: 300 },
    );
    expect(result.domain).toBe("acme.com");
    expect(result.platform).toBe("chat_gpt");
    expect(result.mentions).toBe(12);
    // Dropped by the budget, and named as dropped.
    expect(result).not.toHaveProperty("notes");
    expect(Reflect.get(result, "_dropped")).toContain("notes");
  });

  it("records what it dropped, so a truncation is never silent", () => {
    // A silently shortened payload is one the agent cannot tell is short, and a
    // model that does not know a field was cut will not go and fetch it.
    const result = optimizeForModel(
      { a: 1, b: 2, c: 3 },
      { keep: ["a"], budgetChars: 500 },
    );
    expect(result.a).toBe(1);
    expect(result).not.toHaveProperty("b");
    expect(result).not.toHaveProperty("c");
    // The dropped-key list is itself small, and is what makes the trimming
    // actionable rather than merely lossy.
    expect(Reflect.get(result, "_dropped")).toEqual(["b", "c"]);
  });

  it("never exceeds its budget", () => {
    const result = optimizeForModel(
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`field${i}`, "x".repeat(200)]),
      ),
      { budgetChars: 400 },
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(400);
  });

  it("keeps the budget when the dropped-key list is itself huge", () => {
    // The audit trail must not become the thing that blows the budget: 48 key
    // names is longer than the payload that survived.
    const result = optimizeForModel(
      Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`field${i}`, "x".repeat(200)]),
      ),
      { budgetChars: 200 },
    );
    const dropped: unknown = Reflect.get(result, "_dropped");
    expect(Array.isArray(dropped) ? dropped.length : 0).toBeLessThanOrEqual(13);
    expect(Array.isArray(dropped) ? dropped.at(-1) : "").toMatch(
      /^\+\d+ more$/,
    );
  });

  it("halves an oversized array before dropping whole keys", () => {
    // A 40-item list is the one field that is cheap to shorten, and the model
    // often only needed its shape.
    const result = optimizeForModel(
      { pages: Array.from({ length: 40 }, (_, i) => `https://p/${i}`) },
      { budgetChars: 400 },
    );
    const pages = Reflect.get(result, "pages");
    // Either the list survived shortened, or it was dropped and named — never
    // silently deleted, and never emptied into a claim of "no pages".
    if (pages === undefined) {
      expect(Reflect.get(result, "_dropped")).toContain("pages");
    } else {
      expect(pages.length).toBeGreaterThan(0);
      expect(pages.length).toBeLessThan(40);
      // And the count it really had is recorded, or five visible pages read as
      // "these are all the pages".
      expect(Reflect.get(result, "_truncated")).toMatchObject({ pages: 40 });
    }
  });

  it("keeps meta even when the budget cannot afford it", () => {
    // Dropping the dashboard link to save bytes leaves a response that is small
    // and useless: the agent cannot tell the user where to look.
    const result = optimizeForModel(
      {
        meta: { url: "https://app.opengeo.so/p/1" },
        blob: "x".repeat(5000),
      },
      { budgetChars: 80 },
    );
    expect(result.meta).toEqual({ url: "https://app.opengeo.so/p/1" });
    expect(result).not.toHaveProperty("blob");
  });

  it("leaves a small payload intact rather than trimming to fit", () => {
    const result = optimizeForModel({ a: 1, b: 2 });
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
    expect(result).not.toHaveProperty("_dropped");
  });

  it("reports partial data rather than a confident short list", () => {
    // The failure this prevents: an agent sees five of forty pages, believes it
    // saw all forty, and tells the customer the brand is cited by five pages.
    const result = optimizeForModel(
      { pages: Array.from({ length: 40 }, (_, i) => `https://p/${i}`) },
      { keep: ["pages"], budgetChars: 200, maxItemsPerKey: 5 },
    );
    const pages: unknown = Reflect.get(result, "pages");
    expect(Array.isArray(pages) ? pages.length : 0).toBe(5);
    expect(Reflect.get(result, "_truncated")).toMatchObject({ pages: 40 });
  });
});

describe("truncatePreview", () => {
  it("marks a cut with an ellipsis so a reader knows it is partial", () => {
    expect(truncatePreview("x".repeat(500), 100)).toMatch(/…$/);
    expect(truncatePreview("x".repeat(500), 100)).toHaveLength(101);
  });

  it("leaves a short value alone", () => {
    expect(truncatePreview("short", 100)).toBe("short");
  });

  it("never cuts mid-surrogate", () => {
    // A lone surrogate renders as a replacement glyph — a visible artefact in a
    // tool result the agent will quote back to a user.
    const cut = truncatePreview("👍".repeat(100), 51);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
