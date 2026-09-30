import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

vi.mock("@/server/lib/dataforseo/llm-responses-queue", () => ({
  postLlmResponseTasks: vi.fn(),
}));

import {
  planPosts,
  postBatch,
  queueNote,
  tagFor,
  type QueueCandidate,
} from "./queuePlanner";
import { postLlmResponseTasks } from "@/server/lib/dataforseo/llm-responses-queue";

/**
 * The queue planner.
 *
 * The tests are about **not losing work** and **not overstating progress**. A
 * post that is silently dropped and a post reported as complete are the two
 * failures worth spending a file on, because both look like a working system.
 */
const mockedPost = vi.mocked(postLlmResponseTasks);

function candidate(
  n: number,
  overrides: Partial<QueueCandidate> = {},
): QueueCandidate {
  return {
    prompt: `prompt ${n}`,
    targetId: "t1",
    platform: "chat_gpt",
    modelName: "gpt-5",
    ...overrides,
  };
}

beforeEach(() => {
  mockedPost.mockReset();
});

describe("planPosts", () => {
  it("keeps every candidate", () => {
    // The load-bearing property. A planner that batches and forgets a tail looks
    // identical to one that works, right up until a customer notices a prompt
    // that has never once been asked.
    const candidates = Array.from({ length: 250 }, (_, i) => candidate(i));
    const batches = planPosts(candidates);

    const flattened = batches.flat();
    expect(flattened).toHaveLength(250);
    expect(flattened).toEqual(candidates);
  });

  it("splits at the vendor's documented batch cap", () => {
    // 100 is the documented per-POST limit; over it, the vendor rejects the
    // whole call with 40006 rather than accepting a prefix.
    const batches = planPosts(
      Array.from({ length: 250 }, (_, i) => candidate(i)),
    );
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("puts a lone candidate in a batch of one", () => {
    expect(planPosts([candidate(0)])).toHaveLength(1);
  });

  it("plans nothing for no candidates", () => {
    // Not a batch of zero: posting an empty call is a billed call for no work.
    expect(planPosts([])).toEqual([]);
  });
});

describe("tagFor", () => {
  it("includes the run index so two identical prompts cannot collide", () => {
    // The silent one. Two targets asking the *same* prompt on the same platform
    // produce identical tags when the index is omitted, and the second answer is
    // then attached to the first target — both rows look complete and both are
    // wrong.
    const a = tagFor(candidate(1, { targetId: "t1" }), 0);
    const b = tagFor(candidate(1, { targetId: "t1" }), 1);
    expect(a).not.toBe(b);
  });

  it("keeps the target and the platform in the tag", () => {
    const tag = tagFor(
      candidate(1, { targetId: "t9", platform: "perplexity" }),
      3,
    );
    expect(tag).toContain("t9");
    expect(tag).toContain("perplexity");
  });
});

describe("postBatch", () => {
  it("posts every candidate with its own tag", async () => {
    mockedPost.mockResolvedValue({
      data: [{ taskId: "a", tag: "t", costUsd: 0.01 }],
      billing: { path: [], costUsd: 0.01 },
    });

    await postBatch("chat_gpt", [candidate(0), candidate(1)], 0);

    const call = mockedPost.mock.calls[0]?.[0];
    expect(call?.se).toBe("chat_gpt");
    expect(call?.tasks).toHaveLength(2);
    const tags = call?.tasks.map((t) => t.tag) ?? [];
    expect(new Set(tags).size).toBe(2);
  });

  it("asks for web search, because without it there is nothing to cite", async () => {
    // The product's claim is about what a model *retrieved and cited*. A queued
    // answer with search disabled is a much weaker measurement and would be
    // archived as though it were the same one.
    mockedPost.mockResolvedValue({
      data: [{ taskId: "a", tag: "t", costUsd: 0.01 }],
      billing: { path: [], costUsd: 0.01 },
    });

    await postBatch("chat_gpt", [candidate(0)], 0);
    expect(mockedPost.mock.calls[0]?.[0]?.tasks[0]?.webSearch).toBe(true);
  });

  it("counts a partial acceptance, because the vendor's answer is the only source", async () => {
    // The client returns accepted entries only, so the count that did not come
    // back is the count the vendor did not take. Inferring is the only option,
    // and it is why a rejection is reported rather than left as a shortfall
    // someone notices in the archive weeks later.
    mockedPost.mockResolvedValue({
      data: [{ taskId: "a", tag: "t", costUsd: 0.01 }],
      billing: { path: [], costUsd: 0.01 },
    });

    const outcome = await postBatch(
      "chat_gpt",
      [candidate(0), candidate(1), candidate(2)],
      0,
    );

    expect(outcome).toMatchObject({ posted: true, accepted: 1, rejected: 2 });
  });

  it("reports the advance that was charged, not the settled cost", async () => {
    mockedPost.mockResolvedValue({
      data: [{ taskId: "a", tag: "t", costUsd: 0.01 }],
      billing: { path: [], costUsd: 0.03 },
    });

    const outcome = await postBatch("chat_gpt", [candidate(0)], 0);
    // 0.03 is the vendor's post-time figure for one task; the real cost settles
    // at collection. Reporting the settled number here would be a claim about
    // money that has not been charged yet.
    expect(outcome.posted && outcome.advanceUsd).toBeCloseTo(0.03, 5);
  });

  it("never throws, because the vendor may already have charged", async () => {
    // An exception escaping here is a failure *after* spending the customer's
    // money, and the run log would never record that any of it happened.
    mockedPost.mockRejectedValue(new Error("502 from the edge"));

    const outcome = await postBatch("chat_gpt", [candidate(0)], 0);

    // Narrowed rather than cast, so the assertion still checks the shape it
    // means to: a *failed* post, and the reason it carries.
    expect(outcome.posted).toBe(false);
    if (outcome.posted) throw new Error("expected a failed post");
    expect(outcome.reason).toMatch(/502/);
  });

  it("says the advance may still have been taken when a post fails", async () => {
    // The 5xx does not prove the vendor skipped the charge — the same reasoning
    // as the NO_RETRY gate, in a sentence a human reads.
    mockedPost.mockRejectedValue(new Error("502"));

    const outcome = await postBatch("chat_gpt", [candidate(0)], 0);
    expect(outcome.posted).toBe(false);
    if (outcome.posted) throw new Error("expected a failed post");
    expect(outcome.reason).toMatch(/may still have been taken/i);
  });

  it("refuses an empty batch rather than making a billed call for no work", async () => {
    const outcome = await postBatch("chat_gpt", [], 0);
    expect(outcome.posted).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });
});

describe("queueNote", () => {
  it("says the work is not finished", () => {
    // The sentence has to carry both halves. "Queued 100 prompts" alone reads
    // as success, and the archive stays empty until someone remembers why.
    const note = queueNote({ posted: 100, accepted: 100, rejected: 0 });
    expect(note).toMatch(/archive for this run stays empty/i);
  });

  it("reports a partial acceptance in the note", () => {
    // Silent rejection is how a prompt goes unasked forever.
    const note = queueNote({ posted: 100, accepted: 92, rejected: 8 });
    expect(note).toMatch(/92 of 100/);
    expect(note).toMatch(/8 were rejected/);
  });

  it("uses the singular for one rejection", () => {
    // Small, but "1 were rejected" is the kind of detail that makes a reader
    // distrust the rest of the sentence.
    const note = queueNote({ posted: 3, accepted: 2, rejected: 1 });
    expect(note).toMatch(/1 was rejected/);
  });
});
