/**
 * `getKeywordHistory` against a real database.
 *
 * ## Why this file exists
 *
 * The history read is what an AI-Overview-over-time view is built on, and it was
 * **silently dropping the feature column**: the query selected `device`, `checked_at`
 * and `position` only, so `serpFeatures` never reached the modal — which then passed
 * `[]` everywhere it knew nothing. A query-builder stub returns whatever it was told to
 * return, so no test with a mocked `db` could have shown it.
 *
 * **Which rows come back IS the claim**, and here the claim is two claims: the features
 * ride along per check, and a `null` record survives as `null` rather than arriving as
 * an empty list. The second one is the whole reason the read distinguishes them — a
 * legacy check with no feature record must not render as a confident "not in an AI
 * Overview".
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

// The module under test, imported as a **type** so the binding below can be typed from
// its real signature. A double that drifts from the module becomes a compile error
// rather than a runtime surprise, which is the point of not casting.
import type { getKeywordHistory as GetKeywordHistory } from "./snapshotQueries";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const PROJECT = "project_1";
const CONFIG = "config_1";
const KEYWORD = "keyword_1";

// `@/db/provider` reads `env` from the Workers runtime, which does not exist under
// vitest — the sibling DB tests mock it the same way.
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let getKeywordHistory: typeof GetKeywordHistory;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);

  await client.executeMultiple(
    [
      // The hand-rolled parent table keeps this file small, and **stays minimal on
      // purpose**: `0022`, `0024`, `0025` and `0057` below add their columns to it, so
      // pre-declaring those columns here would fail on a duplicate. `domain` and
      // `organization_id` are the exceptions, because `0016`'s partial index and
      // `0022`'s drop-and-recreate both read them.
      `CREATE TABLE projects (id text PRIMARY KEY, name text, domain text, organization_id text, created_at text);`,
      // The migration that creates the rank-tracking tables, read as a literal so a
      // rename there fails here rather than in production.
      readFileSync("drizzle/0007_sour_risque.sql", "utf8"),
      // **Every later migration that alters a table this test writes.** A test that
      // asserts against a half-migrated schema is asserting against a schema nobody
      // runs, and `scripts/migration-coverage.test.ts` exists to say so: it reported
      // six missing ones before these lines were added.
      readFileSync("drizzle/0008_luxuriant_colossus.sql", "utf8"),
      // Not required by the gate, required to *run*: `0022` drops this index, so it has
      // to exist first.
      readFileSync("drizzle/0016_magical_the_fallen.sql", "utf8"),
      readFileSync("drizzle/0022_purple_hitman.sql", "utf8"),
      readFileSync("drizzle/0024_clumsy_barracuda.sql", "utf8"),
      readFileSync("drizzle/0025_loving_mojo.sql", "utf8"),
      readFileSync("drizzle/0029_location_name.sql", "utf8"),
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
    ].join("\n"),
  );

  // `vi.doMock` inside `beforeAll` and then a **dynamic import**, because the module
  // reads `@/db` at call time: a hoisted `vi.mock` with a mutable handle evaluates to
  // `undefined` when the module first loads, which is a binding that is empty in
  // practice while looking right in principle.
  vi.doMock("@/db", () => ({ db: testDb }));
  getKeywordHistory = (await import("./snapshotQueries")).getKeywordHistory;

  await client.execute(
    "INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)",
    [PROJECT, "Acme", "2026-10-01T00:00:00.000Z"],
  );
  // The config the runs hang off: `rank_check_runs.config_id` is a real FK, so a run
  // without one fails the constraint rather than the assertion. `serp_depth` has no
  // default (it arrives NOT NULL from `0008`), so it is named here; `location_code` and
  // `language_code` do have defaults, from `0024`.
  await client.execute(
    "INSERT INTO rank_tracking_configs (id, project_id, domain, serp_depth) VALUES (?, ?, ?, ?)",
    [CONFIG, PROJECT, "example.com", 20],
  );
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM rank_snapshots");
  await client.execute("DELETE FROM rank_check_runs");
});

async function seedRun(
  id: string,
  status: string,
  startedAt: string,
): Promise<void> {
  await client.execute(
    "INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at) VALUES (?, ?, ?, ?, ?)",
    [id, CONFIG, PROJECT, status, startedAt],
  );
}

async function seedSnapshot(input: {
  runId: string;
  checkedAt: string;
  position: number | null;
  serpFeatures: string | null;
}): Promise<void> {
  await client.execute(
    `INSERT INTO rank_snapshots
       (run_id, tracking_keyword_id, keyword, device, position, url, serp_features, checked_at)
     VALUES (?, ?, ?, 'desktop', ?, NULL, ?, ?)`,
    [
      input.runId,
      KEYWORD,
      "example keyword",
      input.position,
      input.serpFeatures,
      input.checkedAt,
    ],
  );
}

describe("getKeywordHistory against real SQL", () => {
  it("carries each check's SERP features, oldest first", async () => {
    await seedRun("run_1", "completed", "2026-10-01 10:00:00");
    await seedRun("run_2", "completed", "2026-10-08 10:00:00");
    await seedSnapshot({
      runId: "run_1",
      checkedAt: "2026-10-01 10:00:00",
      position: 4,
      serpFeatures: '["organic"]',
    });
    await seedSnapshot({
      runId: "run_2",
      checkedAt: "2026-10-08 10:00:00",
      position: 3,
      serpFeatures: '["organic","ai_overview"]',
    });

    const rows = await getKeywordHistory(CONFIG, KEYWORD, 730);

    expect(rows.map((row) => row.checkedAt)).toEqual([
      "2026-10-01 10:00:00",
      "2026-10-08 10:00:00",
    ]);
    // The column the read used to drop, asserted where it lands.
    expect(rows.map((row) => row.serpFeatures)).toEqual([
      '["organic"]',
      '["organic","ai_overview"]',
    ]);
  });

  it("keeps a null feature record as null, distinct from an empty list", async () => {
    // A legacy check and a checked-empty check are different claims. If both arrived as
    // `[]` the view would report the legacy one as "not in an AI Overview", inventing a
    // citation loss rather than showing a gap.
    await seedRun("run_1", "completed", "2026-10-01 10:00:00");
    await seedRun("run_2", "completed", "2026-10-08 10:00:00");
    await seedSnapshot({
      runId: "run_1",
      checkedAt: "2026-10-01 10:00:00",
      position: 9,
      serpFeatures: null,
    });
    await seedSnapshot({
      runId: "run_2",
      checkedAt: "2026-10-08 10:00:00",
      position: 8,
      serpFeatures: "[]",
    });

    const rows = await getKeywordHistory(CONFIG, KEYWORD, 730);

    expect(rows[0]?.serpFeatures).toBeNull();
    expect(rows[1]?.serpFeatures).toBe("[]");
  });

  it("counts only completed runs, so an in-flight check is not a history point", async () => {
    await seedRun("run_1", "completed", "2026-10-01 10:00:00");
    await seedRun("run_2", "running", "2026-10-08 10:00:00");
    await seedSnapshot({
      runId: "run_1",
      checkedAt: "2026-10-01 10:00:00",
      position: 4,
      serpFeatures: '["organic"]',
    });
    await seedSnapshot({
      runId: "run_2",
      checkedAt: "2026-10-08 10:00:00",
      position: null,
      serpFeatures: '["organic","ai_overview"]',
    });

    const rows = await getKeywordHistory(CONFIG, KEYWORD, 730);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.checkedAt).toBe("2026-10-01 10:00:00");
  });
});
