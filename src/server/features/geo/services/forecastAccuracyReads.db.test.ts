/**
 * The forecast scoreboard, against a real database.
 *
 * ## Why this one is a database test and the sweep's is not
 *
 * The sweep's job is arithmetic over injected inputs, so its failures are shapes of
 * input. This module's job is a **join across the table's own orderings** — the row
 * that was standing on a given day, per subject, newest-qualifying — and every one
 * of those guarantees lives in SQL. A mocked query builder returns whatever it was
 * told to, which is precisely the shape of the bug this file exists to catch: an
 * `asOfFor` that returned the newest row *after* the day being scored would score
 * today's opinion against today's fact, and it would always agree.
 *
 * ## The two rules under test
 *
 * 1. **The forecast scored is the one standing on the day the horizon ended**, not
 *    the one written afterwards.
 * 2. **A horizon that has not elapsed is withheld**, so a scoreboard never shows a
 *    permanent miss to a reader who asked early.
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

import {
  FORECAST_KINDS,
  FORECAST_MODEL_VERSION,
  type ForecastSnapshotRow,
} from "@/server/features/geo/services/forecastSnapshot";

import type { readForecastAccuracy as ReadForecastAccuracy } from "./forecastAccuracyReads";
// **Two type-only imports, and the `typeof` form is banned here.** The values are
// loaded after `vi.doMock` below, so only their *shapes* are named at the top: a
// value import would execute the module at load time, before the mock replaced
// `@/db`. `import type` gives the shape and erases the module, which is the whole
// distinction this file rests on.
import type { ForecastSnapshotsRepository as ForecastSnapshotsRepositoryType } from "@/server/features/geo/repositories/ForecastSnapshotsRepository";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/** The day the scoreboard reads on, and the days it scores against. */
const TODAY = "2026-10-14";

let client: Client;
let readForecastAccuracy: typeof ReadForecastAccuracy;
let ForecastSnapshotsRepository: typeof ForecastSnapshotsRepositoryType;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
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
      readFileSync("drizzle/0064_steady_fenris.sql", "utf8"),
    ].join(""),
  );

  vi.doMock("@/db", () => ({ db: testDb }));

  readForecastAccuracy = (await import("./forecastAccuracyReads"))
    .readForecastAccuracy;
  // **Imported after the mock, and that is load-bearing.** `@/db` binds to the D1
  // session at import time, so a repository imported at the top of this file would
  // have captured the real (absent) worker binding before `doMock` replaced it —
  // every write then fails with a `prepare` of undefined, which reads as a broken
  // test rather than as an import-order bug. The same trap `scheduledGeoRetention
  // .db.test.ts` documents in its own beforeAll.
  ForecastSnapshotsRepository = (
    await import("@/server/features/geo/repositories/ForecastSnapshotsRepository")
  ).ForecastSnapshotsRepository;

  // **The project, seeded once.** The snapshot table's foreign key is real, and a
  // write that precedes its parent fails with `SQLITE_CONSTRAINT_FOREIGNKEY` —
  // which reads as a broken repository rather than as a missing fixture. This is
  // the same trap the org-cascade test documents, in the other direction.
  await client.execute({
    sql: "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    args: ["proj-1", "Proj", 2840, "en", "2026-01-01T00:00:00.000Z"],
  });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM geo_forecast_snapshots");
  await client.execute("DELETE FROM geo_answers");
  await client.execute("DELETE FROM geo_snapshots");
});

/** Write one dated row straight through the repository, as the sweep would. */
async function write(
  input: Partial<ForecastSnapshotRow> & { issuedOn: string },
) {
  const row: ForecastSnapshotRow = {
    projectId: "proj-1",
    kind: FORECAST_KINDS.visibilityPace,
    subject: "chat_gpt",
    modelVersion: FORECAST_MODEL_VERSION,
    horizonDays: 90,
    shareBp: 4000,
    lowBp: 3000,
    highBp: 5000,
    perWeekBp: 400,
    nowBp: 3400,
    basedOn: 40,
    basedOnWeeks: 12,
    confidence: "moderate",
    note: null,
    ...input,
  };
  await ForecastSnapshotsRepository.insertSnapshot(row);
}

/**
 * Seed the answers the accuracy read measures from.
 *
 * `promptsAsked` and `mentions` are what `forecastVisibility` turns into the
 * "actual", so a test that wants a known measured share sets them here.
 */
async function seedAnswers(input: { rate: number; weeks?: number }) {
  const weeks = input.weeks ?? 12;
  // **`OR IGNORE`, and the ids are fixed.** `beforeEach` deletes answers and
  // snapshots but not the target, so a second call would collide on the unique key
  // — and the collision reads as a broken fixture rather than as a missing delete.
  await client.execute({
    sql: "INSERT OR IGNORE INTO geo_targets (id, project_id, domain, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [
      "target-1",
      "proj-1",
      "acme.com",
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

  const start = Date.parse("2026-07-20T00:00:00Z");
  void input;
  for (let index = 0; index < weeks; index += 1) {
    const startedAt = new Date(start + index * 7 * 86_400_000).toISOString();
    const snapshotId = `snap-${index}`;
    await client.execute({
      // **The denominator, and it is on the snapshot rather than the answer.**
      // `readForecastInput` reads `geo_snapshots.prompts_asked` to build the rate the
      // scoreboard scores against, and a live run leaves it null — the vendor does
      // not disclose its prompt count. A seed without it produces a null actual,
      // which is indistinguishable from "nothing was measured", so every case that
      // wants a *scored* row must set it here.
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
          // **The brand is named in the body, and it has to be.** The reader decides
          // a mention by finding `acme.com` or the target's name in the text, so an
          // answer that does not contain it counts as an *absence* — which is a
          // 0% share, not a missing one, and a fixture seeded without the brand
          // tests the wrong branch.
          "Acme is a strong choice for most teams.",
          platform,
          "live",
          2840,
          "en",
          startedAt,
          startedAt,
        ],
      });

      // **The join row, and it is not optional.** `readForecastInput` joins snapshots
      // to their answers through `geo_snapshot_answers`, so an answer inserted
      // without one is invisible to the reader — every run then counts as
      // `noAnswers`, which is the *answerless* branch rather than the measured one.
      await client.execute({
        sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?, ?)",
        args: [snapshotId, answerId],
      });
    }
  }
  void input;
}

describe("readForecastAccuracy", () => {
  it("refuses when the brand has no measured runs, and says so rather than returning empty panels", async () => {
    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: [],
    });

    expect(result.rows).toEqual([]);
    expect(result.projected).toBeNull();
    expect(result.emptyReason).toContain("no measured runs");
  });

  it("withholds a projection whose horizon has not elapsed", async () => {
    // Three days old, over a 90-day band. Scoring it now would compare a
    // projection with three days of the window it was quoted for.
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-10-11" });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toEqual([]);
    expect(result.emptyReason).toContain("old enough to score");
  });

  it("scores a projection whose horizon has elapsed", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-07-16" });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).not.toBe("too-early");
    expect(result.rows[0]?.issuedOn).toBe("2026-07-16");
    expect(result.rows[0]?.horizonDays).toBe(90);
    // The actual is the measured share, and it is present rather than null: the
    // archive has answers with a denominator, so there is something to score.
    expect(result.rows[0]?.actualShareBp).not.toBeNull();
  });

  it("includes the waiting projection only when the caller asks for it", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-10-11" });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
      includePending: true,
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).toBe("too-early");
    // And it names when the row becomes scorable, so "not yet" is a date rather
    // than a shrug.
    expect(result.rows[0]?.scorableOn).toBe("2027-01-09");
  });

  it("scores the row that was standing on the day the horizon ended, not the one written after", async () => {
    // The older row was made 90+ days before today and is the one whose horizon has
    // elapsed. A newer row was written three days ago, inside the horizon — it is
    // the row `asOfFor` must **not** return, because it would be scoring today's
    // opinion against today's fact.
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-07-16", shareBp: 4000 });
    await write({ issuedOn: "2026-10-11", shareBp: 9000 });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.issuedOn).toBe("2026-07-16");
    expect(result.rows[0]?.predictedShareBp).toBe(4000);
  });

  it("orders the scorable rows before the pending ones", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-07-16", shareBp: 4000 });
    await write({ issuedOn: "2026-10-11", shareBp: 9000 });
    await write({ issuedOn: "2026-10-01", shareBp: 5000 });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
      includePending: true,
    });

    const verdicts = result.rows.map((row) => row.verdict);
    expect(verdicts[0]).not.toBe("too-early");
    expect(verdicts).toContain("too-early");
    // The pending rows all sort after the scored one.
    const firstPending = verdicts.indexOf("too-early");
    const firstScored = verdicts.findIndex((v) => v !== "too-early");
    expect(firstScored).toBeLessThan(firstPending);
  });

  it("names the projection the headline comes from, with the band it speaks over", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-07-16", subject: "chat_gpt" });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.projected).not.toBeNull();
    expect(result.projected?.subject).toBe("chat_gpt");
    expect(result.projected?.horizonDays).toBe(90);
  });

  it("treats a platform with no stored forecast as absent rather than as a zero", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({ issuedOn: "2026-07-16", subject: "chat_gpt" });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt", "perplexity"],
    });

    // Only the platform with a row appears; the other is not silently scored as 0%.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.subject).toBe("chat_gpt");
  });

  it("reports a reading rather than a score when the stored projection declined", async () => {
    await seedAnswers({ rate: 0.3 });
    await write({
      issuedOn: "2026-07-16",
      shareBp: null,
      lowBp: null,
      highBp: null,
    });

    const result = await readForecastAccuracy({
      projectId: "proj-1",
      domain: "acme.com",
      today: TODAY,
      platforms: ["chat_gpt"],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict).toBe("no-forecast");
    expect(result.rows[0]?.errorBp).toBeNull();
    expect(result.rows[0]?.summary).toContain("declined to give a number");
  });
});
