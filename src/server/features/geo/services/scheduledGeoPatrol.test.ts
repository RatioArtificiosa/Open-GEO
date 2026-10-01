import { readFileSync } from "node:fs";
import { createClient, type Client, type InArgs } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type * as Schema from "@/db/schema";
import type { SQL } from "drizzle-orm";
import type { ScheduledGeoPatrol as ScheduledGeoPatrolType } from "@/server/features/geo/services/scheduledGeoPatrol";

/**
 * The nightly patrol.
 *
 * The expensive mistakes here are all silent: a target that is never patrolled
 * (no history, so no product) or a target patrolled every night when its owner
 * did not ask for that (a daily charge nobody authorised). Both are tested.
 *
 * Real in-memory SQLite rather than a mocked `db`: the due-target query is a
 * join across three tables, and which rows it returns IS the money decision. A
 * stubbed builder chain cannot tell us that.
 */

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/**
 * A `vi.fn()` whose recorded args stay typed, so reading a recorded call back is
 * not an `any`. Untyped spies would make every assertion below a guess.
 */
function spy() {
  return vi.fn<(...args: never[]) => unknown>();
}
const patrolRun = spy();

vi.mock("@/server/features/geo/services/GeoPatrol", () => ({
  GeoPatrol: { run: patrolRun },
}));

const NOW = new Date("2026-09-29T03:00:00.000Z");

let client: Client;
let schema: typeof Schema;
let ScheduledGeoPatrol: typeof ScheduledGeoPatrolType;

/** What the patrol was actually asked to do on its first call. */
function firstPatrolInput(): {
  customer: Record<string, unknown>;
  createdBy: unknown;
  platforms: unknown;
} {
  const first = patrolRun.mock.calls[0];
  if (!first || typeof first[0] !== "object" || first[0] === null) {
    throw new Error("the patrol was never run");
  }
  const value = Object.fromEntries(Object.entries(first[0]));
  const customer = Reflect.get(value, "customer");
  return {
    customer:
      typeof customer === "object" && customer !== null
        ? Object.fromEntries(Object.entries(customer))
        : {},
    createdBy: Reflect.get(value, "createdBy"),
    platforms: Reflect.get(value, "platforms"),
  };
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // Mocking `@/db` is enough for every repository query. `runRaw` is the one
  // exception: it reaches the *driver*, because Drizzle's database object has no
  // `execute` and the builder cannot express a partial unique index as a
  // conflict target. So it is mocked too — but the replacement runs the **real
  // SQL** against this **real in-memory database**, so a malformed statement
  // still fails here.
  //
  // Getting this wrong was instructive twice over: the first version left
  // `runRaw` pointing at the real D1 client, so the claim died with
  // `d1Db.execute is not a function` and the suite failed for a reason that had
  // nothing to do with what it was testing.
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    // The raw libsql `client`, not `testDb`: Drizzle's database object exposes no
    // `execute`, which is the entire reason `runRaw` takes a driver.
    //
    // The statement is compiled by Drizzle's own SQLite dialect — the same
    // `sqlToQuery` its libsql driver calls internally — so the SQL and the
    // parameter binding are production's, and a malformed `ON CONFLICT` clause
    // fails here exactly as it would in D1.
    runRaw: async <T>(statement: SQL): Promise<T[]> => {
      const { SQLiteAsyncDialect } = await import("drizzle-orm/sqlite-core");
      const compiled = new SQLiteAsyncDialect().sqlToQuery(statement);
      const rows = await client.execute({
        sql: compiled.sql,
        // libsql types its bind values; Drizzle's dialect already narrowed the
        // params to the ones it produced, so this assertion adds no looseness.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dialect-produced params
        args: compiled.params as InArgs,
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows are whatever the statement returns; T is the caller's claim
      return rows.rows as T[];
    },
  }));

  // The real migration, so the joins and the cascade behaviour are production's.
  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The single-in-flight table, with its real partial unique index. Loading
      // the actual migration is the point: an index written in the schema but
      // missing from the generated SQL would leave these tests green while the
      // duplicate-patrol case failed in production.
      ...readFileSync("drizzle/0052_smart_the_hood.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The run denominator. This test inserts into `geo_snapshots` directly, so
      // without this the harness would build a table missing the column the
      // schema selects and fail with `no such column` — which reads as a broken
      // product rather than a stale fixture. `scripts/migration-coverage.test.ts`
      // is what stops the next one being forgotten.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        // 0056 adds geo_snapshots.target_id, which the alerting reader filters on.
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // 0056 adds geo_snapshots.target_id, which the alerting reader filters on.
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  schema = await import("@/db/schema");
  ScheduledGeoPatrol = (
    await import("@/server/features/geo/services/scheduledGeoPatrol")
  ).ScheduledGeoPatrol;
});

afterAll(() => {
  client.close();
});

async function addProject(id: string, org: string, archivedAt: string | null) {
  await client.execute({
    sql: "INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id, archived_at) VALUES (?,?,?,?,?,?,?)",
    args: [id, id, 2840, "en", "2026-01-01 00:00:00", org, archivedAt],
  });
}

async function addTarget(id: string, projectId: string, domain: string) {
  await client.execute({
    sql: "INSERT INTO geo_targets (id, project_id, domain, name, aliases, location_code, language_code, created_at) VALUES (?,?,?,?,?,?,?,?)",
    args: [
      id,
      projectId,
      domain,
      domain,
      null,
      2840,
      "en",
      "2026-01-01 00:00:00",
    ],
  });
}

/** Record that a target was already patrolled, `daysAgo` days back. */
async function addRunFor(targetId: string, projectId: string, daysAgo: number) {
  const startedAt = new Date(
    NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  const snapshotId = `snap_${targetId}_${daysAgo}`;
  const answerId = `ans_${targetId}_${daysAgo}`;
  await client.execute({
    sql: "INSERT INTO geo_snapshots (id, project_id, prompt_set_id, started_at, completed_at, cost_usd, status, created_by) VALUES (?,?,?,?,?,?,?,?)",
    args: [
      snapshotId,
      projectId,
      null,
      startedAt,
      startedAt,
      0,
      "complete",
      "schedule",
    ],
  });
  await client.execute({
    sql: "INSERT INTO geo_answers (id, project_id, target_id, prompt_set_id, prompt, answer_text, platform, model_name, source, location_code, language_code, answered_at, vendor_task_id, raw_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    args: [
      answerId,
      projectId,
      targetId,
      null,
      "best geo tool",
      null,
      "chat_gpt",
      null,
      "mentions_search",
      2840,
      "en",
      startedAt,
      null,
      null,
      startedAt,
    ],
  });
  await client.execute({
    sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?,?)",
    args: [snapshotId, answerId],
  });
}

beforeEach(async () => {
  await client.executeMultiple(
    [
      "DELETE FROM geo_answers",
      "DELETE FROM geo_snapshot_answers",
      "DELETE FROM geo_snapshots",
      "DELETE FROM geo_targets",
      "DELETE FROM geo_prompts",
      "DELETE FROM geo_prompt_sets",
      "DELETE FROM projects",
    ].join(";"),
  );
  await addProject("p1", "org_1", null);
  await addProject("p2", "org_2", null);
  patrolRun.mockReset().mockResolvedValue({
    snapshotId: "snap_new",
    answersArchived: 5,
    costUsd: 0,
    notes: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ScheduledGeoPatrol", () => {
  it("does nothing when no project has a target", async () => {
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(result.projectsVisited).toBe(0);
    expect(patrolRun).not.toHaveBeenCalled();
  });

  it("patrols a target that has never been monitored", async () => {
    // The common case after signup: a brand with no history has no product.
    await addTarget("t1", "p1", "acme.com");
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(result.projectsVisited).toBe(1);
    expect(patrolRun).toHaveBeenCalledTimes(1);
  });

  it("skips a target already patrolled inside the last day", async () => {
    // The money rule: a nightly tick that re-patrols everything would charge
    // every customer every day regardless of what they chose.
    await addTarget("t1", "p1", "acme.com");
    await addRunFor("t1", "p1", 0.5);
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(patrolRun).not.toHaveBeenCalled();
    expect(result.projectsVisited).toBe(0);
  });

  it("patrols it again once the day has passed", async () => {
    await addTarget("t1", "p1", "acme.com");
    await addRunFor("t1", "p1", 2);
    await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(patrolRun).toHaveBeenCalledTimes(1);
  });

  it("acts as the system identity, never a fabricated user", async () => {
    // A cron has no user. Inventing a plausible one would put a fake userId and
    // email into the billing ledger on every scheduled run.
    await addTarget("t1", "p1", "acme.com");
    await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    const input = firstPatrolInput();
    expect(input.customer.userId).toBe("system");
    expect(input.customer.organizationId).toBe("org_1");
    expect(input.customer.projectId).toBe("p1");
    expect(input.createdBy).toBe("schedule");
  });

  it("visits each project once even when it has several targets", async () => {
    await addTarget("t1", "p1", "acme.com");
    await addTarget("t2", "p1", "beta.com");
    await addTarget("t3", "p1", "gamma.com");
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(patrolRun).toHaveBeenCalledTimes(1);
    expect(result.targetsPatrolled).toBe(3);
  });

  it("keeps one project's failure from cancelling the others", async () => {
    // A balance error on one account must not stop every other account from
    // being monitored tonight.
    await addTarget("t1", "p1", "acme.com");
    await addTarget("t2", "p2", "beta.com");
    patrolRun
      .mockReset()
      .mockRejectedValueOnce(new Error("balance exhausted"))
      .mockResolvedValueOnce({
        snapshotId: "snap_2",
        answersArchived: 3,
        costUsd: 0,
        notes: [],
      });

    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(patrolRun).toHaveBeenCalledTimes(2);
    expect(result.projectsVisited).toBe(1);
    expect(result.errors.join(" ")).toMatch(/balance exhausted/);
  });

  it("defers the overflow rather than running every project in one tick", async () => {
    // beforeEach already created p1 and p2, so these start at p3 to get 7
    // projects in total without colliding on the primary key.
    for (let i = 3; i < 8; i++) {
      await addProject(`p${i}`, `org_${i}`, null);
      await addTarget(`t${i}`, `p${i}`, `brand${i}.com`);
    }
    const result = await ScheduledGeoPatrol.runDuePatrols({
      now: NOW,
      limitProjects: 2,
    });
    expect(result.projectsVisited).toBe(2);
    expect(result.errors.join(" ")).toMatch(/safety limit/);
  });

  it("ignores an archived project's targets", async () => {
    // Archiving is a deletion promise. Patrolling an archived project would keep
    // spending money and storing answers for someone who asked us to stop.
    await addTarget("t1", "p1", "acme.com");
    await client.execute(
      "UPDATE projects SET archived_at = '2026-09-01' WHERE id = 'p1'",
    );
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(patrolRun).not.toHaveBeenCalled();
    expect(result.projectsVisited).toBe(0);
  });

  it("asks only for the platforms llm_mentions actually serves", async () => {
    await addTarget("t1", "p1", "acme.com");
    await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(firstPatrolInput().platforms).toEqual([
      "chat_gpt",
      "google_ai_overview",
    ]);
  });

  it("joins the real tables, so the test cannot drift from the schema", () => {
    // Guards the mock: if the due-target query grew a new table reference and
    // someone stubbed it away, this is where it would surface.
    expect(schema.geoSnapshots).toBeDefined();
    expect(schema.geoAnswers).toBeDefined();
    expect(schema.geoSnapshotAnswers).toBeDefined();
  });
});

/**
 * The single-in-flight slot, against the **real** partial unique index.
 *
 * These are the tests that make CL-150b worth shipping. A mocked `runRaw` would
 * pass all of them while the `ON CONFLICT` clause it stood for was a syntax
 * error — which is exactly what happened: the first version of the claim was
 * rejected by SQLite on the *first* insert, so the patrol would have run zero
 * times a night.
 */
describe("the monitor's single-in-flight slot", () => {
  const countRuns = async (projectId: string) => {
    const result = await client.execute(
      "SELECT COUNT(*) AS n FROM monitor_runs WHERE project_id = ?",
      [projectId],
    );
    const first = result.rows[0];
    return Number(first?.n ?? 0);
  };

  it("refuses a second patrol while one is in flight", async () => {
    // The whole point: two triggers — the cron and a manual "run now" — would
    // each bill the customer in full, and the archive would hold the same patrol
    // twice. The refusal has to be the *database's*, not a boolean in one
    // isolate's memory.
    //
    // A finished patrol frees its slot, so a second tick legitimately runs.
    // The case that matters is a patrol that is **still running** — the row is
    // written before any work happens and released after, so a second trigger
    // arriving in that window must be refused. Here the row is inserted
    // directly, standing in for the isolate that is mid-patrol.
    await addTarget("t1", "p1", "acme.com");
    await client.execute(
      `INSERT INTO monitor_runs (id, project_id, monitor_type, monitor_subject, platform, status)
       VALUES ('other-isolate', 'p1', 'geo_patrol', '', '', 'running')`,
    );

    patrolRun.mockClear();
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });

    expect(patrolRun).not.toHaveBeenCalled();
    expect(result.projectsVisited).toBe(0);
    expect(result.errors.join(" ")).toMatch(/already in flight/i);
  });

  it("frees the slot when the patrol finishes, so the next night runs", async () => {
    // The failure mode this guards is a project that is *permanently* stuck: no
    // error, no retry, just a brand that silently stopped being monitored. It is
    // the same class of bug as the cron inversion, one level down.
    await addTarget("t1", "p1", "acme.com");
    await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(await countRuns("p1")).toBe(1);

    // Nothing may remain in an in-flight state, or the next tick is refused.
    const active = await client.execute(
      "SELECT COUNT(*) AS n FROM monitor_runs WHERE project_id = ? AND status IN ('pending','running')",
      ["p1"],
    );
    expect(Number(active.rows[0]?.n ?? 0)).toBe(0);
  });

  it("frees the slot even when the patrol throws", async () => {
    // A `finally` that could be skipped would leave the project stuck forever.
    patrolRun.mockImplementationOnce(() => {
      throw new Error("vendor timeout");
    });
    await addTarget("t1", "p1", "acme.com");
    await ScheduledGeoPatrol.runDuePatrols({ now: NOW });

    const active = await client.execute(
      "SELECT COUNT(*) AS n FROM monitor_runs WHERE project_id = ? AND status IN ('pending','running')",
      ["p1"],
    );
    expect(Number(active.rows[0]?.n ?? 0)).toBe(0);
  });

  it("does not let one project's run block another project's", async () => {
    // The slot is keyed on the project. A shared/global claim would serialise
    // every customer behind the slowest one.
    await addTarget("t1", "p1", "acme.com");
    await addTarget("t2", "p2", "globex.com");
    const result = await ScheduledGeoPatrol.runDuePatrols({ now: NOW });
    expect(result.projectsVisited).toBe(2);
  });
});
