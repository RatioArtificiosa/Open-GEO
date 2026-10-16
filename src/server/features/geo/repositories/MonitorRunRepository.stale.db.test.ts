import { readFileSync } from "node:fs";
import { type Client, createClient, type InArgs } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { tryBeginRun as tryBeginRunType } from "./MonitorRunRepository";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/**
 * Stale-claim theft, tested against the real partial unique index.
 *
 * Isolate death (deploy, OOM, timeout) skips the `finally` that releases the
 * monitor slot. Without a steal, one dead run stops its monitor forever — no
 * error, no retry, just silence. Same harness discipline as
 * `scheduledGeoPatrol.test.ts`: real migrations, real SQLite, mocked `db`.
 * The monitor_runs table comes from its own migration (0052) so the partial
 * index under test is production's, not a retyped copy.
 */
let client: Client;
let tryBeginRun: typeof tryBeginRunType;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runRaw: async <T>(statement: SQL): Promise<T[]> => {
      const { SQLiteAsyncDialect } = await import("drizzle-orm/sqlite-core");
      const compiled = new SQLiteAsyncDialect().sqlToQuery(statement);
      const rows = await client.execute({
        sql: compiled.sql,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dialect-produced params
        args: compiled.params as InArgs,
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows are whatever the statement returns; T is the caller's claim
      return rows.rows as T[];
    },
  }));
  await client.execute("CREATE TABLE projects (id text PRIMARY KEY)");
  await client.executeMultiple(
    readFileSync("drizzle/0052_smart_the_hood.sql", "utf8"),
  );
  // 0057 adds geo_acquisition_mode to the hand-created projects table above.
  // The harness must track migrations that alter tables it uses, or it tests
  // against a schema production no longer has — which is what the
  // migration-coverage gate exists to catch.
  await client.executeMultiple(
    readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
  );
  tryBeginRun = (await import("./MonitorRunRepository")).tryBeginRun;
});

afterAll(() => {
  client.close();
});

async function activeCount(projectId: string): Promise<number> {
  const active = await client.execute(
    "SELECT COUNT(*) AS n FROM monitor_runs WHERE project_id = ? AND status IN ('pending','running')",
    [projectId],
  );
  return Number(active.rows[0]?.n ?? 0);
}

describe("stale single-in-flight claims", () => {
  it("steals a stale claim instead of skipping forever", async () => {
    // 13 hours against a 12-hour horizon.
    await client.execute("INSERT INTO projects (id) VALUES ('p1')");
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    await client.execute({
      sql: "INSERT INTO monitor_runs (id, project_id, monitor_type, monitor_subject, platform, status, started_at) VALUES (?,?,?,?,?,?,?)",
      args: ["dead-isolate", "p1", "geo_patrol", "", "", "running", stale],
    });
    const claim = await tryBeginRun({
      id: "new-tick",
      projectId: "p1",
      monitorType: "geo_patrol",
    });
    expect(claim.ok).toBe(true);
    // The theft is recorded with its reason, not silent.
    const old = await client.execute({
      sql: "SELECT status, error_message FROM monitor_runs WHERE id = ?",
      args: ["dead-isolate"],
    });
    expect(old.rows[0]?.status).toBe("failed");
    const errorMessage = old.rows[0]?.error_message;
    expect(typeof errorMessage === "string" && errorMessage).toMatch(
      /stale claim/,
    );
    expect(await activeCount("p1")).toBe(1);
  });

  it("does not steal a fresh claim, and fails closed on unreadable timestamps", async () => {
    await client.execute("INSERT INTO projects (id) VALUES ('p2')");
    const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await client.execute({
      sql: "INSERT INTO monitor_runs (id, project_id, monitor_type, monitor_subject, platform, status, started_at) VALUES (?,?,?,?,?,?,?)",
      args: ["live-isolate", "p2", "geo_patrol", "", "", "running", fresh],
    });
    const refused = await tryBeginRun({
      id: "other-tick",
      projectId: "p2",
      monitorType: "geo_patrol",
    });
    expect(refused).toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: "live-isolate",
    });
    // SQLite's own timestamp shape parses as UTC too — the dialect the
    // production default actually writes.
    await client.execute({
      sql: "UPDATE monitor_runs SET id = ?, started_at = ? WHERE id = ?",
      args: ["old-sqlite", "2020-01-01 00:00:00", "live-isolate"],
    });
    const stolen = await tryBeginRun({
      id: "third-tick",
      projectId: "p2",
      monitorType: "geo_patrol",
    });
    expect(stolen.ok).toBe(true);
    // Unreadable timestamps never steal: failing closed over refusing open.
    await client.execute({
      sql: "UPDATE monitor_runs SET started_at = ? WHERE id = ?",
      args: ["not-a-date", "third-tick"],
    });
    const kept = await tryBeginRun({
      id: "fourth-tick",
      projectId: "p2",
      monitorType: "geo_patrol",
    });
    expect(kept).toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: "third-tick",
    });
  });
});
