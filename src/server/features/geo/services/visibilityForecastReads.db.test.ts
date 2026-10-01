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

import type {
  readForecastInput as ReadForecastInput,
  ForecastInput,
} from "@/server/features/geo/services/visibilityForecastReads";

/**
 * The forecast reader's scoping, against a real database.
 *
 * ## Why this file exists at all
 *
 * `readForecastInput` had **no test**, and that is not an oversight — it imports
 * `@/db`, so a test that opens it without a Worker environment dies at import
 * with `Cannot find package 'cloudflare:workers'`. So it shipped untested, and
 * shipped with the bug below.
 *
 * ## The bug this test is the regression for
 *
 * **`geo_snapshots` has no `target_id`** — only `project_id` and `prompt_set_id`.
 * A project can monitor several brands, and the reader filtered on `projectId`
 * alone. So asking about `acme.com` returned every run the project had ever made
 * — including the ones measuring `globex.com` — and labelled all of them
 * `acme.com` in the payload.
 *
 * The result would have looked like a measurement, been another company's data,
 * and said nothing about being either. That is the failure mode this whole
 * product exists to prevent, produced by its own visibility panel.
 *
 * ## Real SQLite rather than a stub
 *
 * Same reasoning as `scheduledGeoPatrol.test.ts`: **which rows come back IS the
 * claim.** A mocked query builder returns whatever it was told to return, so it
 * cannot catch a missing `WHERE` clause — which is precisely this bug. The join
 * runs against real migrations, so a wrong column name fails here rather than in
 * production.
 */
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "project_1";
const ACME = "target_acme";
const GLOBEX = "target_globex";

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
        .filter((statement) => !statement.includes("DROP TABLE")),
      // The denominator. Without this the reader selects a column the fixture
      // table lacks and fails with `no such column` — a broken-product-looking
      // error raised by a test about scoping.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        // 0056 adds geo_snapshots.target_id, which the alerting reader filters on.
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // 0056 adds geo_snapshots.target_id, which the alerting reader filters on.
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
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
  // Wiped by hand rather than by re-running the migration: the schema is
  // created once in `beforeAll` because re-applying `CREATE TABLE` would fail.
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
});

async function addTarget(id: string, domain: string) {
  await client.execute({
    sql: "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [id, PROJECT, domain, domain, 2840, "en", "2026-01-01 00:00:00"],
  });
}

/**
 * One run with one answer.
 *
 * `promptsAsked` is the denominator and is what the bug hid behind: without it
 * the run is skipped before the numerator is ever examined, so a scoping test
 * that omitted it would pass against a reader that ignores the domain entirely.
 */
async function addRun(args: {
  snapshotId: string;
  startedAt: string;
  promptsAsked: number | null;
  targetId: string;
  answerText: string | null;
  mentioned?: boolean;
  platform?: string;
}) {
  await client.execute({
    sql: "INSERT INTO geo_snapshots (id, project_id, started_at, prompts_asked, status, created_by) VALUES (?,?,?,?,?,?)",
    args: [
      args.snapshotId,
      PROJECT,
      args.startedAt,
      args.promptsAsked,
      "complete",
      "user",
    ],
  });
  const answerId = `answer_${args.snapshotId}`;
  await client.execute({
    sql: "INSERT INTO geo_answers (id, project_id, target_id, prompt, answer_text, platform, source, location_code, language_code, answered_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [
      answerId,
      PROJECT,
      args.targetId,
      "best geo tool",
      args.answerText,
      args.platform ?? "chat_gpt",
      args.mentioned === true ? "mentions_search" : "llm_responses",
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

describe("reading the forecast's inputs", () => {
  it("never returns another brand's runs", async () => {
    // **The regression.** One project, two monitored brands, both with a run that
    // carries a real denominator. Asking about acme.com must produce exactly
    // acme's observation.
    //
    // Against the project-scoped reader this returned two observations, one of
    // them globex's, both labelled `acme.com` — a rate for globex presented as
    // acme's.
    await addTarget(ACME, "acme.com");
    await addTarget(GLOBEX, "globex.com");
    await addRun({
      snapshotId: "run_acme",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 10,
      targetId: ACME,
      answerText: "Try acme.com for this.",
    });
    await addRun({
      snapshotId: "run_globex",
      startedAt: "2026-09-08T00:00:00.000Z",
      promptsAsked: 20,
      targetId: GLOBEX,
      answerText: "Try globex.com for this.",
    });

    const result: ForecastInput = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.domain).toBe("acme.com");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.snapshotId).toBe("run_acme");
    expect(result.observations[0]?.promptsAsked).toBe(10);
    expect(result.observations[0]?.mentions).toBe(1);
  });

  it("reports the count a customer would ask about next", async () => {
    // One brand, three runs, only one measurable. `skipped` is how the panel
    // explains the gap, and the note has to agree with it — a note that says
    // "from 1 of 3 runs" beside a skipped count of 0 is a panel lying in two
    // places at once.
    await addTarget(ACME, "acme.com");
    await addRun({
      snapshotId: "run_good",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 12,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });
    await addRun({
      snapshotId: "run_no_denominator",
      startedAt: "2026-09-08T00:00:00.000Z",
      promptsAsked: null,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });
    await addRun({
      snapshotId: "run_other_platform",
      startedAt: "2026-09-15T00:00:00.000Z",
      promptsAsked: 8,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
      platform: "gemini",
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.observations).toHaveLength(1);
    expect(result.skipped.unknownDenominator).toBe(1);
    // A gemini answer on a chat_gpt query is not a usable run for that platform,
    // and it is reported as such rather than counted as a miss.
    expect(result.skipped.noAnswers).toBe(1);
    expect(result.skipped.noText).toBe(0);
    expect(result.note).toMatch(/1 of 3 runs/);
  });

  it("drops a run whose answer it cannot read, rather than shrinking it", async () => {
    // The denominator says 10 prompts were asked. Only one answer came back, and
    // it is unreadable. Counting that answer as "not mentioned" would report 0/1
    // as though it were 0/10 — same zero, a tenth of the sample, and the flatter
    // direction. So the run is skipped whole and the reason is distinguishable.
    await addTarget(ACME, "acme.com");
    await addRun({
      snapshotId: "run_unreadable",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 10,
      targetId: ACME,
      answerText: null,
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.observations).toHaveLength(0);
    expect(result.skipped.noText).toBe(1);
    expect(result.skipped.unknownDenominator).toBe(0);
  });

  it("counts a zero denominator as unknown, not as zero visibility", async () => {
    // `0` and `null` are different states and the schema says so. A run that
    // asked nothing is not a run that was mentioned in none of its prompts, and
    // rendering it as 0% would be a claim about visibility the run never made.
    await addTarget(ACME, "acme.com");
    await addRun({
      snapshotId: "run_zero",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 0,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.observations).toHaveLength(0);
    expect(result.skipped.unknownDenominator).toBe(1);
  });

  it("keeps the newest runs whole, never a run cut mid-way", async () => {
    // `limit` bounds runs, and it has to: a row-level cap would return only some
    // of a run's answers, so the run would look like one that found nothing and
    // the rate would be computed on a fraction of the prompts asked.
    //
    // The tell is the *denominator*. If a run is cut, `promptsAsked` stays at its
    // full value while fewer answers back it, so a limit of 1 must still return
    // the newest run at its real denominator rather than a truncated one.
    await addTarget(ACME, "acme.com");
    await addRun({
      snapshotId: "run_old",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 7,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });
    await addRun({
      snapshotId: "run_new",
      startedAt: "2026-09-20T00:00:00.000Z",
      promptsAsked: 11,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
      limit: 1,
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.snapshotId).toBe("run_new");
    // Whole, not truncated: the denominator is the run's own.
    expect(result.observations[0]?.promptsAsked).toBe(11);
    expect(result.observations[0]?.mentions).toBe(1);
  });

  it("counts a run that archived nothing, rather than omitting it", async () => {
    // **A run that asked and archived nothing is the fact a reader most needs.**
    //
    // The scoping query used to inner-join `geo_snapshot_answers`, so a run with no
    // archived answers matched no row, appeared in no bucket, and was therefore
    // never counted anywhere — not in `skipped`, not in `total`, not in the note.
    // The panel said "2 runs not included" when three were.
    //
    // This is the difference between "we asked 40 prompts and got nothing back"
    // and "we cannot say what happened", and silently collapsing the two is the
    // failure this product exists to prevent. The `limit` bounds runs, so the
    // denominator exists precisely so the gap can be *reported* rather than
    // dropped.
    await addTarget(ACME, "acme.com");
    await addRun({
      snapshotId: "run_good",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 12,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });
    // A measured run that archived nothing at all. Note the project id is the
    // shared constant, not a literal: the first attempt wrote 'p1' and the insert
    // failed on the foreign key, which reads as a schema problem rather than a
    // typo in a fixture.
    await client.execute({
      sql: `INSERT INTO geo_snapshots (id, project_id, started_at, prompts_asked, status, created_by)
            VALUES ('run_silent', ?, '2026-09-08T00:00:00.000Z', 40, 'complete', 'user')`,
      args: [PROJECT],
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.observations).toHaveLength(1);
    // It is counted, and as *no answers* rather than as an unknown denominator —
    // this run knew exactly what it asked.
    expect(result.skipped.noAnswers).toBe(1);
    expect(result.skipped.unknownDenominator).toBe(0);
    // And the note agrees with the counts.
    expect(result.note).toMatch(/1 of 2 runs/);
  });

  it("says when the look-back window cropped older runs", async () => {
    // "Forecasted from 5 of 6 runs" reads like the project has six runs. It has
    // twenty-six, and the window simply stopped reading at twenty-four — so the
    // note implied a history that had ended when it had merely been cropped.
    //
    // A reader who believes the history ended draws a conclusion ("we stopped
    // measuring") from a limit, and the panel is the only place they could learn
    // otherwise.
    await addTarget(ACME, "acme.com");
    for (let i = 0; i < 5; i += 1) {
      await addRun({
        snapshotId: `run${i}`,
        startedAt: `2026-09-0${i + 1}T00:00:00.000Z`,
        promptsAsked: 10,
        targetId: ACME,
        answerText: "acme.com is a good choice.",
      });
    }

    const insideWindow = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
      limit: 3,
    });

    // The window held, and the payload says so rather than leaving the caller to
    // assume the project has three runs.
    expect(insideWindow.observations).toHaveLength(3);
    expect(insideWindow.windowed.considered).toBe(3);
    expect(insideWindow.windowed.totalRunsInProject).toBe(5);

    // The note names the runs that were not read, in words — on **both** branches.
    // The first version mentioned cropping only when some read run was skipped,
    // so a window where every run happened to be usable said nothing: the case in
    // which a reader is most likely to believe the window is the whole history.
    expect(insideWindow.note).toMatch(
      /2 older runs were outside the look-back/,
    );

    // And the same fact when a run *was* also skipped. Six runs now exist and the
    // window reads three, so three are cropped — asserted rather than assumed,
    // because a note quoting the wrong count would be worse than no note at all.
    await client.execute({
      sql: `INSERT INTO geo_snapshots (id, project_id, started_at, prompts_asked, status, created_by)
            VALUES ('run_unknown', ?, '2026-09-08T00:00:00.000Z', NULL, 'complete', 'user')`,
      args: [PROJECT],
    });
    const mixed = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
      limit: 3,
    });
    expect(mixed.observations).toHaveLength(2);
    expect(mixed.skipped.unknownDenominator).toBe(1);
    expect(mixed.windowed.totalRunsInProject).toBe(6);
    expect(mixed.note).toMatch(/3 older runs were not read\./);

    // A window that covered everything reports no cropping at all. Six runs now
    // exist and the default window is twenty-four, so the whole archive is read —
    // and one of them is unmeasurable, so the note is the partial one with no
    // cropping clause.
    const whole = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });
    expect(whole.windowed.considered).toBe(6);
    expect(whole.windowed.totalRunsInProject).toBeNull();
    expect(whole.note).toMatch(/5 of 6 runs\./);
    expect(whole.note).not.toMatch(/look-back|older run/);
  });

  it("finds the target whether the stored domain carries a scheme or a path", async () => {
    // `getTargetByDomain` used to normalise only the *argument*, never the stored
    // `row.domain`. So a target saved as `https://www.acme.com/pricing` — which a
    // paste produces easily — matched nothing, and the forecast refused with "not a
    // monitored target" for a brand the customer had added.
    //
    // The refusal is the dangerous part: it is indistinguishable from "you have not
    // set this up", so the reader is told to go and add a brand that is already
    // there.
    await addTarget(ACME, "https://www.acme.com/pricing");
    await addRun({
      snapshotId: "run",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 10,
      targetId: ACME,
      answerText: "acme.com is a good choice.",
    });

    // Asked for by its bare form, which is what the UI and the MCP tool send.
    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.domain).toBe("https://www.acme.com/pricing");
    expect(result.observations).toHaveLength(1);
  });

  it("counts a mention found by the brand's name rather than its domain", async () => {
    // The capability existed in the schema and was never read.
    //
    // `geo_targets.name` and `geo_targets.aliases` have been there since the table
    // was created, with the comment "Brands are often wider than a domain", and
    // `GeoService` writes both and the wire schema validates both — and nothing
    // ever *read* them. So an answer that named the brand in prose and never typed
    // its domain was scored as a miss, and a customer who filled in the alias
    // field got a **lower** visibility number than one who left it empty. That is
    // backwards, and it is silent.
    await client.execute({
      sql: `INSERT INTO geo_targets
              (id, project_id, name, domain, aliases, location_code, language_code, created_at)
            VALUES (?, ?, ?, ?, ?, 2840, 'en', '2026-01-01 00:00:00')`,
      args: [ACME, PROJECT, "Acme Corp", "acme.com", "Acme, Acme Corporation"],
    });
    await addRun({
      snapshotId: "run",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 4,
      targetId: ACME,
      // Names the brand twice and the domain not at all.
      answerText:
        "Acme Corporation is the usual choice, though Acme Corp has rivals.",
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    // All four prompts are on the same answer row, so the mention count is the
    // number of prompts that named the brand: one, via the alias.
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.mentions).toBe(1);
  });

  it("still finds nothing when the answer names neither the domain nor an alias", async () => {
    // The negative control, without which the test above would pass against a rule
    // that matched everything.
    await client.execute({
      sql: `INSERT INTO geo_targets
              (id, project_id, name, domain, aliases, location_code, language_code, created_at)
            VALUES (?, ?, ?, ?, ?, 2840, 'en', '2026-01-01 00:00:00')`,
      args: [ACME, PROJECT, "Acme Corp", "acme.com", "Acme"],
    });
    await addRun({
      snapshotId: "run",
      startedAt: "2026-09-01T00:00:00.000Z",
      promptsAsked: 4,
      targetId: ACME,
      answerText: "Salesforce and HubSpot are the usual choices for teams.",
    });

    const result = await readForecastInput({
      projectId: PROJECT,
      domain: "acme.com",
      platform: "chat_gpt",
    });

    expect(result.observations[0]?.mentions).toBe(0);
  });

  it("refuses a domain this project does not monitor", async () => {
    // The lookup is what makes the scoping possible at all: without a target
    // there is no `target_id` to filter on, so the reader cannot answer and says
    // so instead of falling back to project-wide rows.
    await addTarget(ACME, "acme.com");

    await expect(
      readForecastInput({
        projectId: PROJECT,
        domain: "not-monitored.com",
        platform: "chat_gpt",
      }),
    ).rejects.toThrow(/not a monitored target/i);
  });
});
