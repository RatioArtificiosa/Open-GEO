// A project with a large backlog must not starve another project's task.
//
// The harm is not slowness. `reapExpiredTasks` marks anything past the vendor's
// 72-hour ceiling as `expired` and records a **zero** cost, because the vendor
// refunds the advance — so a task that was paid for, answered by the vendor, and
// then never collected becomes a silent zero. The small project's answer is
// destroyed by the large project's backlog, with nothing in any log.
import {
  describe,
  expect,
  it,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";

import type { listCollectableTasks as ListCollectableTasks } from "./queueDrain";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let listCollectableTasks: typeof ListCollectableTasks;

const NOW = new Date("2026-10-01T00:00:00.000Z");

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: unknown) => unknown[]) => {
      for (const s of build(testDb)) await s;
    },
  }));

  await client.executeMultiple(
    [
      // `projects` is created by `0048` and `0057` adds `geo_acquisition_mode` to
      // it, so the stub above declares only the bare minimum and the migration
      // supplies the column. Declaring it in both fails with
      // `duplicate column name`, which is the harness disagreeing with itself.
      `CREATE TABLE projects (id text PRIMARY KEY, name text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0053_marvelous_sharon_carter.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0054_freezing_ultimo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
    ].join("\n"),
  );

  const mod = await import("./queueDrain");
  listCollectableTasks = mod.listCollectableTasks;
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
    "projects",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
  await client.execute(
    "INSERT INTO projects (id, name) VALUES ('big', 'Big'), ('small', 'Small')",
  );
});

/** One pending task, `daysAgo` days old. */
async function addTask(
  projectId: string,
  index: number,
  daysAgo: number,
  id?: string,
) {
  await client.execute({
    sql: `INSERT INTO geo_pending_tasks
            (id, project_id, tag, vendor_task_id, se, model_name, prompt, status, posted_at)
          VALUES (?,?,?,?, 'chat_gpt', 'gpt', ?, 'pending', ?)`,
    args: [
      id ?? `${projectId}-${index}`,
      projectId,
      `${projectId}-t${index}`,
      `${projectId}-v${index}`,
      `prompt ${index}`,
      new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    ],
  });
}

describe("the drain's collection order", () => {
  it("collects a small project's task even when a large one fills the cap", async () => {
    // The defect. A hundred old tasks for `big` and one for `small`, and the
    // oldest-first global limit returns only `big`'s — so `small`'s answer is
    // never fetched, and once past 72 hours the reaper expires it as a silent
    // zero cost.
    for (let i = 0; i < 100; i += 1) await addTask("big", i, 1);
    await addTask("small", 0, 1);

    const tasks = await listCollectableTasks(100);
    const projects = new Set(tasks.map((t) => t.projectId));
    expect(projects.has("small")).toBe(true);
  });

  it("gives every project with pending work a share of the cap", async () => {
    // Ten projects, a hundred tasks spread unevenly. Each must appear.
    for (let p = 0; p < 10; p += 1) {
      await client.execute("INSERT INTO projects (id, name) VALUES (?,?)", [
        `p${p}`,
        `P${p}`,
      ]);
    }
    for (let p = 0; p < 10; p += 1) {
      const n = p === 0 ? 95 : 1;
      for (let i = 0; i < n; i += 1) await addTask(`p${p}`, i, 1);
    }

    const tasks = await listCollectableTasks(100);
    const seen = new Set(tasks.map((t) => t.projectId));
    for (let p = 0; p < 10; p += 1) {
      expect([...seen]).toContain(`p${p}`);
    }
  });

  it("still returns the oldest tasks within a project", async () => {
    // Fairness must not become arbitrariness: inside a project, oldest first.
    for (let i = 0; i < 5; i += 1) await addTask("big", i, 5 - i);
    await addTask("small", 0, 1);

    const tasks = await listCollectableTasks(100);
    const big = tasks.filter((t) => t.projectId === "big");
    const days = big.map((t) =>
      Math.round(
        (NOW.getTime() - new Date(t.postedAt).getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    );
    // **Descending age, asserted directly rather than by sorting a copy.** The
    // rules make the obvious form unusable in this project: `no-array-sort`
    // rejects `[...days].sort(...)` and `toSorted` is not in the lib target, so
    // the pair together leaves "check the order" with no idiomatic spelling. The
    // direct form is also the better assertion — it states the property rather
    // than restating the input, so a comparator bug in the *source* cannot make
    // both sides agree.
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i - 1]).toBeGreaterThanOrEqual(days[i]);
    }
  });

  it("fills the cap for a project that is the only one with work", async () => {
    // **The throughput half of the bug, and the one the fairness tests missed.**
    // The round-based version alloted each project at most `perProject` rows *in
    // total*, so a lone backlog of 300 drained at a tenth of the rate the old
    // global limit allowed — pushing its tasks toward the 72-hour reaper, which is
    // precisely the harm the fairness change existed to prevent. A fairness rule
    // must not slow the common case down to help the rare one.
    for (let i = 0; i < 300; i += 1) await addTask("big", i, 1);

    const tasks = await listCollectableTasks(100);
    expect(tasks).toHaveLength(100);
    expect(new Set(tasks.map((t) => t.projectId))).toEqual(new Set(["big"]));
  });

  it("reaches a project whose id sorts after one with a very large backlog", async () => {
    // The starvation half, with a backlog large enough that any fixed window would
    // be filled by the first project alone. `aaa` has 500 rows and `zzz` has one; a
    // query ordered by `project_id` with any window under 500 never returns `zzz`.
    //
    // Both projects are created here rather than in `beforeEach`, because
    // `geo_pending_tasks.project_id` is a foreign key: inserting a task for a
    // project that does not exist fails with `SQLITE_CONSTRAINT_FOREIGNKEY`, which
    // reads as a schema problem rather than a missing fixture row.
    for (const id of ["aaa", "zzz"]) {
      await client.execute("INSERT INTO projects (id, name) VALUES (?,?)", [
        id,
        id,
      ]);
    }
    await addTask("zzz", 0, 1);
    for (let i = 0; i < 500; i += 1) await addTask("aaa", i, 1);

    const tasks = await listCollectableTasks(100);
    const seen = new Set(tasks.map((t) => t.projectId));
    expect(seen.has("zzz")).toBe(true);
    expect(seen.has("aaa")).toBe(true);
    // Both projects are present, and **the cap is filled rather than dominated by
    // one of them**: `aaa` has 500 pending tasks and gets roughly half the cap,
    // not all of it. Asserting the share rather than a row index is the claim —
    // the query orders by `round, posted_at`, so which row leads inside the first
    // round is a detail of the sort, not the guarantee.
    const byProject = new Map<string, number>();
    for (const t of tasks) {
      byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + 1);
    }
    expect(byProject.get("zzz")).toBe(1);
    // Round-robin means roughly equal, so `aaa` is near the cap minus `zzz`'s one,
    // not 100 of its own.
    expect(byProject.get("aaa")).toBe(99);
  });

  it("still honours the cap, because fairness is not licence to bill more", async () => {
    // The cap is a **budget**, not a hint: every row here is one billed
    // `task_get`. Fairness cannot quietly raise what a customer pays, so the
    // bound has to hold — and it has to hold *without* the slice that caused the
    // original bug, which is why this is a test and not a comment.
    for (let i = 0; i < 60; i += 1) await addTask("big", i, 1);
    for (let i = 0; i < 60; i += 1) await addTask("small", i, 1);

    const tasks = await listCollectableTasks(20);
    expect(tasks.length).toBeLessThanOrEqual(20);
    // And both projects are still represented inside that budget.
    const seen = new Set(tasks.map((t) => t.projectId));
    expect(seen.size).toBe(2);
  });
});
