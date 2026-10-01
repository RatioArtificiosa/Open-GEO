import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

import type { runQueueDrain } from "@/server/features/geo/services/queueDrainRunner";

/**
 * The drain **archives** what it collects.
 *
 * ## The defect this suite exists for
 *
 * `runQueueDrain` used to fetch the task, build the archived answer, check it was
 * attributable — and then write nothing at all. It marked the task `collected`
 * and returned true, so the run log said *"collected 1"* while `geo_answers`,
 * `geo_answer_citations`, `geo_snapshots` and `geo_snapshot_answers` all stayed
 * empty. A probe against the real database produced exactly that: four empty
 * tables and a cheerful coverage sentence.
 *
 * So the queue path — the one CL-200 through CL-202 built — had never once put an
 * answer in the archive, and every reader downstream of it was correct, tested,
 * and fed by nothing.
 *
 * ## Real database, and why `runBatch` is mocked here specifically
 *
 * The state transitions are about rows relating to each other, so this runs against
 * a **real in-memory SQLite** rather than a stubbed builder. `runBatch` is mocked
 * the way `runDenominator.test.ts` mocks it — with the *same* client, executing
 * the real statements — because Drizzle's `db` has no `execute` and the Geo writes
 * need a transaction handle. Mocking it against a second client is what made the
 * first probe report `no such table: geo_pending_tasks`: the answer was inserted
 * into a database that was not the one being inspected.
 */
let client: Client;
let drain: typeof runQueueDrain;

const PROJECT = "p1";
const TARGET = "t1";
const NOW = new Date("2026-10-01T00:00:00.000Z");

/**
 * A vendor task body the collector accepts: content plus one citation.
 *
 * `billing` is required by `DataforseoApiResponse` and its shape is
 * `{ path, costUsd }` — not the vendor's own `cost`/`time`/`currency`. The first
 * attempt guessed the vendor's field names and every call site failed with a
 * five-line error naming a property that does not exist, which reads like a schema
 * problem rather than a fixture that guessed.
 */
function vendorTask(tag: string) {
  return {
    billing: {
      path: ["/v3/ai_optimization/llm_responses/task_get/live"],
      costUsd: 0,
    },
    data: {
      tag,
      result: [
        {
          content: "acme.com is the leader in CRM.",
          citations: [
            { url: "https://acme.com/pricing", domain: "acme.com", rank: 1 },
          ],
        },
      ],
    },
  };
}

/** One pending queued task. `postedAt` must be recent or the drain reaps it. */
async function pendingTask(id: string, tag: string, postedAt = NOW) {
  await client.execute({
    sql: `INSERT INTO geo_pending_tasks
            (id, project_id, tag, vendor_task_id, se, model_name, prompt, status, posted_at)
          VALUES (?, ?, ?, ?, 'chat_gpt', 'gpt', 'best crm', 'pending', ?)`,
    args: [id, PROJECT, tag, `vt_${id}`, postedAt.toISOString()],
  });
}

async function countRows(table: string): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  const row = result.rows[0];
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  // `testDb` is passed **directly** rather than wrapped in `testDb.transaction`,
  // which is what `runDenominator.test.ts` does and why: libsql's
  // `file::memory:` is **per-connection**, so opening a transaction hands the
  // statements a second connection to an empty database. Every write then lands
  // where the assertions cannot see it, and the failure reads as
  // `no such table: geo_pending_tasks` — a schema complaint about a fixture that
  // is perfectly correct.
  //
  // Atomicity is given up for the test, deliberately: the properties under test are
  // about which rows exist afterwards, and a real transaction here would test
  // libsql's in-memory connection scoping rather than the drain.
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (
      build: (tx: typeof testDb) => readonly Promise<unknown>[],
    ): Promise<void> => {
      for (const statement of build(testDb)) await statement;
    },
  }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0053_marvelous_sharon_carter.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      // The alerting path writes a dispatch row for every decision, and the drain
      // now calls it. Without this table the drain's own alert fails with
      // `no such table: geo_alert_dispatches` — which reads as a missing
      // migration rather than a fixture that stopped at 0053.
      ...readFileSync("drizzle/0054_freezing_ultimo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      // `prompts_asked` and `target_id` both arrive after 0048.
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
    ].join("\n"),
  );

  drain = (await import("@/server/features/geo/services/queueDrainRunner"))
    .runQueueDrain;

  await client.execute("INSERT INTO projects (id, name) VALUES (?, ?)", [
    PROJECT,
    "P",
  ]);
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  for (const t of [
    "geo_snapshot_answers",
    "geo_answer_citations",
    "geo_answers",
    "geo_snapshots",
    "geo_pending_tasks",
    "geo_targets",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
  await client.execute(
    `INSERT INTO geo_targets
       (id, project_id, name, domain, location_code, language_code, created_at)
     VALUES (?, ?, 'Acme', 'acme.com', 2840, 'en', '2026-01-01 00:00:00')`,
    [TARGET, PROJECT],
  );
});

describe("the queue drain archives what it collects", () => {
  it("writes the answer, its citation, a snapshot and the link", async () => {
    // **The regression.** Before the fix every one of these counts was 0 while the
    // drain reported `collected: 1` — the sentence an operator reads as success.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);

    const result = await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    expect(result.collected).toBe(1);
    expect(await countRows("geo_answers")).toBe(1);
    // The citation is the whole point of the queued path: the Live endpoint
    // returns mentions without them.
    expect(await countRows("geo_answer_citations")).toBe(1);
    expect(await countRows("geo_snapshots")).toBe(1);
    // Without the link a snapshot has no answers and "what did this run find?" is
    // unanswerable — the reason `insertAnswers` takes a snapshot id at all.
    expect(await countRows("geo_snapshot_answers")).toBe(1);
  });

  it("records the run's brand and a denominator of one", async () => {
    // `target_id` is what CL-501e's brand-scoped alerting reads, and
    // `prompts_asked` is the only thing that makes the forecast computable for a
    // queued run at all. A null here means the rate is permanently refused.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    const snap = await client.execute(
      "SELECT target_id, prompts_asked, status FROM geo_snapshots",
    );
    const row = snap.rows[0];
    expect(row?.target_id).toBe(TARGET);
    expect(Number(row?.prompts_asked)).toBe(1);
    expect(row?.status).toBe("complete");

    const answer = await client.execute(
      "SELECT target_id, platform, source, location_code, language_code, answer_text FROM geo_answers",
    );
    const a = answer.rows[0];
    expect(a?.target_id).toBe(TARGET);
    expect(a?.platform).toBe("chat_gpt");
    expect(a?.source).toBe("llm_responses");
    // Market comes from the target, not from the vendor payload — a row filed
    // under a hardcoded 0/"en" would be invisible to every read that filters on it.
    expect(Number(a?.location_code)).toBe(2840);
    expect(a?.language_code).toBe("en");
    expect(a?.answer_text).toContain("acme.com");
  });

  it("points the settled task at the run its answer landed in", async () => {
    // `geo_pending_tasks.snapshot_id` existed for exactly this and was null on
    // every collected task, so "which run produced this answer?" had no answer
    // for the queued path.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    const task = await client.execute(
      "SELECT status, snapshot_id FROM geo_pending_tasks WHERE id = 'pt1'",
    );
    expect(task.rows[0]?.status).toBe("collected");
    const snap = await client.execute("SELECT id FROM geo_snapshots");
    expect(task.rows[0]?.snapshot_id).toBe(snap.rows[0]?.id);
  });

  it("settles a collected answer for a deleted target as failed, with the reason", async () => {
    // The answer is real and the vendor charged for it, but it cannot be
    // attributed to a brand that no longer exists. Filing it against whichever
    // target exists would put one company's answer in another's history — so it is
    // refused with a reason, which is what `buildArchivedAnswer` does for a tag it
    // cannot parse.
    await client.execute("DELETE FROM geo_targets");
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);

    const result = await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    expect(result.collected).toBe(0);
    expect(result.failed).toBe(1);
    expect(await countRows("geo_answers")).toBe(0);
    expect(await countRows("geo_snapshots")).toBe(0);
    const task = await client.execute(
      "SELECT status, error_message FROM geo_pending_tasks WHERE id = 'pt1'",
    );
    expect(task.rows[0]?.status).toBe("failed");
    // Read through `expect(...).toEqual(expect.stringContaining(...))` rather than
    // `String(...)`: libsql types the column as `unknown`, and coercing it would
    // print `[object Object]` for any driver that stopped returning a string —
    // turning a schema change into a passing assertion about the wrong thing. The
    // matcher asserts the type and the content together.
    expect(task.rows[0]?.error_message).toEqual(
      expect.stringContaining("no longer exists"),
    );
  });

  it("alerts on the snapshots it archived", async () => {
    // **The gap this closes.** `scheduledGeoPatrol` is the only production caller of
    // `alertOnRunChange`, and it runs *before* this drain on the same tick — so a
    // queued answer was archived here and alerted on by nothing, ever. The patrol
    // structurally cannot cover it: a queued run posts prompts and returns, so its
    // own snapshot has no answers to diff.
    //
    // Asserted through the archive rather than by mocking the alert: the two
    // snapshots that straddle a mention change must produce a decision, and a
    // `no_baseline` or `not_applicable` here would mean the drain archived the second
    // answer without the alert noticing.
    // `beforeEach` already creates the target, so this needs no setup.
    // Two days on, so the second pass is outside the cadence window.
    const day2 = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);

    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    // Second pass, a day later: the brand is no longer named. A **different** tag
    // index, because the tag is unique per target/platform/index and reusing `1`
    // collides with the first row — a constraint violation that reads as a schema
    // problem rather than a fixture that reused an id.
    await pendingTask("pt2", `${TARGET}:chat_gpt:2`, day2);
    await drain({
      now: day2,
      fetchTask: async () => ({
        billing: {
          path: ["/v3/ai_optimization/llm_responses/task_get/live"],
          costUsd: 0,
        },
        data: { tag: `${TARGET}:chat_gpt:2`, result: [{ content: "Nobody." }] },
      }),
    });

    // Both answers archived.
    expect(await countRows("geo_answers")).toBe(2);
    expect(await countRows("geo_snapshots")).toBe(2);
    // **And the second pass was actually alerted on.** This is the assertion the
    // gap turns on, so it is exact rather than permissive: the first snapshot has no
    // baseline, the second has one and a real change, so exactly one dispatch must
    // exist. A drain that archived the change and alerted on nothing would leave
    // zero rows here, and zero is the bug.
    const dispatches = await client.execute(
      "SELECT COUNT(*) AS n FROM geo_alert_dispatches",
    );
    expect(Number(dispatches.rows[0]?.n ?? 0)).toBe(1);
  });

  it("reports a queued mention change as the per-prompt change it is", async () => {
    // The reading this pins down. A queued run asks N prompts and the answers
    // arrive over up to 72 hours, each archived as its own snapshot of
    // `prompts_asked: 1`. So the diff between two of them is a change in **one
    // prompt's answer** — not a shift in a share over N samples.
    //
    // The alternative would have been badly wrong: grouping five answers into one
    // snapshot with `prompts_asked: 5` would make one prompt changing move a
    // five-sample rate, implying four unchanging samples that were never measured
    // together. Asserting the *body* rather than a count is what pins the reading:
    // the alert must name the prompt, because that is the unit that actually moved.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    const day2 = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    // Index `2`, not `1`: `geo_pending_tasks` is unique on
    // `(project_id, tag)`, and the tag's index is the position within **one
    // run's** plan. So two runs asking the same prompt both use index 1, and
    // reusing it violates the constraint — which is itself a useful fact: a queued
    // project cannot re-post the same prompt at the same index until the first
    // task is settled.
    await pendingTask("pt2", `${TARGET}:chat_gpt:2`, day2);
    await drain({
      now: day2,
      fetchTask: async () => ({
        billing: {
          path: ["/v3/ai_optimization/llm_responses/task_get/live"],
          costUsd: 0,
        },
        data: {
          tag: `${TARGET}:chat_gpt:2`,
          result: [{ content: "Somebody else entirely." }],
        },
      }),
    });

    const dispatch = await client.execute(
      // `subject` and `detail`, not `message` — and `detail` is nullable, so it
      // is coalesced rather than read blind. Guessing a column name here is what
      // made the first version of this test fail with `no such column`, which
      // reads as a missing migration rather than a bad query.
      "SELECT subject, detail, change_count FROM geo_alert_dispatches",
    );
    const row = dispatch.rows[0];
    // Narrowed rather than `String(...)`-cast, and the rule is right that it must
    // be: a driver row is not a `string`, so `String(row.subject)` would produce
    // `"[object Object]"` and **every `toMatch` below would still pass** — a test
    // that can only fail on a missing row is a test that proves nothing. Reading
    // the value and refusing anything that is not text is the version that can
    // actually fail.
    const subject = typeof row?.subject === "string" ? row.subject : "";
    const detail = typeof row?.detail === "string" ? row.detail : "";

    // **The subject, which is the only part a phone shows.** It is a deliberately
    // terse summary — `alertSubject` names the *worst* thing in the batch and
    // nothing else, because the reader has three seconds to decide whether to open
    // it. So the right assertion is the shape it must have, not a body it never
    // contained: naming the brand or the prompt here would be asking for text the
    // formatter has always declined to put on a notification line.
    //
    // The first version of this test asserted `subject` contains "acme.com" and
    // failed. That was the test being wrong, not the product: the brand is in the
    // *body* (which names the project), and the body is not persisted on the
    // dispatch row.
    expect(subject).toMatch(/mention lost/);
    // And `detail` is legitimately null here — the per-change lines live in the
    // body, not the dispatch row. Asserting it would be asserting a schema change
    // nobody asked for.
    expect(detail).toBe("");

    // **Two changes, from one prompt's answer.** A queued run archives one
    // snapshot per answer, so this batch covers exactly one prompt — and the
    // second answer names neither the brand nor any source, so both the mention
    // *and* the citation are gone. Two changes for one prompt is the honest
    // reading; a count of 1 would mean one of the two was missed.
    //
    // This is the assertion that would catch a cross-brand diff. If the baseline
    // had resolved to a different target's run, the change count and the subject
    // would describe another company's answer.
    expect(Number(row?.change_count ?? 0)).toBe(2);
  });

  it("reports coverage that matches what was archived", async () => {
    // **The fraction used to be true and meant nothing.** `coverageFraction` counts
    // `geo_pending_tasks.status === 'collected'`, and before CL-501f that status
    // was set for answers the drain then threw away — so a project could sit at
    // "100% covered" over an archive with nothing in it. The number was never a
    // lie about the *queue*; it was a lie about the *product*, because a reader
    // takes it as "we have their answers".
    //
    // Now that the drain archives, the two agree, and this pins the agreement so
    // the next change to either side has to say which one it broke.
    //
    // The passes are a day apart because the cadence gate — which is the subject
    // of the next test — makes a second pass inside the window a *skip*. That is
    // the gate working, not a failure to collect.
    for (let i = 1; i <= 3; i += 1) {
      await pendingTask(`pt${i}`, `${TARGET}:chat_gpt:${i}`);
      await drain({
        now: new Date(NOW.getTime() + (i - 1) * 25 * 60 * 60 * 1000),
        fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:${i}`),
      });
    }

    const { coverageFraction } =
      await import("@/server/features/geo/services/queueDrain");
    const coverage = await coverageFraction(PROJECT);

    expect(coverage.collected).toBe(3);
    expect(coverage.total).toBe(3);
    expect(coverage.fraction).toBe(1);
    // The agreement itself: every claimed collection is a row someone can read.
    expect(await countRows("geo_answers")).toBe(3);
  });

  it("does not archive the same task twice", async () => {
    // The duplicate guard is `status = 'pending'` on the settle, so a second pass
    // finds nothing to do. The archive must not gain a second answer either —
    // `geo_answers.id` is the answer's own id, so a repeat would be a distinct row
    // unless the collect step is skipped.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    const first = await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });
    const second = await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    expect(first.collected).toBe(1);
    expect(second.collected).toBe(0);
    expect(second.attemptedTasks).toBe(0);
    expect(await countRows("geo_answers")).toBe(1);
  });

  it("skips the look when the queue was worked on inside the window", async () => {
    // **The gate that could never fire.** `isDrainDue` is documented as a 24-hour
    // cadence and has five passing cases in its own suite, but `runQueueDrain` was
    // always handed `null` — so it returned `true` on every tick, and the cron runs
    // every five minutes. That is 288 wasted looks a day, which cost little while
    // the drain threw its collections away and costs real vendor calls now that it
    // archives.
    //
    // The answer now comes from the queue's own rows, so a queue worked on inside
    // the window is not due — and the skip says why, because a silent skip is the
    // failure this module exists to make visible.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });
    expect(await countRows("geo_answers")).toBe(1);

    // Five minutes later — inside the 24-hour window.
    let calls = 0;
    const soon = new Date(NOW.getTime() + 5 * 60 * 1000);
    const skipped = await drain({
      now: soon,
      fetchTask: async () => {
        calls += 1;
        return vendorTask(`${TARGET}:chat_gpt:1`);
      },
    });

    expect(skipped.attempted).toBe(false);
    expect(skipped.collected).toBe(0);
    // No vendor call at all — the point of the gate.
    expect(calls).toBe(0);
    // And it says why rather than reporting silence.
    expect(skipped.skipped).toMatch(/vendor decides when/i);
    // Nothing new archived.
    expect(await countRows("geo_answers")).toBe(1);
  });

  it("looks again once the window has passed, without any persisted state", async () => {
    // The other half, and the reason the answer is read from the rows rather than
    // a new column: **nothing needs to be remembered for the gate to work.** A
    // queue whose only task was collected 25 hours ago is due again, and a brand
    // new task on an otherwise empty queue is due immediately — so a posting is
    // never delayed by a stale "last looked" that a crash failed to write.
    await pendingTask("pt1", `${TARGET}:chat_gpt:1`);
    await drain({
      now: NOW,
      fetchTask: async () => vendorTask(`${TARGET}:chat_gpt:1`),
    });

    // 25 hours later: outside the window, so the drain looks.
    let calls = 0;
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const again = await drain({
      now: later,
      fetchTask: async () => {
        calls += 1;
        return vendorTask(`${TARGET}:chat_gpt:1`);
      },
    });

    expect(again.attempted).toBe(true);
    // The queue is empty, so there is nothing to collect — but it *looked*, which
    // is what distinguishes a due pass from a skipped one.
    expect(again.attemptedTasks).toBe(0);
    expect(again.coverage).toMatch(/queue was empty/i);
    expect(calls).toBe(0);
  });
});
