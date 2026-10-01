import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { readForecastInput as ReadForecastInput } from "@/server/features/geo/services/visibilityForecastReads";

/**
 * The forecast's look-back limit counts **runs**, not answer rows.
 *
 * ## Why this is its own file
 *
 * The subject is a join fan-out, and every other test in
 * `visibilityForecastReads.db.test.ts` uses a fixture that writes **one answer per
 * snapshot** — which is exactly why none of them could see the defect. One answer
 * is one row is one run, and the distinction between a row cap and a run cap never
 * appears. Putting the test beside them also pushed that file past `max-lines`,
 * which is the rule correctly reporting that it had acquired a second subject.
 *
 * ## The defect
 *
 * The scoping subquery left-joins `geo_snapshot_answers` and `geo_answers`, so a
 * snapshot with N answers produces N rows, and `.limit(...)` was applied to *that
 * row set*. A Live snapshot can hold up to 100 answers
 * (`limit: Math.min(remaining, 100)` in `GeoPatrol`), so **a limit of 24 could
 * select a single run** — and the forecast then read one run while reporting that
 * it had read twenty-four.
 *
 * The lie was not confined to the reading. The cropping note compares
 * `total >= limit` against a count of *distinct snapshots*, so with one run
 * selected the check was false, the count query never ran, and **the note never
 * reported that older runs had been dropped** — the one case where a reader most
 * needs to know. "Forecasted from all 1 runs read here" is what a project with a
 * year of history would have been told.
 *
 * `selectDistinct` on the id alone fixes it. On a *pair* of columns it does not:
 * the subquery feeds `inArray`, and SQLite rejects a two-column sub-select with
 * `sub-select returns 2 columns - expected 1`.
 *
 * Real SQLite rather than a stub, for the same reason as the sibling file: **which
 * rows come back IS the claim**, and a mocked query builder cannot catch a missing
 * `DISTINCT`.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "project_1";
const ACME = "target_acme";

let client: Client;
let readForecastInput: typeof ReadForecastInput;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      // 0055 adds the denominator, 0056 adds geo_snapshots.target_id.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
    ].join("\n"),
  );

  readForecastInput = (
    await import("@/server/features/geo/services/visibilityForecastReads")
  ).readForecastInput;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  for (const table of [
    "geo_snapshot_answers",
    "geo_answers",
    "geo_snapshots",
    "geo_targets",
    "projects",
  ]) {
    await client.execute(`DELETE FROM ${table}`);
  }
  await client.execute({
    sql: "INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id) VALUES (?,?,?,?,?,?)",
    args: [PROJECT, "Acme Corp", 2840, "en", "2026-01-01 00:00:00", "org_1"],
  });
  await client.execute({
    sql: "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [ACME, PROJECT, "acme.com", "acme.com", 2840, "en", "2026-01-01 00:00:00"],
  });
});

/** One run holding `answerCount` answers — the shape a real Live snapshot has. */
async function addRunWithAnswers(args: {
  snapshotId: string;
  startedAt: string;
  answerCount: number;
}) {
  await client.execute({
    sql: "INSERT INTO geo_snapshots (id, project_id, target_id, started_at, prompts_asked, status, created_by) VALUES (?,?,?,?,?,?,?)",
    args: [
      args.snapshotId,
      PROJECT,
      ACME,
      args.startedAt,
      args.answerCount,
      "complete",
      "user",
    ],
  });
  for (let a = 0; a < args.answerCount; a += 1) {
    const answerId = `${args.snapshotId}_a${a}`;
    await client.execute({
      sql: "INSERT INTO geo_answers (id, project_id, target_id, prompt, answer_text, platform, source, location_code, language_code, answered_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      args: [
        answerId,
        PROJECT,
        ACME,
        `prompt ${a}`,
        "acme.com is a good choice.",
        "chat_gpt",
        "llm_responses",
        2840,
        "en",
        args.startedAt,
      ],
    });
    await client.execute({
      sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?,?)",
      args: [args.snapshotId, answerId],
    });
  }
}

describe("the forecast's look-back window", () => {
  it("counts a run once however many answers it holds", async () => {
    for (const [i, id] of ["run_a", "run_b"].entries()) {
      await addRunWithAnswers({
        snapshotId: id,
        startedAt: `2026-09-1${i}T00:00:00.000Z`,
        answerCount: 5,
      });
    }

    // A limit of 2 selects two *runs*, not two answer rows. This is the assertion
    // that fails without `selectDistinct`: without it the limit applies to the
    // fanned-out row set, the two runs' first answers are selected, and the result
    // collapses back to a single run.
    const both = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
      limit: 2,
    });
    const runIds = new Set(both.observations.map((o) => o.snapshotId));
    // **Which** runs came back, not in what order — compared as a set, so the
    // assertion is about count and membership and nothing about ordering, which
    // this test has no claim on.
    expect(runIds.size).toBe(2);
    expect(runIds.has("run_a")).toBe(true);
    expect(runIds.has("run_b")).toBe(true);
  });

  it("names the run the window dropped, rather than implying it is the history", async () => {
    for (const [i, id] of ["run_a", "run_b"].entries()) {
      await addRunWithAnswers({
        snapshotId: id,
        startedAt: `2026-09-1${i}T00:00:00.000Z`,
        answerCount: 5,
      });
    }

    const one = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
      limit: 1,
    });

    expect(new Set(one.observations.map((o) => o.snapshotId)).size).toBe(1);
    expect(one.windowed.considered).toBe(1);
    // The count of the *project's* runs, so the note can name what was not read.
    expect(one.windowed.totalRunsInProject).toBe(2);
    expect(one.note).toMatch(/1 older run was outside the look-back window/);
  });
});