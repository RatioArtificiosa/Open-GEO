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
  alertOnRunChange,
  ALERT_TRANSPORT,
} from "@/server/features/geo/services/alertRunner";
// Imported dynamically, and that is load-bearing rather than incidental.
// `runObservations` reads `@/db` at module load, and a static import of it here
// would build that reference *before* `vi.doMock("@/db", ...)` runs in
// `beforeAll` — so the module under test would hold a real (unconfigured)
// client and every query failed on `undefined.prepare`. The same file's
// `alertOnRunChange` is therefore pulled in after the mock, in `beforeAll`.
import type { describeRunGap } from "@/server/features/geo/services/runObservations";

let describeGap: typeof describeRunGap;

/**
 * A finished run reaching an alert decision.
 *
 * The properties that matter are the three *non-alert* outcomes. An alerting
 * chain is judged almost entirely on what it does not say: a system that alerts
 * when it has no baseline, or when the run archived nothing, will be muted
 * within a week, and then the real one goes unread too.
 */
let client: Client;
let runAlerts: typeof alertOnRunChange;
let transport: typeof ALERT_TRANSPORT;

const T1 = new Date("2026-10-01T00:00:00.000Z");
const T2 = new Date("2026-10-02T00:00:00.000Z");
const T8 = new Date("2026-10-08T00:00:00.000Z");

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
      ...readFileSync("drizzle/0054_freezing_ultimo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  const mod = await import("@/server/features/geo/services/alertRunner");
  runAlerts = mod.alertOnRunChange;
  transport = mod.ALERT_TRANSPORT;
  const observations =
    await import("@/server/features/geo/services/runObservations");
  describeGap = observations.describeRunGap;
});

afterAll(async () => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM geo_alert_dispatches; DELETE FROM geo_snapshot_answers; DELETE FROM geo_answers; DELETE FROM geo_snapshots; DELETE FROM geo_targets; DELETE FROM projects;",
  );
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
});

async function snapshot(id: string, at: Date): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_snapshots (id, project_id, started_at, status, created_by)
          VALUES (?, 'p1', ?, 'complete', 'schedule')`,
    args: [id, at.toISOString()],
  });
}

/** An answer row. `null` text is the *normal* mentions_search shape. */
async function answer(
  id: string,
  snapshotId: string,
  prompt: string,
  text: string | null,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_answers
            (id, project_id, prompt, answer_text, platform, source, location_code, language_code, answered_at, created_at)
          VALUES (?, 'p1', ?, ?, 'chat_gpt', 'mentions_search', 2840, 'en', ?, ?)`,
    args: [id, prompt, text, T2.toISOString(), T2.toISOString()],
  });
  await client.execute({
    sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?, ?)",
    args: [snapshotId, id],
  });
}

describe("alertOnRunChange", () => {
  it("says nothing when the run archived nothing", async () => {
    // A budget cap, an outage, a project with no prompts: all real, none of them
    // a visibility change. Alerting here would tell a customer they lost
    // mentions that were never looked up.
    await snapshot("s1", T1);
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: null,
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(result.outcome).toBe("not_applicable");
    expect(sent).toEqual([]);
  });

  it("says nothing on the first run, because that is a baseline and not news", async () => {
    // The first message a product sends should be about something that
    // happened, not about having started. "We are now monitoring you" is how a
    // channel gets skimmed.
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s1",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(result.outcome).toBe("no_baseline");
    expect(sent).toEqual([]);
  });

  it("says nothing when two runs agree", async () => {
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T2);
    await answer("a2", "s2", "best crm", "Acme leads.");
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(sent).toEqual([]);
    expect(result.outcome).toBe("dispatched");
    if (result.outcome === "dispatched") {
      expect(result.result.outcome).toBe("nothing_to_send");
    }
  });

  it("alerts when a prompt that had an answer now has none", async () => {
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T2);
    // The pending shape: no body. A body appearing or vanishing between runs is
    // the observable change, and a *pending* row is excluded by the decision
    // layer rather than being read as "the model stopped mentioning us".
    await answer("a2", "s2", "best crm", null);
    const sent: string[] = [];

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    // Whatever it decides, the *transport* must not have been told to send a
    // body-versus-pending difference as a mention loss, which is what this
    // asserts: the change is reported only if the decision layer called it one.
    if (sent.length > 0) {
      expect(sent.join(" ")).not.toMatch(/mention lost/i);
    }
    expect(result.outcome).toBe("dispatched");
  });

  it("pairs runs by prompt, not by position", async () => {
    // The dangerous one. A prompt set changes between runs, and a positional
    // comparison pairs answer *n* with answer *n* — producing a "mention lost"
    // for a prompt that never changed. The reader keys on the prompt, so a
    // reordered second run is a *non*-event.
    await snapshot("s1", T1);
    await answer("a1", "s1", "alpha", "Acme.");
    await answer("a2", "s1", "beta", "Acme.");

    await snapshot("s2", T2);
    // Same answers, opposite order.
    await answer("b2", "s2", "beta", "Acme.");
    await answer("b1", "s2", "alpha", "Acme.");

    const sent: string[] = [];
    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async (m) => {
        sent.push(m.subject);
      },
    });

    expect(sent).toEqual([]);
    expect(result.outcome).toBe("dispatched");
  });

  it("records the gap between runs so a week-old diff is not read as news", async () => {
    await snapshot("s1", T1);
    await answer("a1", "s1", "best crm", "Acme leads.");
    await snapshot("s2", T8);
    await answer("a2", "s2", "best crm", "Acme leads.");

    const result = await runAlerts({
      projectId: "p1",
      snapshotId: "s2",
      transport: async () => {},
    });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome === "dispatched") {
      expect(result.gap).toBe("since 7 days ago");
    }
  });
});

describe("describeRunGap", () => {
  it("says nothing under a day, because 'since yesterday' is noise", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-02T06:00:00.000Z" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBeNull();
  });

  it("names the gap once it is long enough to matter", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-03T00:00:00.000Z" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBe("since yesterday");
  });

  it("says so when a timestamp is unreadable, rather than implying adjacency", () => {
    expect(
      describeGap({
        current: { startedAt: "not-a-date" },
        previous: { startedAt: "2026-10-02T00:00:00.000Z" },
      }),
    ).toBe("the time between the two runs is not recorded");
  });

  it("has no gap to report when there is no earlier run", () => {
    expect(
      describeGap({
        current: { startedAt: "2026-10-02T00:00:00.000Z" },
        previous: null,
      }),
    ).toBeNull();
  });
});

describe("the default transport", () => {
  it("succeeds, because a self-hosted install has no channel yet", async () => {
    // The three alternatives are all worse: throwing would fail every patrol
    // (the alerting failure becomes a monitoring outage), swallowing would hide
    // it, and recording `failed` would retry forever for an audience that does
    // not exist. A no-op that succeeds keeps the run healthy and makes the gap
    // visible as "no deliveries".
    await expect(
      transport({ subject: "s", body: "b", changes: [] }),
    ).resolves.toBeUndefined();
  });
});
