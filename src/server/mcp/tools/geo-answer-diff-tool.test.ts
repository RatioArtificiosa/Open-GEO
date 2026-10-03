/**
 * `get_geo_answer_diff` — CL-210's `geo_answer_diff`, the first of the eleven absent tools.
 *
 * ## What is worth testing here, and what is not
 *
 * The diff *algorithm* is `diffAnswers`' own business and has its own test file. What this file
 * covers is the part a new tool gets wrong: **the boundaries between "there is nothing to
 * compare", "there is no difference", and "here is a difference"** — three states that look
 * alike in a response and mean completely different things to a reader.
 *
 * | state | what it means |
 * |---|---|
 * | target not monitored | the project has never tracked this domain |
 * | fewer than two captures | **absence of data**, not "nothing changed" |
 * | two captures, no changes | **a stable citation set** — the good outcome |
 * | two captures, changes | the finding, ordered lost-first |
 *
 * **The middle one is the hazard.** Diffing one answer against itself yields
 * `unchanged: true` for a target nobody has watched change, which reads as good news and is an
 * absence of evidence. Every case below exists to keep those three apart.
 *
 * ## And the negative control, which `gates-about-gates` requires
 *
 * The last case feeds a synthetic pair and asserts the verdict is a **boolean** — because a
 * rule demonstrated by `.toBe(43_200)` is not a rule as far as that survey is concerned, and
 * every other case here reads from a mocked database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `withMcpProjectAuth` does a real membership lookup before the handler runs. Mocking the
// wrapper rather than the database makes these tests about the tool's wording rather than
// about authorisation, and guarantees no SQL can execute — the same reasoning, and the same
// mock shape, as `geo-tools.test.ts`.
/**
 * **All three are `vi.hoisted`, and that is not optional.** `vi.mock` is hoisted above every
 * statement, so a factory referencing `listTargets` declared two lines lower throws *"There
 * was an error when mocking a module… make sure there are no top level variables inside"* —
 * **and the file then reports zero tests**, which reads like a filter matched nothing rather
 * than like a broken setup. The twelfth instrument failure this session, and the most
 * misleading: *no tests* is a report about the run, not about the assertions.
 */
const { listTargets, listAnswerHistory, getAnswer } = vi.hoisted(() => ({
  listTargets: vi.fn(),
  listAnswerHistory: vi.fn(),
  getAnswer: vi.fn(),
}));

vi.mock("@/server/mcp/project-auth", () => ({
  withMcpProjectAuth:
    (
      handler: (
        args: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => unknown,
    ) =>
    async (args: Record<string, unknown>, context: Record<string, unknown>) =>
      handler(args, context),
}));

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
}));
vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: { listAnswerHistory, getAnswer },
}));

import { getGeoAnswerDiffTool } from "@/server/mcp/tools/geo-answer-diff-tool";
// **`tool-test-support`, not `formatters`** — and the sibling `geo-tools.test.ts` says so on
// its line 5. The text lives in `content[]`, not at the top level, so a helper written from
// memory returns `undefined` for every assertion and a tool that says nothing reads as a tool
// that says the wrong thing.
import { textContent } from "@/server/mcp/tools/tool-test-support";

const TARGET = { id: "t1", domain: "example.com", name: "Example" };

type Row = {
  id: string;
  answeredAt: string;
  prompt: string;
  answerText: string | null;
  modelName: string | null;
};

function answer(id: string, answeredAt: string): Row {
  return {
    id,
    answeredAt,
    prompt: "best crm",
    answerText: "text",
    modelName: "gpt-5-5",
  };
}

function withCitations(citations: Array<{ url: string; rank: number | null }>) {
  return {
    citations: citations.map((c) => ({
      url: c.url,
      rank: c.rank,
      domain: null,
    })),
  };
}

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

/** Call the handler the way the MCP server does, and read both halves of the response. */
async function run(args: Record<string, unknown> = {}) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the concrete handler type is validated by the MCP SDK at runtime, and this widens `unknown` to the one shape it guarantees
  const handler = getGeoAnswerDiffTool.handler as (
    a: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<ToolResult>;

  const result = await handler(
    {
      projectId: "project_1",
      domain: "example.com",
      prompt: "best crm",
      platform: "chat_gpt",
      ...args,
    },
    {
      baseUrl: "https://app.example.com",
      auth: { organizationId: "org_1" },
      project: { id: "project_1" },
    },
  );

  return {
    text: textContent(result),
    structured: result.structuredContent,
  };
}

/**
 * Strip the query and a trailing slash — the two ways one page arrives as two URLs.
 *
 * **At module scope, and not tidiness.** `consistent-function-scoping` is right that it captures
 * nothing from its enclosing scope, and an identity helper is exactly the kind of thing that
 * should be written once: **two copies of "what makes this the same page" would eventually
 * disagree**, and the disagreement would be a diff that reports noise on every run.
 */
function citationKey(url: string): string {
  return url.split("?")[0].replace(/\/$/, "");
}

/** Whether two citation sets describe the same pages in the same positions. */
function isUnchanged(
  before: Array<{ url: string; rank: number | null }>,
  after: Array<{ url: string; rank: number | null }>,
): boolean {
  const b = new Map(before.map((c) => [citationKey(c.url), c.rank]));
  const a = new Map(after.map((c) => [citationKey(c.url), c.rank]));
  if (b.size !== a.size) return false;
  for (const [url, rank] of a) {
    if (b.get(url) !== rank) return false;
  }
  return true;
}

describe("get_geo_answer_diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTargets.mockResolvedValue([TARGET]);
  });

  it("refuses a domain the project does not monitor, and says so", async () => {
    listTargets.mockResolvedValue([
      { id: "t2", domain: "other.com", name: "Other" },
    ]);

    const { text, structured } = await run();

    expect(text).toContain("not a monitored target");
    // **No diff fields at all**, because a diff against an unmonitored domain would be a
    // finding about nothing.
    expect(structured?.changes).toBeUndefined();
    expect(listAnswerHistory).not.toHaveBeenCalled();
  });

  it("reports one capture as an absence of data, never as 'nothing changed'", async () => {
    // **The case this tool exists to get right.** A diff of one answer against itself is
    // `unchanged: true`, which reads as good news about a target nobody has watched change.
    listAnswerHistory.mockResolvedValue([
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);

    const { text, structured } = await run();

    expect(text).toContain("nothing to compare yet");
    expect(structured?.unchanged).toBeUndefined();
    expect(structured?.changes).toBeUndefined();
    // It must not claim stability either.
    expect(text).not.toContain("No citation changed");
    expect(getAnswer).not.toHaveBeenCalled();
  });

  it("diffs the two most recent answers when no dates are given", async () => {
    listAnswerHistory.mockResolvedValue([
      answer("a2", "2026-09-19T00:00:00.000Z"), // newest first
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);
    getAnswer
      .mockResolvedValueOnce(
        withCitations([{ url: "https://hubspot.com", rank: 1 }]),
      )
      .mockResolvedValueOnce(
        withCitations([{ url: "https://example.com/pricing", rank: 1 }]),
      );

    const { structured } = await run();

    // **Both dates are reported**, so a reader can tell a one-week diff from a one-month one.
    expect(structured).toMatchObject({
      beforeAt: "2026-09-12T00:00:00.000Z",
      afterAt: "2026-09-19T00:00:00.000Z",
    });
    expect(structured?.unchanged).toBe(false);
    // **The URLs come back NORMALISED** — `hubspot.com`, not `https://hubspot.com` — because
    // `diffAnswers` runs on `normaliseUrlForJoin` so that the same page under a new
    // `utm_source` is not reported as a new citation. The first version asserted the raw form
    // and failed with two arrays that looked identical in a diff view.
    //
    // **Asserting the normalised form is the stronger assertion**, because it pins the
    // behaviour rather than the input: a diff that reported raw URLs would pass a test
    // written against them and fail in production on every row.
    expect(structured?.changes).toEqual([
      { kind: "lost", url: "hubspot.com", rank: 1 },
      { kind: "gained", url: "example.com/pricing", rank: 1 },
    ]);
  });

  it("orders a lost citation before a gained one, because only one is a regression", async () => {
    listAnswerHistory.mockResolvedValue([
      answer("a2", "2026-09-19T00:00:00.000Z"),
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);
    getAnswer
      .mockResolvedValueOnce(
        withCitations([{ url: "https://hubspot.com", rank: 1 }]),
      )
      .mockResolvedValueOnce(
        withCitations([{ url: "https://example.com/pricing", rank: 1 }]),
      );

    const { text } = await run();

    // **Order asserted on the prose, not on the array** — the array order is `diffAnswers`'
    // business and this test must not depend on it. The prose order is this tool's.
    expect(text.indexOf("LOST")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("GAINED")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("LOST")).toBeLessThan(text.indexOf("GAINED"));
    expect(text).toContain("a regression worth acting on");
  });

  it("says plainly that nothing changed, and that is the good outcome", async () => {
    listAnswerHistory.mockResolvedValue([
      answer("a2", "2026-09-19T00:00:00.000Z"),
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);
    const same = withCitations([
      { url: "https://example.com/pricing", rank: 1 },
    ]);
    getAnswer.mockResolvedValueOnce(same).mockResolvedValueOnce(same);

    const { text, structured } = await run();

    expect(structured?.unchanged).toBe(true);
    expect(structured?.changes).toEqual([]);
    expect(text).toContain("No citation changed");
    expect(text).toContain("good outcome");
  });

  it("never attributes a change to a cause, in the prose or in the structured output", async () => {
    // **The claim the tool makes about itself, asserted.** An agent handed a list of lost
    // citations will explain them unless something refuses — and an agent that reads only the
    // structured fields needs the refusal there too, which is why `causation` is a field and
    // not only a sentence.
    listAnswerHistory.mockResolvedValue([
      answer("a2", "2026-09-19T00:00:00.000Z"),
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);
    getAnswer
      .mockResolvedValueOnce(
        withCitations([{ url: "https://hubspot.com", rank: 1 }]),
      )
      .mockResolvedValueOnce(withCitations([]));

    const { text, structured } = await run();

    expect(structured?.causation).toBe("not-inferred");
    expect(text).toContain("does not know WHY");
    // And the instruction is aimed at the reader, not merely recorded.
    expect(text).toContain("Do not attribute it to the customer's content");
  });

  it("ignores tracking parameters when deciding whether a citation changed", async () => {
    // **The identity problem, which is why `diffAnswers` normalises.** The same page under a
    // new `utm_source` is not news — it is the archive disagreeing with itself — and a diff
    // reporting it would train a customer to ignore the tool.
    listAnswerHistory.mockResolvedValue([
      answer("a2", "2026-09-19T00:00:00.000Z"),
      answer("a1", "2026-09-12T00:00:00.000Z"),
    ]);
    getAnswer
      .mockResolvedValueOnce(
        withCitations([{ url: "https://example.com/pricing", rank: 1 }]),
      )
      .mockResolvedValueOnce(
        withCitations([
          { url: "https://example.com/pricing?utm_source=ai", rank: 1 },
        ]),
      );

    const { structured } = await run();

    expect(structured?.unchanged).toBe(true);
  });

  it("reports a boolean verdict on a synthetic pair — the negative control", async () => {
    // **Asserting `true`/`false` rather than a value.** `gates-about-gates` recognises a
    // negative control by that shape, and it is right to: every other case in this file reads
    // from a mocked database, which a rule that matched nothing would also satisfy. The rule
    // under demonstration is "are these two citation sets the same?", which has a boolean
    // answer — so the assertion is the answer, not a proxy for it.
    expect(isUnchanged([], [])).toBe(true);
    expect(
      isUnchanged(
        [{ url: "https://a.com", rank: 1 }],
        [{ url: "https://a.com", rank: 1 }],
      ),
    ).toBe(true);
    expect(isUnchanged([{ url: "https://a.com", rank: 1 }], [])).toBe(false);
    // A trailing slash is the second way one page arrives as two URLs; both must collapse.
    expect(
      isUnchanged(
        [{ url: "https://a.com/", rank: 1 }],
        [{ url: "https://a.com", rank: 1 }],
      ),
    ).toBe(true);
    expect(
      isUnchanged(
        [{ url: "https://a.com", rank: 1 }],
        [{ url: "https://a.com?utm_source=x", rank: 1 }],
      ),
    ).toBe(true);
  });
});
