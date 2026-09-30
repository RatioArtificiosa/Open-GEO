import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoService as GeoServiceNamespace } from "./GeoService";

/**
 * The run denominator, against a real database.
 *
 * ## Why this test exists at all
 *
 * `geo_snapshots.prompts_asked` is the denominator for every rate the product
 * publishes about a run. Before this column the forecast held a numerator and no
 * denominator, and the two ways out were both unacceptable: cast the gap away, or
 * invent a sample size — and an invented sample **narrows** the confidence band,
 * which is precisely the number the feature exists to protect.
 *
 * So the column is written deliberately, per acquisition path, and the states are
 * distinguished:
 *
 * - **null** — the run cannot say what it asked. The Live path calls
 *   `llm_mentions/search`, which takes a *domain* and returns only the prompts
 *   that mentioned the brand. The vendor picks the prompt set and never discloses
 *   its size; `limit` caps results, not questions.
 * - **0** — the run asked and got nothing, or had nothing to ask. A measured
 *   zero, which is a different sentence from "we cannot say".
 *
 * The tests below run against real in-memory SQLite built from the real
 * migrations, because this claim is about rows actually landing in columns — a
 * mock would pass while the column silently stayed null.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

let client: Client;
let GeoService: typeof GeoServiceNamespace;

/**
 * A fresh answer id per call, because `geo_answers.id` is a primary key and two
 * runs in one test both archive an answer.
 *
 * The first three tests were written with a shared constant and failed on
 * `UNIQUE constraint failed: geo_answers.id` — a fixture that cannot be
 * distinguished from a product bug, which is the worst kind of test failure to
 * leave lying around.
 */
let answerSeq = 0;

const NOW = new Date("2026-03-15T09:00:00.000Z");

const ANSWER = {
  answer: {
    id: "a1",
    projectId: "p1",
    targetId: "t1",
    promptSetId: null,
    platform: "chat_gpt" as const,
    locationCode: 2840,
    languageCode: "en",
    prompt: "best crm for small teams",
    answerText: "Answer text",
    modelName: "gpt-5",
    // `mentions_search`, because that is the Live acquisition path this
    // column's null case describes. A fixture that said `llm_responses` would
    // be asserting the denominator of the one path that *knows* its own.
    source: "mentions_search" as const,
    answeredAt: NOW.toISOString(),
    vendorTaskId: null,
    rawJson: null,
  },
};

/** The same answer under a fresh id, so two runs can coexist in one test. */
const answer = () => ({
  answer: { ...ANSWER.answer, id: `a${++answerSeq}` },
});

beforeEach(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    /**
     * `runBatch` takes a **build callback**, not a list of statements, and
     * hands the callback a `tx`. The real D1 `batch` is a driver-only API, so
     * this passes the real libsql-backed `testDb` as the `tx` and awaits the
     * query builders it produces.
     *
     * Awaiting them is not a shortcut: a Drizzle query builder built on `testDb`
     * *is* the query, and awaiting it compiles it through the same SQLite
     * dialect and executes it against this real in-memory database. A column the
     * schema declares and the migration lacks fails here exactly as it would in
     * D1.
     *
     * The first version of this mock accepted an array and tried to compile
     * statements it was never given, so it silently did nothing and the suite
     * failed inside `d1Db.batch` instead — the same "died for an unrelated
     * reason" trap this codebase has hit three times.
     */
    runBatch: async (
      build: (tx: typeof testDb) => readonly Promise<unknown>[],
    ) => {
      for (const statement of build(testDb)) await statement;
    },
  }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The denominator. Applying the real migration rather than declaring the
      // column is the point: a test that hand-writes the DDL proves nothing
      // about whether the generated migration matches the schema.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  await client.executeMultiple(
    "DELETE FROM geo_snapshot_answers; DELETE FROM geo_answers; DELETE FROM geo_snapshots; DELETE FROM geo_targets; DELETE FROM projects;",
  );
  await client.execute({
    sql: "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?,?,?,?,?)",
    args: ["p1", "Acme", 2840, "en", NOW.toISOString()],
  });
  // The answer's target, because `geo_answers.target_id` references it and the
  // foreign key is enforced. A fixture that skipped it would fail on the insert
  // rather than on the thing under test.
  await client.execute({
    sql: "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?,?,?,?,?,?,?)",
    args: ["t1", "p1", "Acme", "acme.com", 2840, "en", NOW.toISOString()],
  });

  // The module registry is reset before each test, so the dynamic import below
  // binds `@/db` and `@/db/runBatch` to *this* test's client.
  //
  // Without it the very first import is cached and every later test writes
  // through the **first** test's database handle while reading through its own.
  // The symptom is baffling and was the reason this suite first looked like a
  // product bug: `recordRun` succeeded, returned a snapshot id, and the row was
  // simply not in the table being read. `rows present: []` on a call that had
  // just written one is the fingerprint.
  vi.resetModules();

  const service = await import("./GeoService");
  GeoService = service.GeoService;
});

const recordRun = (input: Parameters<typeof GeoService.recordRun>[0]) =>
  GeoService.recordRun(input);

/**
 * Read the column back, distinguishing a stored `0` from a stored null.
 *
 * The `?? null` version of this helper is **a bug this test suite exists to
 * catch, written into the test itself**: `rows[0]?.prompts_asked ?? null` turns a
 * stored zero into null, so the "keeps zero and null apart" case compared null
 * with null and failed for a reason that had nothing to do with the product.
 *
 * `?? default` swallows an explicit null *and* an explicit zero, which is the
 * whole point of a column whose two interesting values are `0` and `null`.
 */
const promptsAskedOf = async (snapshotId: string) => {
  const result = await client.execute({
    sql: "SELECT id, prompts_asked, typeof(prompts_asked) AS kind FROM geo_snapshots WHERE id = ?",
    args: [snapshotId],
  });
  const row = result.rows[0];
  // No row is a different failure from a null column, and the first version of
  // this helper conflated the two: it returned `undefined`, and an assertion of
  // `toBeNull()` then reported a **missing snapshot** as a **wrong denominator**,
  // which is a diagnostic that points at the wrong code entirely.
  if (row === undefined) {
    const present = await client.execute("SELECT id FROM geo_snapshots");
    throw new Error(
      `no snapshot row with id ${snapshotId}; rows present: ` +
        JSON.stringify(present.rows.map((r) => r.id)),
    );
  }
  return row.kind === "null" ? null : Number(row.prompts_asked);
};

describe("the prompts a run asked", () => {
  it("stores the denominator when the caller knows it", async () => {
    const snapshot = await recordRun({
      projectId: "p1",
      createdBy: "schedule",
      answers: [answer()],
      promptsAsked: 12,
    });
    expect(await promptsAskedOf(snapshot!.id)).toBe(12);
  });

  it("stores null rather than zero when the caller does not know it", async () => {
    // The Live path. A run that holds a numerator and an undisclosed total
    // records null, and a null here is the honest state — **not** a failure to
    // write, which is why this is asserted by reading the column back rather
    // than by checking the value is truthy.
    const snapshot = await recordRun({
      projectId: "p1",
      createdBy: "schedule",
      answers: [answer()],
      promptsAsked: null,
    });
    expect(await promptsAskedOf(snapshot!.id)).toBeNull();
  });

  it("defaults an omitted denominator to null, never to zero", async () => {
    // The default is the whole question. A caller that forgets to pass the
    // denominator has told us nothing about the sample, and `?? 0` would state
    // that no prompts were asked — turning an absence of measurement into a
    // measurement, which is the exact inversion the column exists to prevent.
    const snapshot = await recordRun({
      projectId: "p1",
      createdBy: "schedule",
      answers: [answer()],
    });
    expect(await promptsAskedOf(snapshot!.id)).toBeNull();
  });

  it("keeps zero and null apart", async () => {
    // "Asked and got nothing" and "cannot say what was asked" are different
    // facts. A chart that renders both as 0 says a run found nothing when it
    // actually has no sample size, which is a statement about the world rather
    // than about what we know.
    //
    // Two runs in one test, so the two ids coexist in the table and the
    // comparison is between real rows rather than between two return values
    // that each happened to be null.
    const measured = await recordRun({
      projectId: "p1",
      createdBy: "schedule",
      answers: [answer()],
      promptsAsked: 0,
    });
    const unknown = await recordRun({
      projectId: "p1",
      createdBy: "schedule",
      answers: [answer()],
      promptsAsked: null,
    });
    expect(await promptsAskedOf(measured!.id)).toBe(0);
    expect(await promptsAskedOf(unknown!.id)).toBeNull();
  });
});
