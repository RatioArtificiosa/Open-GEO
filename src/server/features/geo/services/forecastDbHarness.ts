/**
 * The real-SQLite harness the forecast tests share.
 *
 * ## Why this is a module and not a block at the top of each test file
 *
 * Two suites need the same database — one for the reader, one for the table's own
 * guarantees — and the setup is the interesting part: **which migrations are loaded,
 * in what order, and why each one is not optional.** Duplicating it means the second
 * copy drifts, and a drifted copy loads `0048` alone and fails on columns the schema
 * declares. It was extracted for the ordinary reason (B7's 400-line partition rule),
 * and it earns its keep for a better one.
 *
 * ## The two load-bearing rules, in one place
 *
 * 1. **`vi.doMock` runs before any value import of the mocked module.** `@/db` binds
 *    to the D1 session at *import* time, so a repository imported at the top of a file
 *    captures the real (absent) worker binding and every write then fails with a
 *    `prepare` of undefined — which reads as a broken test rather than as an
 *    import-order bug. So `start()` is a function each `beforeAll` awaits, and the
 *    values it returns were imported *inside* it.
 * 2. **The migrations are the schema, not a fixture.** `0055` and `0056` add columns
 *    several migrations after the tables that hold them, and `0065` corrects the
 *    unique key `0064` shipped. Loading only `0048` runs the assertions against a
 *    shape the schema does not have.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

/** The day the scoreboard reads on, and the days its tests score against. */
export const FORECAST_TEST_TODAY = "2026-10-14";

/** The brand the shared fixtures measure. */
export const FORECAST_TEST_DOMAIN = "acme.com";

/**
 * Build the harness: a real in-memory SQLite database and the modules that read it.
 *
 * The mock must be installed **inside** `mockDb`, because `@/db` binds to the D1
 * session at import time — installing it after the imports below have resolved is too
 * late, and every write then fails with a `prepare` of undefined, which reads as a
 * broken test rather than as an import-order bug.
 */
export async function startForecastTestDb(mockDb: (db: unknown) => void) {
  const client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // **`0055` and `0056`, and neither is optional.** `geo_answers.prompts_asked`
      // (the forecast's denominator) and `geo_snapshots.target_id` both arrived
      // several migrations after the tables that hold them, so a fixture that loads
      // only `0048` fails on columns the schema declares — the same
      // migrations-late history `0062` documents for `audit.fixes_json`.
      readFileSync("drizzle/0055_nosy_galactus.sql", "utf8"),
      readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8"),
      // The table, then the column that fixes its key. Both are loaded because
      // `0065` deletes the rows and adds `domain` — a test that loaded only `0064`
      // would be running against the key the migration was written to correct, and
      // every multi-brand assertion would pass against the broken shape.
      readFileSync("drizzle/0064_steady_fenris.sql", "utf8"),
      readFileSync("drizzle/0065_swift_mercury.sql", "utf8"),
    ].join(""),
  );

  // **The mock is installed before any value import below.** `@/db` binds at import
  // time, so the order is the whole mechanism — see the module header.
  mockDb(testDb);

  // Seeded here so a caller's first test never has to remember the parent exists:
  // the snapshot table's foreign key is real, and a write that precedes its parent
  // fails with `SQLITE_CONSTRAINT_FOREIGNKEY`, which reads as a broken repository
  // rather than as a missing fixture.
  await seedProject(client);

  return loadForecastTestModules(client);
}

/**
 * The modules, imported **after** the mock is installed.
 */
async function loadForecastTestModules(
  client: ReturnType<typeof createClient>,
) {
  const repository =
    await import("@/server/features/geo/repositories/ForecastSnapshotsRepository");
  const reads = await import("./forecastAccuracyReads");
  const schema = await import("@/db/schema");
  const database = await import("@/db");

  return {
    client,
    db: database.db,
    geoForecastSnapshots: schema.geoForecastSnapshots,
    ForecastSnapshotsRepository: repository.ForecastSnapshotsRepository,
    readForecastAccuracy: reads.readForecastAccuracy,
  };
}

/**
 * The project the shared fixtures belong to.
 *
 * Called once, from `startForecastTestDb`, and its foreign key is real: a snapshot
 * write that precedes its parent fails with `SQLITE_CONSTRAINT_FOREIGNKEY`, which
 * reads as a broken repository rather than as a missing fixture.
 */
async function seedProject(
  client: ReturnType<typeof createClient>,
): Promise<void> {
  await client.execute({
    sql: "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    args: ["proj-1", "Proj", 2840, "en", "2026-01-01T00:00:00.000Z"],
  });
}

/** Clear what each test writes, leaving the seeded parents in place. */
export async function clearForecastRows(
  client: ReturnType<typeof createClient>,
): Promise<void> {
  await client.execute("DELETE FROM geo_forecast_snapshots");
  await client.execute("DELETE FROM geo_answers");
  await client.execute("DELETE FROM geo_snapshots");
}

/**
 * Seed the answers the accuracy read measures from.
 *
 * ## The three parts that are not optional, and what each one costs
 *
 * 1. **The denominator lives on `geo_snapshots.prompts_asked`**, not on the answer.
 *    `readForecastInput` reads it there to build the rate, and a live run leaves it
 *    null because the vendor does not disclose its prompt count. A seed without it
 *    produces a null actual — indistinguishable from "nothing was measured", which is
 *    the branch a *scored* test is trying to avoid.
 * 2. **The brand is named in the answer body.** The reader decides a mention by
 *    finding the domain or the target's name in the text, so an answer without it
 *    counts as an absence: a 0% share, not a missing one, and the wrong branch.
 * 3. **`geo_snapshot_answers` joins the two.** Without the join row the answer is
 *    invisible to the reader and every run counts as `noAnswers`.
 */
export async function seedAnswers(
  client: ReturnType<typeof createClient>,
  input: { weeks?: number; startIso?: string } = {},
): Promise<void> {
  const weeks = input.weeks ?? 12;
  const start = Date.parse(input.startIso ?? "2026-07-20T00:00:00Z");

  // **`OR IGNORE`, and the ids are fixed.** Callers may seed more than once, and the
  // second call would collide on the unique key — a collision that reads as a broken
  // fixture rather than as an idempotent seed.
  await client.execute({
    sql: "INSERT OR IGNORE INTO geo_targets (id, project_id, domain, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [
      "target-1",
      "proj-1",
      FORECAST_TEST_DOMAIN,
      "Acme",
      2840,
      "en",
      "2026-01-01T00:00:00.000Z",
    ],
  });
  await client.execute({
    sql: "INSERT OR IGNORE INTO geo_prompt_sets (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
    args: ["set-1", "proj-1", "Set", "2026-01-01T00:00:00.000Z"],
  });

  for (let index = 0; index < weeks; index += 1) {
    const startedAt = new Date(start + index * 7 * 86_400_000).toISOString();
    const snapshotId = `snap-${index}`;
    await client.execute({
      sql: "INSERT INTO geo_snapshots (id, project_id, prompt_set_id, target_id, started_at, prompts_asked, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        snapshotId,
        "proj-1",
        "set-1",
        "target-1",
        startedAt,
        40,
        "system",
      ],
    });
    for (const platform of ["chat_gpt", "perplexity"]) {
      const answerId = `ans-${platform}-${index}`;
      await client.execute({
        sql: `INSERT INTO geo_answers
              (id, project_id, target_id, prompt_set_id, prompt, answer_text, platform, source, location_code, language_code, answered_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          answerId,
          "proj-1",
          "target-1",
          "set-1",
          "who is the best crm",
          "Acme is a strong choice for most teams.",
          platform,
          "live",
          2840,
          "en",
          startedAt,
          startedAt,
        ],
      });
      await client.execute({
        sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?, ?)",
        args: [snapshotId, answerId],
      });
    }
  }
}
