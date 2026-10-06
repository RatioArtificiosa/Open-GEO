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
 * The co-citation read, against a real database.
 *
 * ## Why this is not covered by the pure test
 *
 * `buildCoCitations` is tested thoroughly — pairing, weighting, the caps — but it
 * is handed rows. **Which rows it is handed is the claim**, and a mocked query
 * builder returns whatever it was told to, so it cannot catch a missing `WHERE`.
 * That is not hypothetical here: `geo_answers` carries no `snapshot_id`, so
 * membership comes through `geo_snapshot_answers`, and a reader that filtered on
 * the wrong table would pull every run the project ever made into one graph.
 *
 * Same reasoning and same harness as `scheduledGeoPatrol.test.ts` and
 * `visibilityForecastReads.db.test.ts`: real migrations, real SQLite, so a wrong
 * column name fails here rather than in production.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "project_1";
const OTHER_PROJECT = "project_2";
const RUN_A = "snapshot_a";
const RUN_B = "snapshot_b";

let client: Client;
// Declared structurally rather than as a `typeof import(...)` annotation, which
// this repository forbids in favour of an explicit type.
let listSnapshotCitations: (
  projectId: string,
  snapshotId: string,
) => Promise<Array<{ answerId: string; domain: string | null }>>;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      // `projects` is an application table, created by a different migration than
      // the GEO one below, and every GEO row carries a foreign key to it — so it
      // has to exist first or SQLite refuses the inserts with the unhelpful
      // `no such table: main.projects`.
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The snapshot row is selected whole, so every later column has to exist:
      // 0055 adds `prompts_asked`, 0056 `target_id`, 0057 the acquisition mode.
      // (0056's own header says the reader filters on `target_id` — the same
      // reason the forecast test applies it.)
      //
      // **Listed as literals rather than looped over an array of names.**
      // `migration-coverage.test.ts` reads this file to check which migrations a
      // repository test applies, and it reads literals: a computed filename made
      // it report this test as stopping at 0048 and fail the build.
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

  ({
    GeoRunRepository: { listSnapshotCitations },
  } = await import("./GeoRunRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  for (const table of [
    "geo_answer_citations",
    "geo_answer_retrievals",
    "geo_snapshot_answers",
    "geo_answers",
    "geo_snapshots",
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

async function addRun(
  projectId: string,
  snapshotId: string,
  answerId: string,
  domains: Array<string | null>,
) {
  await client.execute({
    sql: "INSERT INTO geo_snapshots (id, project_id, started_at, status, created_by) VALUES (?,?,?,?,?)",
    args: [snapshotId, projectId, "2026-01-01 00:00:00", "complete", "user"],
  });
  await client.execute({
    sql: "INSERT INTO geo_answers (id, project_id, prompt, platform, source, location_code, language_code, answered_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [
      answerId,
      projectId,
      "best geo tool",
      "chat_gpt",
      "llm_responses",
      2840,
      "en",
      "2026-01-01 00:00:00",
    ],
  });
  await client.execute({
    sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?,?)",
    args: [snapshotId, answerId],
  });
  for (const [index, domain] of domains.entries()) {
    await client.execute({
      sql: "INSERT INTO geo_answer_citations (answer_id, url, domain) VALUES (?,?,?)",
      args: [answerId, `https://${domain ?? "unknown"}/page-${index}`, domain],
    });
  }
}

describe("reading a run's citations for the co-citation graph", () => {
  it("returns one run's answers and nothing from another", async () => {
    await addRun(PROJECT, RUN_A, "answer_a", ["reddit.com", "kbb.com"]);
    await addRun(PROJECT, RUN_B, "answer_b", ["caranddriver.com"]);

    const rows = await listSnapshotCitations(PROJECT, RUN_A);

    // Compared as a Set rather than a sorted array: this repository's `lib` target
    // predates `toSorted`, `sort` mutates and trips the lint, and a set tests the
    // claim without depending on an order the read never promised.
    expect(new Set(rows.map((row) => row.domain))).toEqual(
      new Set(["kbb.com", "reddit.com"]),
    );
    // The answer id travels with the host, because the pairing groups on it.
    expect(new Set(rows.map((row) => row.answerId))).toEqual(
      new Set(["answer_a"]),
    );
  });

  it("returns nothing for a run belonging to another project", async () => {
    await addRun(OTHER_PROJECT, RUN_A, "answer_a", ["reddit.com"]);
    expect(await listSnapshotCitations(PROJECT, RUN_A)).toEqual([]);
  });

  it("returns nothing for a run that does not exist", async () => {
    expect(await listSnapshotCitations(PROJECT, "no_such_run")).toEqual([]);
  });

  it("keeps a null domain rather than dropping the row", async () => {
    // The *builder* decides what a hostless citation means. Dropping it here would
    // hide the fact from the one place that can count it.
    await addRun(PROJECT, RUN_A, "answer_a", ["reddit.com", null]);
    const rows = await listSnapshotCitations(PROJECT, RUN_A);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.domain === null)).toHaveLength(1);
  });
});
