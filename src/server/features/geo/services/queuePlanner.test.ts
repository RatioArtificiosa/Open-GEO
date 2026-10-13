import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the `autumn.track` mock records, as the charge reads it back. */
type TrackCall = {
  customerId: string;
  value: number;
  properties?: Record<string, unknown>;
};

const {
  isHostedMock,
  getOrCreateOrganizationCustomerMock,
  checkMock,
  trackMock,
} = vi.hoisted(() => ({
  isHostedMock: vi.fn(),
  getOrCreateOrganizationCustomerMock: vi.fn(),
  checkMock: vi.fn(),
  trackMock: vi.fn<(arg: TrackCall) => void>(),
}));

/**
 * The mock layer, and why it stops at the **section module**.
 *
 * CL-202 was a queued post that bypassed the credit gate. This repo learned
 * that lesson once already — `observations-and-memories.md` records it — that
 * mocking *inside* the client (or mocking the client away) leaves the gate out
 * of the path and proves nothing about money. So the section module is mocked
 * here, the **real client and the real gate stay in the path**, and the refusal
 * tests below can only pass if the gate ran.
 *
 * `@/server/lib/runtime-env` is the hosted-mode switch the client reads,
 * `@/server/billing/autumn` is the balance store, and
 * `@/server/billing/subscription` is where the gate lives: the customer lookup
 * is stubbed and the balance arithmetic is the real one — the same arrangement
 * `client.test.ts` uses.
 */
vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
  // The markup resolver is partially mocked below, and the real one loads
  // `@/db` for the operator-override read. The handle is never queried in this
  // file (the dial is pinned), but the import chain needs the binding to exist.
  env: { DATABASE_PROVIDER: "d1" },
}));

vi.mock("@/server/billing/autumn", () => ({
  autumn: {
    check: checkMock,
    track: trackMock,
  },
  AUTUMN_TRACK_RETRY_OPTIONS: {},
}));

vi.mock("@/server/billing/subscription", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrCreateOrganizationCustomer: getOrCreateOrganizationCustomerMock,
  };
});

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: isHostedMock,
}));

// The multiplier is an operator dial resolved from configuration at request
// time, so a unit test pins it rather than reading whatever the environment
// happens to hold — the same pin `client.test.ts` uses, so the two files agree
// about the rate their expected credit figures were computed at.
const TEST_MARKUP = 1.28;

vi.mock(import("@/server/billing/costMarkup"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveCostMarkup: vi.fn(async () => TEST_MARKUP),
}));

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

vi.mock("@/server/lib/dataforseo/llm-responses-queue", () => ({
  postLlmResponseTasks: vi.fn(),
}));

// The spend ledger is mocked away, for the same reason the ledger's own file
// mocks nothing: **a ledger write is a database write, and a test about the
// queue's behaviour would otherwise fail on a missing D1 binding.**
// `client.spend.test.ts` asserts the row itself; this file is about the post.
vi.mock("@/server/features/vendor/repositories/VendorSpendRepository", () => ({
  VendorSpendRepository: {
    getControls: async () => null,
    monthlySpendUsd: async () => 0,
    record: async () => ({}),
  },
}));

import {
  planPosts,
  postBatch,
  queueNote,
  tagFor,
  type QueueCandidate,
} from "./queuePlanner";
import { postLlmResponseTasks } from "@/server/lib/dataforseo/llm-responses-queue";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { AppError } from "@/server/lib/errors";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
} from "@/shared/billing";
import { estimateQueuedLlmResponsesPost } from "@/shared/dataforseo-pricing";

/**
 * The queue planner.
 *
 * The tests are about **not losing work** and **not overstating progress**. A
 * post that is silently dropped and a post reported as complete are the two
 * failures worth spending a file for, because both look like a working system.
 *
 * The third, added with CL-202, is about **money**: a post the platform paid
 * for against an org whose balance was never read. That one is different from
 * the other two in that it never looked broken at all — the vendor's own
 * `costUsd` was being folded into the run's budget figure, so the log read as
 * metered while nothing was charged.
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

/** The billing context every metered call is charged against. */
const CUSTOMER = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "ops@example.com",
  projectId: "p1",
};

function client() {
  return createDataforseoClient(CUSTOMER);
}

/** What the vendor answers a post with: one accepted task per submitted task. */
function acceptedPost(count: number, costPerTask = 0.01) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      taskId: `task_${i}`,
      tag: "t",
      costUsd: costPerTask,
    })),
    billing: {
      // The vendor's own routing breadcrumb, kept because every other call in
      // this SDK reports it: it is what maps the charge to `ai_prompt_responses`.
      path: ["v3", "ai_optimization", "chat_gpt", "llm_responses", "task_post"],
      costUsd: count * costPerTask,
    },
  };
}

function mockBalances(monthly: number, topup: number) {
  checkMock.mockImplementation(async (args: { featureId: string }) => {
    if (args.featureId === AUTUMN_SEO_DATA_BALANCE_FEATURE_ID) {
      return { allowed: true, balance: { remaining: monthly } };
    }
    if (args.featureId === AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID) {
      return { allowed: true, balance: { remaining: topup } };
    }
    return { allowed: false, balance: null };
  });
}

/** Credits a USD figure charges, by exactly the arithmetic the charge uses. */
function creditsFor(vendorCostUsd: number): number {
  return Math.ceil(
    vendorCostUsd * TEST_MARKUP * AUTUMN_SEO_DATA_CREDITS_PER_USD,
  );
}

beforeEach(() => {
  mockedPost.mockReset();
  // Self-hosted by default: no hosted account, no gate, and the behavioural
  // tests below are about the post itself rather than about billing.
  isHostedMock.mockResolvedValue(false);
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
    mockedPost.mockResolvedValue(acceptedPost(1));

    await postBatch(client(), "chat_gpt", [candidate(0), candidate(1)], 0);

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
    mockedPost.mockResolvedValue(acceptedPost(1));

    await postBatch(client(), "chat_gpt", [candidate(0)], 0);
    expect(mockedPost.mock.calls[0]?.[0]?.tasks[0]?.webSearch).toBe(true);
  });

  it("counts a partial acceptance, because the vendor's answer is the only source", async () => {
    // The client returns accepted entries only, so the count that did not come
    // back is the count the vendor did not take. Inferring is the only option,
    // and it is why a rejection is reported rather than left as a shortfall
    // someone notices in the archive weeks later.
    mockedPost.mockResolvedValue(acceptedPost(1));

    const outcome = await postBatch(
      client(),
      "chat_gpt",
      [candidate(0), candidate(1), candidate(2)],
      0,
    );

    expect(outcome).toMatchObject({ posted: true, accepted: 1, rejected: 2 });
  });

  it("reports the advance that was charged, not the settled cost", async () => {
    mockedPost.mockResolvedValue(acceptedPost(1, 0.03));

    const outcome = await postBatch(client(), "chat_gpt", [candidate(0)], 0);
    // 0.03 is the vendor's post-time figure for one task; the real cost settles
    // at collection. Reporting the settled number here would be a claim about
    // money that has not been charged yet.
    expect(outcome.posted && outcome.advanceUsd).toBeCloseTo(0.03, 5);
  });

  it("never throws, because the vendor may already have charged", async () => {
    // An exception escaping here is a failure *after* spending the customer's
    // money, and the run log would never record that any of it happened.
    mockedPost.mockRejectedValue(new Error("502 from the edge"));

    const outcome = await postBatch(client(), "chat_gpt", [candidate(0)], 0);

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

    const outcome = await postBatch(client(), "chat_gpt", [candidate(0)], 0);
    expect(outcome.posted).toBe(false);
    if (outcome.posted) throw new Error("expected a failed post");
    expect(outcome.reason).toMatch(/may still have been taken/i);
  });

  it("refuses an empty batch rather than making a billed call for no work", async () => {
    const outcome = await postBatch(client(), "chat_gpt", [], 0);
    expect(outcome.posted).toBe(false);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  /**
   * CL-202, and the whole reason this file's mock layer stops at the section
   * module.
   *
   * Before the fix the planner called `postLlmResponseTasks` directly: the
   * queued path ran no credit gate, deducted nothing, and charged no org. The
   * platform's vendor account paid — a zero-credit org kept receiving queued
   * captures — and nothing anywhere reported it, because the vendor's own
   * figure was still being folded into the run's budget.
   */
  describe("the credit gate (CL-202)", () => {
    beforeEach(() => {
      isHostedMock.mockResolvedValue(true);
      getOrCreateOrganizationCustomerMock.mockResolvedValue({ id: "org_1" });
    });

    it("refuses a zero-credit org before the fetch, and the fetch never happens", async () => {
      mockBalances(0, 0);
      mockedPost.mockResolvedValue(acceptedPost(1));

      const outcome = await postBatch(client(), "chat_gpt", [candidate(0)], 0);

      // The refusal is carried, not thrown: a post that fails has already been
      // paid for, so the run log records it and the patrol moves on.
      expect(outcome.posted).toBe(false);
      // **The observable consequence.** Not "the gate threw" — the vendor was
      // never called at all, so there is nothing to refund and nothing to
      // reconcile. This is the assertion that fails on the pre-fix code.
      expect(mockedPost).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalled();
    });

    it("refuses an org whose balance cannot cover the whole batch", async () => {
      // A non-empty wallet is not a floor. Two tasks floor at the vendor's
      // per-task fee plus the $0.01 advance, so 26 credits admit nothing and
      // 27 admit the post — this is the estimate reaching the gate.
      const batch = [candidate(0), candidate(1)];
      const required = Math.ceil(
        estimateQueuedLlmResponsesPost(2) *
          TEST_MARKUP *
          AUTUMN_SEO_DATA_CREDITS_PER_USD,
      );
      expect(required).toBe(27);
      mockedPost.mockResolvedValue(acceptedPost(2));

      mockBalances(required - 1, 0);
      const refused = await postBatch(client(), "chat_gpt", batch, 0);
      expect(refused.posted).toBe(false);
      expect(mockedPost).not.toHaveBeenCalled();

      mockBalances(required, 0);
      const admitted = await postBatch(client(), "chat_gpt", batch, 0);
      expect(admitted.posted).toBe(true);
      expect(mockedPost).toHaveBeenCalledTimes(1);
    });

    it("charges the vendor's own figure, not the estimate", async () => {
      // The floor is provisional by design — the $0.01 advance is refunded when
      // the model costs less — so the charge must be the vendor's number from
      // the receipt. A charge built from the estimate would bill an advance
      // that was refunded, and the run log's `advanceUsd` would be one number
      // while the ledger held another.
      mockBalances(5000, 0);
      mockedPost.mockResolvedValue(acceptedPost(2, 0.004));

      const outcome = await postBatch(
        client(),
        "chat_gpt",
        [candidate(0), candidate(1)],
        0,
      );
      expect(outcome.posted).toBe(true);

      // 2 tasks × $0.004 the vendor charged, marked up and converted.
      expect(trackMock).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "org_1",
          value: creditsFor(0.008),
        }),
        expect.anything(),
      );
      const [trackArg] = trackMock.mock.calls[0] ?? [];
      expect(trackArg?.properties?.creditFeature).toBe("ai_prompt_responses");
    });

    it("records no spend for a post the vendor refused outright", async () => {
      // A validation error before any billing: nothing to charge, and the
      // failure is reported rather than silently swallowed.
      mockBalances(5000, 0);
      mockedPost.mockRejectedValue(
        new AppError(
          "VALIDATION_ERROR",
          "DataForSEO offers no Standard queue for this platform",
        ),
      );

      const outcome = await postBatch(client(), "chat_gpt", [candidate(0)], 0);
      expect(outcome.posted).toBe(false);
      expect(trackMock).not.toHaveBeenCalled();
    });
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
