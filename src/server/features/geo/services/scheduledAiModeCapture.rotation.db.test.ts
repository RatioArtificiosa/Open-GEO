/**
 * Which projects get an AI Mode capture, and why that needs saying.
 *
 * ## This capture had no rotation at all
 *
 * The other four captures this session all rotated *something* — the defect was that it
 * sat one level below the cap. **This one had no `orderBy` at all**, so
 * `watchers.slice(0, limitProjects)` took whatever order the database returned.
 *
 * A stable order is the worst kind here: it looks deliberate, the report is internally
 * consistent, and every project past the 25th is never asked again. `runMonitor` bills
 * real money per call, so those projects **pay for a capture they never receive** — and
 * the first 25 pay every night for one that measures nothing new.
 *
 * ## Real SQLite, because the bug was in a query
 *
 * The fix is an `ORDER BY` over `ai_mode_snapshots`, and an `ORDER BY` is exactly the
 * thing a mocked query builder will happily let you get wrong — it returns rows in the
 * order it was told to. `visibilityForecastReads.db.test.ts` states the rule: **which
 * rows come back IS the claim.**
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
import type { runDueAiModeCaptures as RunDueAiModeCaptures } from "./scheduledAiModeCapture";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let runDueAiModeCaptures: typeof RunDueAiModeCaptures;

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

  runDueAiModeCaptures = (
    await import("@/server/features/geo/services/scheduledAiModeCapture")
  ).runDueAiModeCaptures;
});

afterAll(() => client.close());

/** One project with one prompt, and optionally a snapshot proving when it was asked. */
async function seedProject(
  projectId: string,
  prompt: string,
  snapshotAt: string | null,
): Promise<void> {
  await client.execute(
    "INSERT OR IGNORE INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    [projectId, projectId, 2840, "en", "2026-10-01T00:00:00.000Z"],
  );
  // **`geo_prompt_sets` is unique on (project, name)** — one set per project, which is
  // the product's shape rather than a fixture convenience.
  await client.execute(
    "INSERT OR IGNORE INTO geo_prompt_sets (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
    [`set-${projectId}`, projectId, "default", "2026-10-01T00:00:00.000Z"],
  );
  await client.execute(
    "INSERT OR IGNORE INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      `t-${projectId}`,
      projectId,
      projectId,
      `${projectId}.com`,
      2840,
      "en",
      "2026-10-01T00:00:00.000Z",
    ],
  );
  await client.execute(
    "INSERT INTO geo_prompts (id, prompt_set_id, prompt, position, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      `q-${projectId}`,
      `set-${projectId}`,
      prompt,
      0,
      "2026-10-01T00:00:00.000Z",
    ],
  );
  if (snapshotAt === null) return;
  await client.execute(
    "INSERT INTO ai_mode_snapshots (id, project_id, keyword, location_code, language_code, answer_markdown, check_url, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      `s-${projectId}-${snapshotAt}`,
      projectId,
      prompt,
      2840,
      "en",
      "answer",
      "https://x",
      snapshotAt,
    ],
  );
}

beforeEach(async () => {
  // **Children before parents** — the foreign keys are real, and deleting `projects`
  // while `geo_targets` references it raises a constraint error.
  await client.execute("DELETE FROM ai_mode_snapshots");
  await client.execute("DELETE FROM ai_mode_snapshot_citations");
  await client.execute("DELETE FROM geo_prompts");
  await client.execute("DELETE FROM geo_targets");
  await client.execute("DELETE FROM geo_prompt_sets");
  await client.execute("DELETE FROM projects");
});

describe("which projects get an AI Mode capture", () => {
  it("asks the project whose last snapshot is stalest, not the first row back", async () => {
    await seedProject("project_a", "alpha prompt", "2026-09-05T00:00:00.000Z");
    await seedProject("project_b", "beta prompt", "2026-09-01T00:00:00.000Z");

    const asked: string[] = [];
    await runDueAiModeCaptures({
      limitProjects: 1,
      now: new Date("2026-10-01T00:00:00.000Z"),
      // **`fetchWatchers` is deliberately NOT injected.** The ordering this test
      // checks lives in the SQL, so stubbing the watcher query would stub the answer and
      // assert nothing — which is exactly what the first version of this test did.
      // Only `runMonitor` is stubbed, because the vendor call is not what is under test.
      runMonitor: async (input) => {
        asked.push(input.projectId);
        // **Every field the type names**, because the omitted ones are not decoration:
        // `ran`, `skippedReason` and `summary` are how the runner reports a project it
        // did *not* capture — which is precisely what this bug produces for every project
        // past the cap.
        return {
          projectId: input.projectId,
          ran: true,
          skippedReason: null,
          captured: 0,
          failed: [],
          changes: [],
          estimatedCostUsd: 0,
          actualCostUsd: 0,
          summary: "stub",
        };
      },
    });

    // **project_b** — its last snapshot (09-01) is older than project_a's (09-05).
    expect(asked).toEqual(["project_b"]);
  });
});
