import { describe, expect, it } from "vitest";
import {
  buildArchivedAnswer,
  parseTag,
  promptForTag,
  readCollectedAnswer,
  type ArchivedAnswer,
} from "./answerCollector";

/**
 * Collecting a queued answer into the archive.
 *
 * The load-bearing test is the first one: the join is by tag, and the
 * alternative — matching by position in the posted list — produces an archive
 * that is complete, internally consistent, and **entirely attached to the wrong
 * questions**. Nothing throws, nothing looks wrong, and the citation graph
 * quietly tells a lie. That is the shape of bug this codebase keeps finding.
 */

/**
 * Build an archived answer, or fail the test with the refusal's reason.
 *
 * Narrowing rather than casting: `buildArchivedAnswer` returns a union, and
 * `as ArchivedAnswer` on a refusal would produce a row of `undefined`s that
 * happens to satisfy the assertion. Every one of those casts was a place a
 * test could have passed without testing anything.
 */
function archived(
  input: Parameters<typeof buildArchivedAnswer>[0],
): ArchivedAnswer {
  const result = buildArchivedAnswer(input);
  if ("ok" in result) {
    throw new Error(
      `expected an archived answer, got a refusal: ${result.reason}`,
    );
  }
  return result;
}
function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "vendor-1",
    cost: 0.0042,
    result: [
      {
        model_name: "gpt-5",
        content:
          "Acme is a strong option ([acme.com](https://acme.com/pricing)) and pairs well with HubSpot ([hubspot.com](https://hubspot.com)).",
        tag: "t1:chat_gpt:0",
        citations: [{ url: "https://acme.com/pricing", title: "Pricing" }],
        ...overrides,
      },
    ],
  };
}

describe("parseTag", () => {
  it("round-trips the triple the planner writes", () => {
    const identity = parseTag("t1:chat_gpt:7");
    expect(identity).toEqual({
      targetId: "t1",
      platform: "chat_gpt",
      index: 7,
    });
  });

  it("keeps a target id that itself contains a colon", () => {
    // The obvious implementation splits on every colon into exactly three parts,
    // which is right for a uuid and wrong for a prefixed id. Splitting at the
    // *first* and *last* separator is right for both, because a uuid has no
    // colons and a prefixed id can only have one in the middle.
    const identity = parseTag("proj:9:t1:chat_gpt:2");
    expect(identity?.targetId).toBe("proj:9:t1");
    expect(identity?.platform).toBe("chat_gpt");
    expect(identity?.index).toBe(2);
  });

  it("rejects a platform it does not know", () => {
    // A tag naming an unknown platform means the writer and the reader have
    // drifted, and the id would otherwise be attached to whatever it named.
    expect(parseTag("t1:not_a_platform:0")).toBeNull();
  });

  it("rejects a non-numeric index", () => {
    expect(parseTag("t1:chat_gpt:abc")).toBeNull();
  });

  it("rejects a tag with too few separators", () => {
    expect(parseTag("t1")).toBeNull();
    expect(parseTag("t1:chat_gpt")).toBeNull();
  });
});

describe("readCollectedAnswer", () => {
  it("joins the array form of content into text", () => {
    // The array form assumed to be a string yields `[object Object]` in the
    // archive, which is worse than a gap.
    const read = readCollectedAnswer(
      task({
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ],
      }),
    );
    expect(read.content).toBe("Hello world");
  });

  it("skips a content part it cannot read rather than stringifying it", () => {
    const read = readCollectedAnswer(
      task({ content: [{ type: "image" }, { type: "text", text: "Kept" }] }),
    );
    expect(read.content).toBe("Kept");
    expect(read.content).not.toContain("object Object");
  });

  it("accepts the answer fields at the top level as well as under result", () => {
    // Some versions nest, some do not. Accepting only one is a version bomb
    // that produces an archive which quietly stops growing.
    const nested = readCollectedAnswer(task());
    const flat = readCollectedAnswer({
      id: "vendor-1",
      cost: 0.0042,
      model_name: "gpt-5",
      content: "Acme is a strong option.",
      tag: "t1:chat_gpt:0",
    });
    expect(nested.content).not.toBeNull();
    expect(flat.content).toBe("Acme is a strong option.");
    expect(flat.tag).toBe("t1:chat_gpt:0");
  });

  it("survives a payload that is not an object at all", () => {
    // The vendor's JSON is untrusted. A null or a string must produce empty
    // fields, not a thrown parse that takes the whole collection tick with it.
    expect(readCollectedAnswer(null).content).toBeNull();
    expect(readCollectedAnswer("nope").tag).toBeNull();
  });

  it("returns null content for a pending task, not an empty string", () => {
    // The distinction the whole collector rests on: a pending task has no
    // answer, which is not the same as an answer that is empty.
    const read = readCollectedAnswer(task({ content: null }));
    expect(read.content).toBeNull();
  });
});

describe("buildArchivedAnswer", () => {
  it("attributes the answer to the target named in the tag, not to its position", () => {
    // THE test. Two targets, two prompts, and the ids arriving out of order —
    // which is what a partial acceptance or a partial collection failure
    // produces. A positional join puts both answers on the wrong targets, and
    // the archive looks complete.
    const first = archived({
      task: task({ tag: "t2:chat_gpt:5" }),
      fallbackTag: null,
      prompt: "what is the best crm",
      vendorTaskId: "vendor-1",
    });
    const second = archived({
      task: task({ tag: "t1:chat_gpt:3" }),
      fallbackTag: null,
      prompt: "best helpdesk for acme",
      vendorTaskId: "vendor-2",
    });

    expect(first).toMatchObject({
      targetId: "t2",
      prompt: "what is the best crm",
    });
    expect(second).toMatchObject({
      targetId: "t1",
      prompt: "best helpdesk for acme",
    });
  });

  it("archives the answer text verbatim, never summarised", () => {
    // The schema's own rule, and the reason a diff is possible at all.
    const answer = archived({
      task: task(),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(answer.answerText).toContain("Acme is a strong option");
  });

  it("parses citations with the same parser the Live path uses", () => {
    // One parser, one definition of a citation. A second would let the same
    // page be cited in a live answer and uncited in a queued one.
    const answer = archived({
      task: task(),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });

    expect(answer.citations.map((c) => c.domain)).toEqual([
      "acme.com",
      "hubspot.com",
    ]);
    expect(answer.citations[0]?.rank).toBe(1);
  });

  it("refuses rather than writing a row for a task with no tag", () => {
    // Writing it anyway attaches the answer to whichever target is next, which
    // is the positional bug wearing a different hat.
    const result = buildArchivedAnswer({
      task: task({ tag: null }),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "no_tag" });
  });

  it("refuses a pending task rather than archiving an empty answer", () => {
    // An empty answer row reads as "the model declined to mention us" — a
    // finding the customer will act on, and one we would have invented.
    const result = buildArchivedAnswer({
      task: task({ content: null }),
      fallbackTag: "t1:chat_gpt:0",
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "still_pending" });
  });

  it("refuses when the prompt cannot be recovered", () => {
    // The pending row is gone, so the question that was asked is unknown. An
    // answer without its prompt is not reproducible evidence, and a guessed one
    // would be worse than a gap.
    const result = buildArchivedAnswer({
      task: task(),
      fallbackTag: "t1:chat_gpt:0",
      prompt: null,
      vendorTaskId: "vendor-1",
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("falls back to the tag we posted with when the vendor drops the echo", () => {
    const answer = archived({
      task: task({ tag: undefined }),
      fallbackTag: "t9:perplexity:2",
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(answer).toMatchObject({ targetId: "t9", platform: "perplexity" });
  });

  it("keeps the raw response, so a schema change never loses evidence", () => {
    const answer = archived({
      task: task(),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(answer.vendorTaskId).toBe("vendor-1");
    expect(answer.rawJson).toContain("vendor-1");
  });

  it("keeps a source the vendor listed even when the text does not cite it", () => {
    // The parser's decision, and it is the right one: an annotation with no
    // marker is still a citation -- a source the vendor reported, at an unknown
    // position -- and dropping it would *understate* the archive. It is recorded
    // as `unpositioned`, so a consumer can still tell it apart from one the model
    // demonstrably wrote.
    const answer = archived({
      task: task({
        citations: [
          { url: "https://acme.com/pricing", title: "Pricing" },
          { url: "https://listed-but-uncited.example", title: "Never cited" },
        ],
      }),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });

    // The note reports the discrepancy rather than hiding it.
    expect(answer.note).toMatch(/does not cite/i);
    // And the source is still archived -- the answer is not silently shortened.
    expect(answer.citations.map((c) => c.domain)).toEqual([
      "acme.com",
      "hubspot.com",
      "listed-but-uncited.example",
    ]);
  });

  it("says nothing when the vendor's list matches the text", () => {
    // A note on every answer trains the reader to skip the note, which is the
    // same failure as an alert on every run.
    const answer = archived({
      task: task(),
      fallbackTag: null,
      prompt: "q",
      vendorTaskId: "vendor-1",
    });
    expect(answer.note).toBeNull();
  });
});

describe("promptForTag", () => {
  it("finds the prompt a tag was posted with", () => {
    const pending = [
      { tag: "t1:chat_gpt:0", prompt: "best crm" },
      { tag: "t1:chat_gpt:1", prompt: "best helpdesk" },
    ];
    expect(promptForTag(pending, "t1:chat_gpt:1")).toBe("best helpdesk");
  });

  it("returns null rather than a guess when the row is gone", () => {
    expect(promptForTag([], "t1:chat_gpt:0")).toBeNull();
  });
});
