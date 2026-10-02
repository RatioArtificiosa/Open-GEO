/**
 * The retention sweep, against a real database.
 *
 * ## Two findings, and the second is the larger one
 *
 * **1. The project list had no `ORDER BY`.** `.slice(0, limit)` took whatever order the
 * database returned — the sixth instance of a shape the four captures share. Here
 * skipping is worse than in a capture: there it costs freshness and tomorrow fixes it,
 * and here it means **an archive that never ages out, permanently**.
 *
 * **2. `purgeAiModeBefore` had no caller anywhere in the repo.** The function existed,
 * was tested, and was never invoked — so `ai_mode_snapshots`, which stores the **verbatim
 * answer markdown** and is the largest table in the schema, grew without bound while the
 * sweep reported success every night. A silent sum is what hid it: the log line was
 * non-zero and said nothing about the table it had missed.
 *
 * ## Real SQLite
 *
 * Both findings are in SQL. A mocked query builder returns whatever it was told to, which
 * is precisely the shape of the bug.
 */
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
import type { runScheduledGeoRetention as RunScheduledGeoRetention } from "./scheduledGeoRetention";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/** A moment comfortably older than the default 180-day window. */
const OLD = "2020-01-01T00:00:00.000Z";
const NOW = "2026-10-01T00:00:00.000Z";

let client: Client;
let runScheduledGeoRetention: typeof RunScheduledGeoRetention;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
    ].join("\n"),
  );

  vi.doMock("@/db", () => ({ db: testDb }));

  runScheduledGeoRetention = (
    await import("@/server/features/geo/services/scheduledGeoRetention")
  ).runScheduledGeoRetention;

  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    ["project_expired", "Expired", 2840, "en", NOW],
  );
  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    ["project_clean", "Clean", 2840, "en", NOW],
  );
});

afterAll(() => client.close());

beforeEach(async () => {
  // **Children before parents** — the foreign keys are real.
  await client.execute("DELETE FROM ai_mode_snapshot_citations");
  await client.execute("DELETE FROM ai_mode_snapshots");
  await client.execute("DELETE FROM geo_answers");
  await client.execute("DELETE FROM geo_targets");

  // **Seeded here, not in `beforeAll`.** The first version put it there and the
  // `beforeEach` above wiped it, so every test ran against zero targets — and the
  // symptom was "the sweep did nothing", which points at the sweep rather than the
  // fixture. **Four runs of reasoning from the failure; one printed row count solved it.**
  for (const projectId of ["project_expired", "project_clean"]) {
    await client.execute(
      "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `t-${projectId}`,
        projectId,
        projectId,
        `${projectId}.com`,
        2840,
        "en",
        NOW,
      ],
    );
  }
});

/** One expired AI Mode snapshot for a project. */
async function seedExpiredSnapshot(
  projectId: string,
  id: string,
): Promise<void> {
  await client.execute(
    "INSERT INTO ai_mode_snapshots (id, project_id, keyword, location_code, language_code, answer_markdown, check_url, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      projectId,
      "best crm",
      2840,
      "en",
      "a long verbatim answer",
      "https://x",
      OLD,
    ],
  );
}

describe("the retention sweep", () => {
  it("deletes expired AI Mode snapshots, which nothing used to do", async () => {
    await seedExpiredSnapshot("project_expired", "s1");

    const before = await client.execute(
      "SELECT count(*) as n FROM ai_mode_snapshots WHERE project_id = ?",
      ["project_expired"],
    );
    expect(Number(before.rows[0].n)).toBe(1);

    const result = await runScheduledGeoRetention({});

    // **The errors array first**, because the sweep catches per-project failures rather
    // than throwing — a failure here is reported, not raised, so a test that only checks
    // a count sees a zero and a reason it never looked at.
    expect(result.errors).toEqual([]);
    expect(result.aiModeSnapshotsDeleted).toBe(1);

    const after = await client.execute(
      "SELECT count(*) as n FROM ai_mode_snapshots WHERE project_id = ?",
      ["project_expired"],
    );
    expect(Number(after.rows[0].n)).toBe(0);
  });

  it("leaves a project's citations behind nothing — they are purged with the snapshot", async () => {
    await seedExpiredSnapshot("project_expired", "s2");
    await client.execute(
      "INSERT INTO ai_mode_snapshot_citations (snapshot_id, url, domain, title) VALUES (?, ?, ?, ?)",
      ["s2", "https://example.com", "example.com", "Example"],
    );

    await runScheduledGeoRetention({});

    const rows = await client.execute(
      "SELECT count(*) as n FROM ai_mode_snapshot_citations WHERE snapshot_id = ?",
      ["s2"],
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it("skips a project with nothing past the cutoff", async () => {
    // **No expired rows for project_clean**, so the sweep must not visit it — before this
    // change every active project was visited and the count was bounded only by
    // `limitProjects`, which is how the tail of a large deployment went un-swept.
    await seedExpiredSnapshot("project_expired", "s3");

    const result = await runScheduledGeoRetention({});

    expect(result.projectsVisited).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
