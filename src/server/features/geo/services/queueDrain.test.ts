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

import type {
  buildDrainReport,
  coverageFraction,
  listCollectableTasks,
  readQueueState,
  reapExpiredTasks,
  settleCollectedTask,
  settleFailedTask,
} from "@/server/features/geo/services/queueDrain";

/**
 * Draining the Standard queue.
 *
 * The reporting rules are pure and tested directly; the state transitions run
 * against a **real in-memory SQLite** because the properties that matter are
 * about rows relating to each other — a second delivery finding nothing to do,
 * a reaper not touching a task that is still in flight.
 */
let client: Client;
let buildReport: typeof buildDrainReport;
let reap: typeof reapExpiredTasks;
let readState: typeof readQueueState;
let collectable: typeof listCollectableTasks;
let settleCollected: typeof settleCollectedTask;
let settleFailed: typeof settleFailedTask;
let coverage: typeof coverageFraction;

const NOW = new Date("2026-10-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0053_marvelous_sharon_carter.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
    ].join("\n"),
  );

  const drain = await import("@/server/features/geo/services/queueDrain");
  buildReport = drain.buildDrainReport;
  reap = drain.reapExpiredTasks;
  readState = drain.readQueueState;
  collectable = drain.listCollectableTasks;
  settleCollected = drain.settleCollectedTask;
  settleFailed = drain.settleFailedTask;
  coverage = drain.coverageFraction;
});

afterAll(async () => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM geo_pending_tasks");
  // The project is deleted too, not just the tasks: a re-insert on a row that
  // survived the previous test is a primary-key violation, and that error
  // arrives as a cascade of confusing failures rather than one clear one.
  await client.execute("DELETE FROM projects");
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
});

async function post(
  id: string,
  overrides: {
    tag?: string;
    postedAt?: string;
    status?: string;
    advanceUsd?: number | null;
    vendorTaskId?: string;
  } = {},
): Promise<void> {
  // Bound through a local so the type is `number | null` rather than
  // `number | null | undefined`; libsql's `InValue` has no `undefined`, and an
  // optional property read is exactly where that comes from. `in` plus `??`
  // keeps an *explicit* null (a task posted with no recorded advance) distinct
  // from an omitted one, which is the distinction the seeded rows depend on.
  const advanceUsd = overrides.advanceUsd ?? 0.01;

  await client.execute({
    sql: `INSERT INTO geo_pending_tasks
            (id, project_id, tag, vendor_task_id, se, model_name, prompt, status, advance_usd, posted_at)
          VALUES (?, 'p1', ?, ?, 'chat_gpt', 'gpt-5', 'best crm', ?, ?, ?)`,
    args: [
      id,
      overrides.tag ?? `tag-${id}`,
      overrides.vendorTaskId ?? `vendor-${id}`,
      overrides.status ?? "pending",
      advanceUsd,
      overrides.postedAt ?? NOW.toISOString(),
    ],
  });
}

/**
 * libsql returns `Record<string, SQLOutputValue>`, so reading a column means
 * narrowing it. `String(value)` would also narrow, and `no-base-to-string` is
 * right to object: a column that came back as an object would stringify to
 * `[object Object]` and the assertion would pass for the wrong reason.
 */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  throw new Error(
    `Expected a text column, got ${value === null ? "null" : typeof value}`,
  );
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(
    `Expected a numeric column, got ${value === null ? "null" : typeof value}`,
  );
}

describe("buildDrainReport", () => {
  it("says nothing outstanding means the queue is clear", () => {
    // Null rather than an empty string: an empty panel and a stated fact are
    // different, and "everything we asked for has arrived" is worth saying.
    const report = buildReport([], NOW);
    expect(report.coverage).toBeNull();
    expect(report.expired).toBe(0);
  });

  it("names the 72-hour ceiling when work is outstanding", () => {
    // The claim this product makes is "here is what AI says about you". A
    // figure drawn from a queue with tasks still in it is a *partial* answer,
    // and the report has to say so rather than let a timestamp imply otherwise.
    const report = buildReport(
      [
        {
          tag: "a",
          se: "chat_gpt",
          prompt: "best crm",
          postedAt: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
          advanceUsd: 0.01,
        },
      ],
      NOW,
    );
    expect(report.coverage).toMatch(/still queued/i);
    expect(report.coverage).toMatch(/72 hours/i);
    expect(report.coverage).toMatch(/not yet the full capture plan/i);
  });

  it("reports an expired task as a loss, not as progress", () => {
    // Past the ceiling the vendor has given up and refunded. Reporting it as
    // "still waiting" would keep a capture plan permanently incomplete with no
    // terminal state, and would hide work the customer paid for.
    const report = buildReport(
      [
        {
          tag: "a",
          se: "chat_gpt",
          prompt: "best crm",
          postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
          advanceUsd: 0.01,
        },
      ],
      NOW,
    );
    expect(report.expired).toBe(1);
    expect(report.coverage).toMatch(/will never arrive/i);
    expect(report.coverage).toMatch(/refunded/i);
  });

  it("separates the money at risk from the money refunded", () => {
    // Two different numbers for two different reasons, and a single "spend"
    // figure would hide which is which.
    const report = buildReport(
      [
        {
          tag: "waiting",
          se: "chat_gpt",
          prompt: "p",
          postedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
          advanceUsd: 0.01,
        },
        {
          tag: "gone",
          se: "chat_gpt",
          prompt: "p",
          postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
          advanceUsd: 0.01,
        },
      ],
      NOW,
    );
    expect(report.atRiskUsd).toBeCloseTo(0.01, 5);
    expect(report.refundedUsd).toBeCloseTo(0.01, 5);
  });

  it("treats an unreadable timestamp as unbounded, not as fresh", () => {
    // A row whose age can never be evaluated is not new. Calling it fresh keeps
    // a broken row invisible forever.
    const report = buildReport(
      [
        {
          tag: "broken",
          se: "chat_gpt",
          prompt: "p",
          postedAt: "not-a-date",
          advanceUsd: 0.01,
        },
      ],
      NOW,
    );
    expect(report.expired).toBe(1);
    expect(report.coverage).toMatch(
      /an unknown amount of time|72-hour ceiling/,
    );
  });

  it("uses the singular for one task and the plural for several", () => {
    // Small, but a report that says "1 task are still queued" is the kind of
    // detail that makes a reader distrust the rest of the sentence.
    const one = buildReport(
      [
        {
          tag: "a",
          se: "chat_gpt",
          prompt: "p",
          postedAt: NOW.toISOString(),
          advanceUsd: 0.01,
        },
      ],
      NOW,
    );
    expect(one.coverage).toMatch(/1 task is still queued/);
  });
});

describe("readQueueState", () => {
  it("reaps and reports in one call, so the rows and the report agree", async () => {
    // The reason these are one function: a caller that read the report and the
    // expiry count separately could render "0 outstanding" beside an unread
    // count, which reads as "merely waiting" when the truth is "this will never
    // arrive".
    await post("old", {
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });
    await post("waiting", {
      postedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    });

    const state = await readState("p1", NOW);

    expect(state.expired).toBe(1);
    expect(state.report.expired).toBe(0);
    // The reaped task is gone from the pending list, and the report says the
    // live queue is one task short of what was posted.
    expect(state.report.outstanding).toHaveLength(1);
    expect(state.report.coverage).toMatch(/still queued/i);
  });

  it("reaps nothing on a second read of the same tick", async () => {
    // The count is the delta this call expired, not a running total. Reporting a
    // total here would reset to zero on every read and make a run look clean
    // the second time it was checked.
    await post("old", {
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });

    expect((await readState("p1", NOW)).expired).toBe(1);
    expect((await readState("p1", NOW)).expired).toBe(0);
  });
});
describe("reapExpiredTasks", () => {
  it("expires only what is past the ceiling", async () => {
    await post("old", {
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });
    await post("fresh", {
      postedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    });

    const count = await reap(NOW);
    expect(count).toBe(1);

    const rows = await client.execute(
      "SELECT id, status FROM geo_pending_tasks ORDER BY id",
    );
    const byId = new Map(rows.rows.map((r) => [text(r.id), text(r.status)]));
    expect(byId.get("old")).toBe("expired");
    expect(byId.get("fresh")).toBe("pending");
  });

  it("records a zero settled cost on expiry, because the vendor refunded", async () => {
    // A refund is a *measurement*, not an absence. Leaving `settled_usd` null
    // would report an unpriced task when we know exactly what it cost.
    await post("old", {
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });
    await reap(NOW);

    const rows = await client.execute(
      "SELECT settled_usd, error_message FROM geo_pending_tasks WHERE id = 'old'",
    );
    expect(num(rows.rows[0]?.settled_usd)).toBe(0);
    expect(text(rows.rows[0]?.error_message)).toMatch(/72 hours/);
  });

  it("does not touch a task that is already collected", async () => {
    // A reaper that overwrote a settled row would lose the cost the collection
    // just recorded, on the same tick.
    await post("done", {
      status: "collected",
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });
    expect(await reap(NOW)).toBe(0);
  });
});

describe("settling", () => {
  it("marks a collected task once, and ignores the second delivery", async () => {
    // `tasks_ready` omits tasks whose postback succeeded, so postback and drain
    // are both live and both can see the same task. The second must not
    // overwrite the settled cost with a second reading of it.
    await post("t1");

    const first = await settleCollected({
      vendorTaskId: "vendor-t1",
      settledUsd: 0.004,
      completedAt: NOW.toISOString(),
    });
    const second = await settleCollected({
      vendorTaskId: "vendor-t1",
      settledUsd: 0.09,
      completedAt: NOW.toISOString(),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const rows = await client.execute(
      "SELECT settled_usd FROM geo_pending_tasks WHERE id = 't1'",
    );
    expect(num(rows.rows[0]?.settled_usd)).toBeCloseTo(0.004, 5);
  });

  it("records a vendor failure verbatim, with a zero cost", async () => {
    await post("t1");
    const ok = await settleFailed({
      vendorTaskId: "vendor-t1",
      reason: "Insufficient account balance.",
      completedAt: NOW.toISOString(),
    });
    expect(ok).toBe(true);

    const rows = await client.execute(
      "SELECT status, settled_usd, error_message FROM geo_pending_tasks WHERE id = 't1'",
    );
    expect(text(rows.rows[0]?.status)).toBe("failed");
    expect(num(rows.rows[0]?.settled_usd)).toBe(0);
    // The vendor's own words, not our paraphrase of them.
    expect(text(rows.rows[0]?.error_message)).toBe(
      "Insufficient account balance.",
    );
  });

  it("collects pending work oldest first, so a backlog drains in order", async () => {
    await post("new", { postedAt: NOW.toISOString() });
    await post("old", {
      postedAt: new Date(NOW.getTime() - 10 * HOUR).toISOString(),
    });

    const list = await collectable();
    expect(list[0]?.vendorTaskId).toBe("vendor-old");
  });
});

describe("coverageFraction", () => {
  it("is null for a project that has never posted", async () => {
    // 0/0 is not zero coverage, it is an absence of measurement — and a fraction
    // that renders as 0% would read as "we checked and found nothing".
    const result = await coverage("p1");
    expect(result.fraction).toBeNull();
    expect(result.total).toBe(0);
  });

  it("counts an expired task in the denominator", async () => {
    // The fraction whose denominator shrinks as tasks expire reads as
    // *improving* coverage while the archive gets worse.
    await post("ok");
    await post("gone", {
      postedAt: new Date(NOW.getTime() - 80 * HOUR).toISOString(),
    });
    await reap(NOW);
    await settleCollected({
      vendorTaskId: "vendor-ok",
      settledUsd: 0.004,
      completedAt: NOW.toISOString(),
    });

    const result = await coverage("p1");
    expect(result.collected).toBe(1);
    expect(result.total).toBe(2);
    expect(result.fraction).toBeCloseTo(0.5, 5);
  });
});
