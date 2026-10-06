import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The prompt-set generator's three reads, against a real database.
 *
 * ## Why each one needs a database test rather than a mock
 *
 * **`listAiKeywordDemand` picks "the latest month per keyword", and that is the
 * whole claim.** A mocked builder returns whatever it was told to; only real SQL can
 * show that ordering by `month DESC` and taking the first row per keyword returns
 * *March's* volume when March is the newest, and not January's. The failure is
 * silent and it is the expensive direction: a set ranked by a stale month proposes
 * the topics that used to matter.
 *
 * **`listKeywordIntents` is a join, and a join that misses returns nulls.** Every
 * keyword coming back unclassified is a prompt set of `what is …` questions with
 * nothing to point at — and it would still look like a working feature.
 *
 * Same harness as `GeoRunRepository.citations.db.test.ts`: real migrations, real
 * SQLite, and the two application tables (`projects`, `keyword_metrics`) created by
 * hand because they come from the application migrations rather than the GEO one.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "project_1";
const OTHER_PROJECT = "project_2";

let client: Client;
let repo: {
  listAiKeywordDemand: (
    projectId: string,
  ) => Promise<Array<{ keyword: string; aiSearchVolume: number | null }>>;
  listKeywordIntents: (
    projectId: string,
    keywords: string[],
  ) => Promise<Array<{ keyword: string; intent: string | null }>>;
  listRecentArchivedPrompts: (
    projectId: string,
    limit?: number,
  ) => Promise<string[]>;
};

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      // The application tables the GEO migrations reference but do not create.
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      `CREATE TABLE keyword_metrics (
         id integer PRIMARY KEY AUTOINCREMENT,
         project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         keyword text NOT NULL,
         location_code integer NOT NULL,
         language_code text NOT NULL DEFAULT 'en',
         search_volume integer,
         cpc real,
         competition real,
         keyword_difficulty integer,
         intent text,
         monthly_searches text,
         fetched_at text NOT NULL DEFAULT (current_timestamp)
       );`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The snapshot columns the sibling repository test also needs. Listed as
      // literals because `migration-coverage.test.ts` reads them as literals.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  repo = (await import("./GeoRunRepository")).GeoRunRepository;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  for (const table of [
    "ai_keyword_metrics",
    "keyword_metrics",
    "geo_answers",
    "projects",
  ]) {
    await client.execute(`DELETE FROM ${table}`);
  }
  for (const id of [PROJECT, OTHER_PROJECT]) {
    await client.execute({
      sql: "INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id) VALUES (?,?,?,?,?,?)",
      args: [id, "Acme", 2840, "en", "2026-01-01 00:00:00", "org_1"],
    });
  }
});

async function addDemand(
  projectId: string,
  keyword: string,
  month: string,
  aiSearchVolume: number | null,
) {
  await client.execute({
    sql: "INSERT INTO ai_keyword_metrics (keyword, project_id, location_code, language_code, ai_search_volume, month, captured_at) VALUES (?,?,?,?,?,?,?)",
    args: [
      keyword,
      projectId,
      2840,
      "en",
      aiSearchVolume,
      month,
      `${month}-01T00:00:00Z`,
    ],
  });
}

async function addIntent(
  projectId: string,
  keyword: string,
  intent: string | null,
) {
  await client.execute({
    sql: "INSERT INTO keyword_metrics (project_id, keyword, location_code, language_code, intent) VALUES (?,?,?,?,?)",
    args: [projectId, keyword, 2840, "en", intent],
  });
}

async function addAnswer(
  projectId: string,
  id: string,
  prompt: string,
  answeredAt: string,
) {
  await client.execute({
    sql: "INSERT INTO geo_answers (id, project_id, prompt, platform, source, location_code, language_code, answered_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [
      id,
      projectId,
      prompt,
      "chat_gpt",
      "llm_responses",
      2840,
      "en",
      answeredAt,
    ],
  });
}

describe("reading the prompt-set seeds", () => {
  it("takes the newest month's demand per keyword, whatever order rows arrived in", async () => {
    // Inserted oldest-last on purpose: the reader must order, not trust insertion.
    await addDemand(PROJECT, "crm", "2026-03", 900);
    await addDemand(PROJECT, "crm", "2026-01", 500);
    await addDemand(PROJECT, "crm", "2026-02", 700);

    expect(await repo.listAiKeywordDemand(PROJECT)).toEqual([
      { keyword: "crm", aiSearchVolume: 900 },
    ]);
  });

  it("keeps a null newest month as null rather than falling back to an older number", async () => {
    // "Not measured in March" is not "500 in January", and reporting the older
    // figure would rank the keyword on a number that is no longer current.
    await addDemand(PROJECT, "crm", "2026-01", 500);
    await addDemand(PROJECT, "crm", "2026-03", null);

    expect(await repo.listAiKeywordDemand(PROJECT)).toEqual([
      { keyword: "crm", aiSearchVolume: null },
    ]);
  });

  it("returns only this project's keywords", async () => {
    await addDemand(PROJECT, "mine", "2026-03", 10);
    await addDemand(OTHER_PROJECT, "theirs", "2026-03", 999);

    const rows = await repo.listAiKeywordDemand(PROJECT);
    expect(rows.map((row) => row.keyword)).toEqual(["mine"]);
  });

  it("reads intent for exactly the keywords it was asked about", async () => {
    await addIntent(PROJECT, "crm", "commercial");
    await addIntent(PROJECT, "seo", "informational");
    // Same keyword, another project: it must not answer for this one.
    await addIntent(OTHER_PROJECT, "analytics", "transactional");

    const rows = await repo.listKeywordIntents(PROJECT, ["crm", "analytics"]);
    expect(rows).toEqual([{ keyword: "crm", intent: "commercial" }]);
  });

  it("does not query at all for an empty keyword list", async () => {
    // A guard rather than an optimisation: `IN ()` is a syntax error in some
    // dialects, and an empty set is the first-project case rather than an edge case.
    expect(await repo.listKeywordIntents(PROJECT, [])).toEqual([]);
  });

  it("returns archived questions once each, most recent first, blanks dropped", async () => {
    await addAnswer(
      PROJECT,
      "a1",
      "best crm for small teams",
      "2026-01-01T00:00:00Z",
    );
    await addAnswer(
      PROJECT,
      "a2",
      "  BEST   crm for small teams ",
      "2026-03-01T00:00:00Z",
    );
    await addAnswer(PROJECT, "a3", "is acme reliable", "2026-02-01T00:00:00Z");
    await addAnswer(PROJECT, "a4", "   ", "2026-04-01T00:00:00Z");
    await addAnswer(
      OTHER_PROJECT,
      "b1",
      "another project's question",
      "2026-05-01T00:00:00Z",
    );

    expect(await repo.listRecentArchivedPrompts(PROJECT)).toEqual([
      // The duplicate is kept as the *most recent* spelling, and normalised on the
      // way in so the box it fills has one line per question.
      "BEST crm for small teams",
      "is acme reliable",
    ]);
  });
});
