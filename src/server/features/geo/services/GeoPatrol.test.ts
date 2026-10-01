import { describe, expect, it, vi } from "vitest";

/**
 * The patrol's reporting rules.
 *
 * Every rule tested here exists because the alternative failure is silent: a
 * wrong number on a dashboard that looks authoritative, or a fabricated
 * "retrieved but not cited" gap — the one claim this product sells.
 */

/** A `vi.fn()` whose recorded args stay typed, so reading one back is not `any`. */
function spy() {
  return vi.fn<(...args: never[]) => unknown>();
}

const listTargets = spy();
const mentionsSearch = spy();
const recordRun = spy();
const recordVendorTask = spy().mockResolvedValue(true);
/** The project's saved prompts, which the queued branch now reads. */
const promptsForQueuedRun = spy().mockResolvedValue([]);
/**
 * The size of every batch the queue was asked to post, in order.
 *
 * A plain array rather than a `vi.fn()`: the shared `spy()` helper types its
 * parameters `never[]` so a test can *read* recorded arguments back without
 * touching `any`, and that correctly rejects a call carrying an argument. The
 * first version passed the input to the spy, `tsc` rejected it on Linux, and
 * `knip` — which does not type-check — stayed green locally.
 */
const postedBatches: number[] = [];
/**
 * Its response shape matters, and getting it wrong produces a failure that looks
 * exactly like the bug under test: `postBatch` reads `response.data` for the
 * accepted count and `response.billing.costUsd` for the advance, so a mock
 * returning `{}` makes every post "refused" and the run reports
 * `promptsAsked: 0` — indistinguishable from the dormancy being fixed. The first
 * version of this test did precisely that and reported a product bug that was in
 * the mock. So the shape is mirrored here, once, and used by the mock below.
 */
function acceptedResponse(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({ id: `task_${i}` })),
    billing: {
      costUsd: count * 0.01,
      path: ["/v3/ai_optimization/llm_responses/task_post/live"],
    },
  };
}

/** One archived answer, as the service received it. */
type RecordedRun = {
  answers: Array<{
    answer: { answerText: string | null; platform: string };
    citations: Array<{ url: string; domain: string | null }>;
    retrievals?: Array<{ url: string }>;
  }>;
  costUsd?: number;
};

/** Total check, so the reader above needs no type assertion. */
function isRecordedRun(value: unknown): value is RecordedRun {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray(Reflect.get(value, "answers"));
}

/** Read back what the patrol passed to `GeoService.recordRun`. */
function recordedRun(): RecordedRun {
  const first = recordRun.mock.calls[0];
  if (!first || typeof first[0] !== "object" || first[0] === null) {
    throw new Error("recordRun was not called");
  }
  const value: unknown = Object.fromEntries(Object.entries(first[0]));
  if (!isRecordedRun(value)) {
    throw new Error("recordRun was called without an answers array");
  }
  return value;
}

/** Read back the arguments the patrol passed to the vendor client. */
function mentionsCall(): Record<string, unknown> {
  const first = mentionsSearch.mock.calls[0];
  if (!first || typeof first[0] !== "object" || first[0] === null) {
    throw new Error("mentionsSearch was not called");
  }
  return Object.fromEntries(Object.entries(first[0]));
}

// The module mock replaces the WHOLE module, so anything GeoPatrol imports from
// it must be re-declared here. Forgetting one makes the patrol throw at call
// time rather than at import time, which reads as "no mentions found" — the
// worst possible failure mode for a monitoring job.
//
// `platformSupportsRetrieval` is declared rather than imported for real:
// `importActual` would pull the repository's `@/db` dependency in, which reads
// `cloudflare:workers`, a Workers-only module vitest cannot resolve.
vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
  platformSupportsRetrieval: (platform: string) => platform === "chat_gpt",
}));
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: { recordRun, promptsForQueuedRun },
}));
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({ aiSearch: { mentionsSearch } }),
}));
// The queued endpoint posts through the shared client module rather than the SDK
// client, and without this the branch reads the real one and posts nothing.
vi.mock("@/server/lib/dataforseo/llm-responses-queue", () => ({
  // The response accepts whatever was posted, so `accepted` equals the batch size
  // and the run reports the prompts it actually submitted.
  //
  // **Counted, not recorded through the shared `spy()`.** That helper types its
  // parameters `never[]` so a test can *read* recorded arguments back without
  // touching `any` — and `never[]` rejects a call with an argument, which is
  // correct for its purpose and wrong for this one. The first version passed the
  // input to the spy and `tsc` rejected it on Linux while the file had already
  // been committed; `knip` does not type-check, so it stayed green here.
  // A gate that runs a different check than the pipeline is not a substitute for
  // the pipeline, and `tsc` is in `ci:check` while knip is not a type checker.
  postLlmResponseTasks: (input: { tasks: unknown[] }) => {
    postedBatches.push(input.tasks.length);
    return Promise.resolve(acceptedResponse(input.tasks.length));
  },
}));
// The evidence recorder writes through `@/db`, which reads `cloudflare:workers`
// — a Workers-only module vitest cannot resolve. Mocked at the *service*, same as
// the repositories above, so this suite never touches the database.
vi.mock("@/server/features/geo/services/vendorTaskRecorder", () => ({
  recordVendorTask,
}));

const { GeoPatrol } = await import("@/server/features/geo/services/GeoPatrol");

const TARGET = {
  id: "t1",
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  name: "Acme",
  createdAt: "2026-01-01T00:00:00.000Z",
  aliases: null,
};

// The real BillingCustomerContext needs no coercion: three strings and an
// optional projectId.
const CUSTOMER = {
  organizationId: "org_1",
  userEmail: "test@example.com",
  userId: "user_1",
  projectId: "p1",
};

/**
 * Build one vendor mention row.
 *
 * `citations` and `searchResults` are separate on purpose: they are different
 * sets in the real payload, and the difference between them is the gap. A helper
 * that derived one from the other would make that impossible to test.
 */
function mentionItem(
  options: {
    citations?: string[];
    searchResults?: string[] | null;
  } = {},
) {
  const citations = options.citations ?? ["https://acme.com/pricing"];
  return {
    question: "best geo tool",
    sources: citations.map((url) => ({
      url,
      title: "Pricing",
      domain: "acme.com",
    })),
    // `null` is what DataForSEO sends for google. The default here is a
    // non-null list so a test that does not care about the gap still exercises
    // the retrieval path.
    search_results:
      options.searchResults === null
        ? null
        : (options.searchResults ?? citations).map((url) => ({
            url,
            title: "Pricing",
            domain: "acme.com",
          })),
    ai_search_volume: 1200,
    last_response_at: "2026-05-01 00:00:00 +00:00",
  };
}

function reset(
  mentions: unknown[] = [],
  targets: Array<Record<string, unknown>> = [TARGET],
) {
  listTargets.mockReset().mockResolvedValue(targets);
  mentionsSearch.mockReset().mockResolvedValue(mentions);
  recordRun.mockReset().mockResolvedValue({ id: "snap_1" });
}

describe("GeoPatrol in queued mode", () => {
  /**
   * The queued branch was, until this change, **built, tested and unreachable**:
   * it required `input.queuePrompts` and nothing in production supplied one. The
   * tests below are the first that exercise it with no explicit prompts at all,
   * which is the only shape the scheduler now uses.
   */
  it("asks the project's saved prompts when the caller supplies none", async () => {
    listTargets.mockReset().mockResolvedValue([TARGET]);
    recordRun.mockClear();
    postedBatches.length = 0;
    promptsForQueuedRun
      .mockClear()
      .mockResolvedValue(["best crm", "acme pricing"]);

    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      mode: "queued",
      platforms: ["chat_gpt"],
    });

    // The prompts came from the project, not the caller.
    expect(promptsForQueuedRun).toHaveBeenCalledWith("p1");
    // And something was posted — the assertion that matters, because before the
    // fix this returned `promptsAsked: 0` with a note and no vendor call.
    expect(postedBatches.length).toBeGreaterThan(0);
    expect(result.promptsAsked).toBeGreaterThan(0);
    expect(result.answersArchived).toBe(0);
    // A queued run posts and returns; it archives nothing, and the archive fills
    // in when the answers arrive. A non-null snapshot here would mean it had
    // invented one.
    expect(result.snapshotId).toBeNull();
  });

  it("refuses when the project has no prompts, and says what to do about it", async () => {
    // A refusal that does not name the fix is a support ticket, and this
    // repository has found a dozen of the "correct, tested, unreachable" kind.
    // The note has to answer: what do I do?
    listTargets.mockReset().mockResolvedValue([TARGET]);
    postedBatches.length = 0;
    promptsForQueuedRun.mockClear().mockResolvedValue([]);

    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      mode: "queued",
      platforms: ["chat_gpt"],
    });

    expect(postedBatches).toEqual([]);
    expect(result.promptsAsked).toBe(0);
    expect(result.snapshotId).toBeNull();
    const note = result.notes.join(" ");
    expect(note).toMatch(/no saved prompts|none saved/i);
    // The two actions that fix it, both named.
    expect(note).toMatch(/add a prompt set/i);
    expect(note).toMatch(/live path/i);
  });

  it("still honours prompts the caller passes explicitly", async () => {
    // The explicit path is kept: a caller with prompts in hand — a test, a future
    // importer — should not have to write them to the database first. So the
    // project is never read when the caller knows better.
    listTargets.mockReset().mockResolvedValue([TARGET]);
    recordRun.mockClear();
    postedBatches.length = 0;
    promptsForQueuedRun.mockClear().mockResolvedValue(["from the project"]);

    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      mode: "queued",
      platforms: ["chat_gpt"],
      queuePrompts: ["from the caller"],
    });

    expect(promptsForQueuedRun).not.toHaveBeenCalled();
    expect(postedBatches.length).toBeGreaterThan(0);
    expect(result.promptsAsked).toBeGreaterThan(0);
  });
});

describe("GeoPatrol", () => {
  it("reports an unconfigured project instead of calling the vendor", async () => {
    listTargets.mockReset().mockResolvedValue([]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
    });
    expect(result.answersArchived).toBe(0);
    expect(result.notes[0]).toMatch(/no GEO targets/i);
    expect(mentionsSearch).not.toHaveBeenCalled();
  });

  it("archives a mention with its citations, storing no answer text we do not have", async () => {
    reset([mentionItem()]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    expect(result.answersArchived).toBe(1);
    const runInput = recordedRun();
    expect(runInput.answers[0].answer.answerText).toBeNull();
    expect(runInput.answers[0].citations[0].domain).toBe("acme.com");
  });

  it("records retrievals from search_results, not from the citation set", async () => {
    // The two are different sets. `sources` is what the model CITED;
    // `search_results` is everything it RETRIEVED, including unused entries.
    // Copying citations into retrievals — which an earlier version did — makes
    // the retrieved-but-uncited gap permanently empty, so the headline feature
    // would silently return "nothing in the gap" forever.
    reset([mentionItem({ searchResults: ["https://acme.com/a"] })]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    const answer = recordedRun().answers[0];
    expect(answer.retrievals).toEqual([
      { url: "https://acme.com/a", domain: "acme.com", rank: 1 },
    ]);
  });

  it("keeps a retrieved-but-uncited page in retrievals and out of citations", async () => {
    // The whole product in one assertion: a page the model read and passed over.
    reset([
      mentionItem({
        citations: ["https://acme.com/pricing"],
        searchResults: [
          "https://acme.com/pricing",
          "https://acme.com/comparison",
        ],
      }),
    ]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    const answer = recordedRun().answers[0];
    expect(answer.citations.map((c) => c.url)).toEqual([
      "https://acme.com/pricing",
    ]);
    // The uncited page is present as a retrieval, so the gap query can find it.
    expect(answer.retrievals?.map((r) => r.url)).toEqual([
      "https://acme.com/pricing",
      "https://acme.com/comparison",
    ]);
  });

  it("records no retrieval for Google, whose payload has no search_results", async () => {
    // DataForSEO returns `search_results: null` for google. Claiming a
    // retrieval we did not observe would invent the gap.
    reset([mentionItem({ searchResults: ["https://acme.com/a"] })]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["google_ai_overview"],
    });
    expect(recordedRun().answers[0].retrievals).toBeUndefined();
  });

  it("leaves retrievals undefined when ChatGPT returns no search_results", async () => {
    // "No retrieval data" and "the model retrieved nothing" are different
    // claims. Only the first is true here, and an empty array would claim the
    // second.
    reset([mentionItem({ searchResults: null })]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    expect(recordedRun().answers[0].retrievals).toBeUndefined();
  });

  it("skips a platform llm_mentions does not serve, and says so", async () => {
    reset([mentionItem()]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["perplexity"],
    });
    expect(mentionsSearch).not.toHaveBeenCalled();
    expect(result.answersArchived).toBe(0);
    // **The note used to end by claiming another job would collect it**, and no
    // such job runs. What matters now is that the platform is named, that the
    // absence is stated, and that nothing claims to cover it — so the assertion
    // pins all three rather than one phrase that a later edit could reword.
    expect(result.notes[0]).toContain("perplexity");
    expect(result.notes[0]).toMatch(/is not collected/i);
    expect(result.notes[0]).not.toMatch(/is collected by/i);
  });

  it("queries ChatGPT at US/en and records that it did", async () => {
    // DataForSEO serves ChatGPT mentions for US/en only. Asking for another
    // market returns an empty set that reads exactly like "not mentioned".
    reset(
      [mentionItem()],
      [{ ...TARGET, locationCode: 21167, languageCode: "de" }],
    );
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    const call = mentionsCall();
    expect(call.locationCode).toBe(2840);
    expect(call.languageCode).toBe("en");
    expect(result.notes.join(" ")).toMatch(/US\/en/);
  });

  it("treats an empty result as a finding, not a failure", async () => {
    reset([]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    expect(result.answersArchived).toBe(0);
    expect(result.snapshotId).toBeNull();
    expect(result.notes.join(" ")).toMatch(/no answers found/);
    expect(recordRun).not.toHaveBeenCalled();
  });

  it("keeps one platform's failure from discarding another's answers", async () => {
    mentionsSearch
      .mockReset()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce([mentionItem()]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt", "google_ai_overview"],
    });
    expect(result.answersArchived).toBe(1);
    expect(result.notes.join(" ")).toMatch(/rate limited/);
  });

  it("stops at the answer cap rather than spending past it", async () => {
    reset([mentionItem(), mentionItem(), mentionItem()]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt", "google_ai_overview"],
      maxAnswers: 2,
    });
    expect(result.answersArchived).toBe(2);
    expect(result.notes.join(" ")).toMatch(/cap/);
  });

  it("does not record a cost it cannot see", async () => {
    // The metered client captures cost in the billing ledger. A snapshot must
    // never carry an estimate in a column a reader would take for a receipt.
    reset([mentionItem()]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    expect(result.costUsd).toBe(0);
    const runInput = recordedRun();
    expect(runInput.costUsd).toBe(0);
  });

  it("skips a mention with no question rather than storing an empty prompt", async () => {
    // An empty prompt would be indistinguishable from "the model was asked
    // nothing", and it would poison every later filter on the archive.
    reset([{ ...mentionItem(), question: null }]);
    const result = await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    expect(result.answersArchived).toBe(0);
    expect(recordRun).not.toHaveBeenCalled();
  });
});
