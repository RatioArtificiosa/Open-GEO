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

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
}));
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: { recordRun },
}));
vi.mock("@/server/lib/dataforseo/client", () => ({
  createDataforseoClient: () => ({ aiSearch: { mentionsSearch } }),
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

function mentionItem(overrides: Record<string, unknown> = {}) {
  return {
    question: "best geo tool",
    sources: [
      { url: "https://acme.com/pricing", title: "Pricing", domain: "acme.com" },
    ],
    ai_search_volume: 1200,
    last_response_at: "2026-05-01 00:00:00 +00:00",
    ...overrides,
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

  it("records a retrieval for ChatGPT, which reports one", async () => {
    reset([mentionItem()]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["chat_gpt"],
    });
    const runInput = recordedRun();
    expect(runInput.answers[0].retrievals).toHaveLength(1);
  });

  it("records no retrieval for Google, which does not report one", async () => {
    // The llm_mentions payload does not separate retrieved from cited. Claiming
    // a retrieval we did not observe would invent the gap.
    reset([mentionItem()]);
    await GeoPatrol.run({
      projectId: "p1",
      customer: CUSTOMER,
      createdBy: "schedule",
      platforms: ["google_ai_overview"],
    });
    const runInput = recordedRun();
    expect(runInput.answers[0].retrievals).toBeUndefined();
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
    expect(result.notes[0]).toMatch(/not served by llm_mentions/);
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
    reset([mentionItem({ question: null })]);
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
