import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as GeoAnswerModule from "./GeoAnswerRepository";
import type * as GeoSetupModule from "./GeoSetupRepository";

// Real in-memory SQLite so the ON CONFLICT clauses and the gap query's LEFT
// JOIN run as generated SQL. Which rows survive a duplicate URL, and what the gap
// query actually excludes, IS the contract here — a mocked builder chain cannot
// see either.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

// The executor runBatch hands builders inside its callback.
type Tx = Parameters<typeof GeoSetupModule.GeoSetupRepository.upsertTarget>[0];

// `runBatch` reaches the module-level `d1Db`, which needs a Workers runtime it
// cannot have under vitest. This handle lets the mock below execute the same
// builders against the in-memory client instead: the statements still run as
// real SQL — which is the entire reason for using real SQL here.
let testTx: Tx;

vi.mock("@/db/runBatch", () => ({
  DB_BATCH_SIZE: 100,
  runBatch: async (build: (tx: Tx) => Array<Promise<unknown>>) => {
    for (const statement of build(testTx)) await statement;
  },
  executeInBatches: async <T>(
    items: T[],
    buildStatement: (tx: Tx, item: T) => Promise<unknown>,
  ) => {
    for (const item of items) await buildStatement(testTx, item);
  },
}));

const PROJECT_ID = "proj_1";

let counter = 0;

let client: Client;
let tx: Tx;
let GeoAnswerRepository: typeof GeoAnswerModule.GeoAnswerRepository;
let GeoSetupRepository: typeof GeoSetupModule.GeoSetupRepository;
let platformSupportsRetrieval: typeof GeoSetupModule.platformSupportsRetrieval;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the libsql client is the same Drizzle query surface runBatch passes in
  tx = testDb as unknown as Tx;
  testTx = tx;

  // The tables come from the real migration, so the unique indexes the ON
  // CONFLICT clauses resolve against cannot drift from production DDL. The DROP
  // is skipped (nothing created it here) and a stub projects row satisfies the
  // foreign keys.
  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text);`,
      `INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES ('${PROJECT_ID}', 'Acme', 2840, 'en', '2026-01-01 00:00:00');`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // `0057` alters `projects`, and this harness creates that table by hand
      // above — so without it the schema is a column behind the code's.
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
    ].join("\n"),
  );

  GeoAnswerRepository = (await import("./GeoAnswerRepository"))
    .GeoAnswerRepository;
  const setup = await import("./GeoSetupRepository");
  GeoSetupRepository = setup.GeoSetupRepository;
  platformSupportsRetrieval = setup.platformSupportsRetrieval;
});

afterAll(() => {
  client.close();
});

/**
 * No `vi.resetModules()` here: the repositories are captured in `beforeAll` and
 * hold the mocked `db` handle. Resetting modules would discard them, and the next
 * test would re-import against a module graph where the mocks are no longer
 * installed. Each test seeds its own rows instead.
 */

/**
 * Insert a target, returning its id and the domain it was given.
 *
 * The domain defaults to a unique one per call: the suite shares a single
 * in-memory database, and `geo_targets` is unique on (project, domain, location,
 * language), so reusing a domain would collide with an earlier test's row instead
 * of testing anything. Pass an explicit domain when a test queries by it.
 */
async function seedTarget(domain?: string) {
  const resolved = domain ?? `brand-${counter++}.test`;
  const id = crypto.randomUUID();
  await GeoSetupRepository.upsertTarget(tx, {
    id,
    projectId: PROJECT_ID,
    domain: resolved,
    name: "Acme",
    locationCode: 2840,
    languageCode: "en",
  });
  return { id, domain: resolved };
}

/** Insert an answer with the given citations and retrievals. */
async function seedAnswer(input: {
  targetId: string;
  prompt?: string;
  platform?: "chat_gpt" | "perplexity";
  answerId?: string;
  citations?: string[];
  retrievals?: string[];
  answeredAt?: string;
}) {
  const answerId = input.answerId ?? crypto.randomUUID();
  await GeoAnswerRepository.insertAnswers([
    {
      answer: {
        id: answerId,
        projectId: PROJECT_ID,
        targetId: input.targetId,
        prompt: input.prompt ?? "best geo tool",
        answerText: "An answer",
        platform: input.platform ?? "chat_gpt",
        source: "mentions_search",
        locationCode: 2840,
        languageCode: "en",
        answeredAt: input.answeredAt ?? "2026-05-01 00:00:00",
      },
      citations: (input.citations ?? []).map((url, i) => ({
        url,
        domain: new URL(url).hostname,
        rank: i + 1,
      })),
      retrievals: (input.retrievals ?? []).map((url, i) => ({
        url,
        domain: new URL(url).hostname,
        rank: i + 1,
      })),
    },
  ]);
  return answerId;
}

describe("Geo answer archive", () => {
  it("stores a citation set and reads it back whole", async () => {
    const { id: targetId } = await seedTarget();
    const answerId = await seedAnswer({
      targetId,
      citations: ["https://acme.com/pricing", "https://other.com/review"],
    });

    const found = await GeoAnswerRepository.getAnswerWithSets(
      PROJECT_ID,
      answerId,
    );
    expect(found?.answer.prompt).toBe("best geo tool");
    expect(found?.citations).toHaveLength(2);
  });

  it("keeps citations and retrievals as separate sets", async () => {
    const { id: targetId } = await seedTarget();
    const answerId = await seedAnswer({
      targetId,
      citations: ["https://acme.com/pricing"],
      retrievals: ["https://acme.com/pricing", "https://acme.com/comparison"],
    });

    const found = await GeoAnswerRepository.getAnswerWithSets(
      PROJECT_ID,
      answerId,
    );
    expect(found?.citations.map((c) => c.url)).toEqual([
      "https://acme.com/pricing",
    ]);
    // The retrieved-but-uncited page is present as a retrieval and absent as a
    // citation. Collapsing the two sets is the failure the schema prevents.
    expect(found?.retrievals).toHaveLength(2);
  });

  it("returns only pages retrieved WITHOUT a citation — the gap", async () => {
    const { id: targetId, domain } = await seedTarget();
    const page = (slug: string) => `https://${domain}/${slug}`;
    await seedAnswer({
      targetId,
      citations: [page("pricing")],
      retrievals: [
        page("pricing"), // cited
        page("comparison"), // retrieved, never cited
        page("pricing-guide"), // retrieved, never cited
      ],
    });

    const gaps = await GeoAnswerRepository.listCitationGaps(
      PROJECT_ID,
      targetId,
      "chat_gpt",
      domain,
    );
    // No sort: the query has no guaranteed order, and neither `toSorted()` (the
    // repo's lib target predates es2023) nor a spread-then-sort is acceptable
    // here. Comparing as a set tests the actual claim — which URLs are in the
    // gap — without depending on row order.
    expect(new Set(gaps.map((g) => g.url))).toEqual(
      new Set([page("comparison"), page("pricing-guide")]),
    );
  });

  it("returns an empty gap for another project's brand rather than leaking it", async () => {
    const { id: targetId, domain } = await seedTarget();
    await seedAnswer({
      targetId,
      citations: [],
      retrievals: [`https://${domain}/secret`],
    });
    expect(
      await GeoAnswerRepository.listCitationGaps(
        "other_project",
        targetId,
        "chat_gpt",
        domain,
      ),
    ).toEqual([]);
  });

  it("never mixes platforms when counting", async () => {
    const { id: targetId } = await seedTarget();
    // countAnswers is project-scoped by design, and the suite shares one
    // database, so assert the DELTA this test contributes rather than an
    // absolute. What matters is that the two platforms stay separate.
    const before = {
      chatGpt: await GeoAnswerRepository.countAnswers(PROJECT_ID, "chat_gpt"),
      perplexity: await GeoAnswerRepository.countAnswers(
        PROJECT_ID,
        "perplexity",
      ),
      all: await GeoAnswerRepository.countAnswers(PROJECT_ID),
    };

    await seedAnswer({ targetId, platform: "chat_gpt" });
    await seedAnswer({ targetId, platform: "perplexity" });
    await seedAnswer({ targetId, platform: "perplexity" });

    const after = {
      chatGpt: await GeoAnswerRepository.countAnswers(PROJECT_ID, "chat_gpt"),
      perplexity: await GeoAnswerRepository.countAnswers(
        PROJECT_ID,
        "perplexity",
      ),
      all: await GeoAnswerRepository.countAnswers(PROJECT_ID),
    };

    expect(after.chatGpt - before.chatGpt).toBe(1);
    expect(after.perplexity - before.perplexity).toBe(2);
    expect(after.all - before.all).toBe(3);
  });

  it("does not double-count a URL cited twice in one answer", async () => {
    const { id: targetId } = await seedTarget();
    await seedAnswer({
      targetId,
      citations: ["https://acme.com/a", "https://acme.com/a"],
    });
    const found = await GeoAnswerRepository.listAnswersForTarget(
      PROJECT_ID,
      targetId,
      "chat_gpt",
    );
    expect(found).toHaveLength(1);
    const withSets = await GeoAnswerRepository.getAnswerWithSets(
      PROJECT_ID,
      found[0]?.id ?? "",
    );
    expect(withSets?.citations).toHaveLength(1);
  });

  it("keeps two captures of the same prompt as separate rows", async () => {
    const { id: targetId } = await seedTarget();
    // A prompt unique to this test: earlier tests in the shared database also
    // seed "best geo tool", and this query is project-scoped by design.
    const prompt = `best geo tool #${counter}`;
    await seedAnswer({
      targetId,
      prompt,
      answeredAt: "2026-05-01 00:00:00",
      answerId: "a1",
    });
    await seedAnswer({
      targetId,
      prompt,
      answeredAt: "2026-06-01 00:00:00",
      answerId: "a2",
    });

    const history = await GeoAnswerRepository.listAnswersForPrompt(
      PROJECT_ID,
      prompt,
      "chat_gpt",
    );
    // Newest first, both retained: the diff is the product.
    expect(history.map((a) => a.answeredAt)).toEqual([
      "2026-06-01 00:00:00",
      "2026-05-01 00:00:00",
    ]);
  });

  it("exposes the retrieval-capability flag so an empty gap can be explained", () => {
    // Google AI Overviews returns citations but not retrievals. Getting this
    // wrong would imply a brand has no gap when we simply cannot see one.
    expect(platformSupportsRetrieval("chat_gpt")).toBe(true);
    expect(platformSupportsRetrieval("google_ai_overview")).toBe(false);
  });
});
