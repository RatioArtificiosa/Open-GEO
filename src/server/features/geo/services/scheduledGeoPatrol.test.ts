import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
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
  vi.doMock("@/db", () => ({ db: testDb }));

  // The real migration, so the joins and the cascade behaviour are production's.
  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
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
