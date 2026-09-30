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
  countDeliveredAlerts,
  dispatchAlert,
  Transport,
} from "@/server/features/geo/services/alertDispatch";
import {
  buildDigest,
  buildMessage,
  fingerprint,
} from "@/server/features/geo/services/alertMessage";
import {
  decideAlerts,
  type Observation,
} from "@/server/features/geo/services/alertDecision";

/**
 * Dispatching an alert, once.
 *
 * The tests are about the *failure modes of sending*, because that is where
 * this code can hurt someone: an alert that is never delivered, and an alert
 * delivered twice. Both are silent, and both are worse than a channel that is
 * merely quiet.
 */
let client: Client;
let dispatch: typeof dispatchAlert;
let countDelivered: typeof countDeliveredAlerts;

/**
 * A transport that records what it was given and does nothing else.
 *
 * Module-level because it captures nothing, and written once because the same
 * three-line arrow appeared in four tests ”” a helper that has to be re-typed per
 * call site is a helper that will be subtly different at one of them.
 */
/**
 * A transport that always refuses, for the retry tests. `message` is named so
 * the failure is attributable if one of these ever starts passing for the wrong
 * reason.
 */
const refusingTransport: Transport = async (_message) => {
  throw new Error("channel unavailable");
};

/**
 * One with a *specific* message, because the test that uses it asserts the
 * message survives into the log verbatim — which is the property. A shared
 * "always refuses" helper would make that assertion meaningless, since any
 * error text would satisfy it.
 */
const rateLimitedTransport: Transport = async (_message) => {
  throw new Error("discord rate limited");
};
function recordingTransport(sent: string[]): Transport {
  return async (message) => {
    sent.push(message.subject);
  };
}
const NOW = new Date("2026-10-01T12:00:00.000Z");

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    platform: "chat_gpt",
    prompt: "best crm",
    domain: "acme.com",
    mentioned: true,
    sentiment: "positive",
    citations: [],
    ...overrides,
  };
}

/** A decision with a lost mention, which is the case worth sending. */
function lostMention() {
  return decideAlerts({
    previous: [obs()],
    current: [obs({ mentioned: false })],
  });
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      // Only the alert-dispatch migration, because that is the only table this
      // suite exercises. It deliberately does **not** build `geo_snapshots`, so
      // applying 0055 here would `ALTER TABLE` a table that does not exist and
      // the suite would fail for a reason that has nothing to do with dispatching
      // an alert — which is exactly the shape of failure this project keeps
      // having to unpick.
      //
      // The gate in `scripts/migration-coverage.test.ts` is why that is a
      // decision and not an oversight: a harness that writes a table must apply
      // the migrations altering it, and this one writes none of them.
      ...readFileSync("drizzle/0054_freezing_ultimo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  const mod = await import("@/server/features/geo/services/alertDispatch");
  dispatch = mod.dispatchAlert;
  countDelivered = mod.countDeliveredAlerts;
});

afterAll(async () => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM geo_alert_dispatches");
  await client.execute("DELETE FROM projects");
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
});

describe("buildMessage", () => {
  it("sends nothing when there is nothing to say", () => {
    // Null rather than an empty post: an empty message is *visible*, and a
    // visible empty message teaches the reader that the channel sometimes has
    // nothing in it — which is a thing they must then check.
    const message = buildMessage({
      decision: decideAlerts({ previous: null, current: [obs()] }),
      projectName: "Acme",
    });
    expect(message).toBeNull();
  });

  it("carries the no-causation caveat in the body", () => {
    // Models change for reasons we cannot observe. An alert that reads as a
    // verdict is a causal claim we cannot support, and it is the one that loses
    // a customer's trust fastest.
    const message = buildMessage({
      decision: lostMention(),
      projectName: "Acme",
    });
    expect(message?.body).toMatch(/does not show why/i);
  });

  it("names the worst thing in the subject, because it is all a phone shows", () => {
    const message = buildMessage({
      decision: lostMention(),
      projectName: "Acme",
    });
    expect(message?.subject).toBe("1 mention lost");
    // And not a count, which would make the reader open it to find out whether
    // they care.
    expect(message?.subject).not.toMatch(/change/);
  });

  it("lists every kind in the subject when a run has several", () => {
    const message = buildMessage({
      decision: {
        shouldAlert: true,
        alerts: [
          {
            kind: "mention_lost" as const,
            domain: "acme.com",
            platform: "chat_gpt",
            prompt: "best crm",
          },
          {
            kind: "citation_lost" as const,
            url: "https://acme.com/pricing",
            platform: "chat_gpt",
            prompt: "best crm",
          },
        ],
        suppressed: [],
      },
      projectName: "Acme",
    });
    expect(message?.subject).toMatch(/mention lost/);
    expect(message?.subject).toMatch(/citation lost/);
  });
});

describe("fingerprint", () => {
  it("is identical for a retried dispatch of the same decision", () => {
    // The whole idempotency mechanism. A fingerprint that moved between attempts
    // would defeat it, so a timestamp must not appear in it.
    const a = fingerprint({
      runId: "r1",
      projectId: "p1",
      decision: lostMention(),
    });
    const b = fingerprint({
      runId: "r1",
      projectId: "p1",
      decision: lostMention(),
    });
    expect(a).toBe(b);
  });

  it("differs when the content differs, even in the same run", () => {
    // A run can legitimately produce two different decisions — the drain
    // collects twice and finds something new. Keying on the run alone would
    // suppress the second as a duplicate of the first.
    const first = fingerprint({
      runId: "r1",
      projectId: "p1",
      decision: lostMention(),
    });
    const second = fingerprint({
      runId: "r1",
      projectId: "p1",
      decision: {
        shouldAlert: true,
        alerts: [
          {
            kind: "citation_lost" as const,
            url: "https://acme.com/pricing",
            platform: "chat_gpt",
            prompt: "best crm",
          },
        ],
        suppressed: [],
      },
    });
    expect(first).not.toBe(second);
  });

  it("differs across projects, so two customers never collide", () => {
    const a = fingerprint({
      runId: "r1",
      projectId: "p1",
      decision: lostMention(),
    });
    const b = fingerprint({
      runId: "r1",
      projectId: "p2",
      decision: lostMention(),
    });
    expect(a).not.toBe(b);
  });
});

describe("dispatchAlert", () => {
  it("sends once, and records it", async () => {
    const sent: string[] = [];
    const result = await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport: recordingTransport(sent),
      now: NOW,
    });

    expect(result.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(result.recorded).toBe(true);
    expect(await countDelivered("p1", "r1")).toBe(1);
  });

  it("refuses to send the same alert twice", async () => {
    // The duplicate is *detected* rather than merely possible, which is the
    // at-least-once bargain: embarrassing, but not a silently lost regression.
    const sent: string[] = [];
    const transport = recordingTransport(sent);

    await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport,
      now: NOW,
    });
    const second = await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport,
      now: NOW,
    });

    expect(sent).toHaveLength(1);
    expect(second.outcome).toBe("duplicate");
    expect(second.detail).toMatch(/already delivered/i);
  });

  it("sends a genuinely new alert from the same run", async () => {
    // A run can be dispatched twice with different findings, and the second is
    // not a duplicate.
    const sent: string[] = [];
    const transport = recordingTransport(sent);
    await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport,
      now: NOW,
    });
    await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: {
        shouldAlert: true,
        alerts: [
          {
            kind: "citation_lost" as const,
            url: "https://acme.com/pricing",
            platform: "chat_gpt",
            prompt: "best crm",
          },
        ],
        suppressed: [],
      },
      transport,
      now: NOW,
    });

    expect(sent).toHaveLength(2);
  });

  it("retries after a failed send rather than suppressing the regression", async () => {
    // **The important one.** A row written as `sent` for a message nobody
    // received means the next tick's duplicate check suppresses a regression that
    // was never delivered — a transient webhook outage becomes a permanently
    // lost alert. Worse than no record at all, because it is believed.
    let attempts = 0;
    const transport: Transport = async (_message) => {
      attempts += 1;
      if (attempts === 1) throw new Error("webhook 503");
    };

    const first = await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport,
      now: NOW,
    });
    expect(first.outcome).toBe("failed");
    expect(await countDelivered("p1", "r1")).toBe(0);

    const second = await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport,
      now: NOW,
    });
    expect(second.outcome).toBe("sent");
    expect(attempts).toBe(2);
  });

  it("keeps the transport's own error rather than paraphrasing it", async () => {
    await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: lostMention(),
      transport: rateLimitedTransport,
      now: NOW,
    });

    const rows = await client.execute(
      "SELECT detail FROM geo_alert_dispatches WHERE status = 'failed'",
    );
    // Narrowed, not `String()`-ed: a column that came back as an object would
    // stringify to "[object Object]" and this assertion would pass for the wrong
    // reason, which is precisely the failure the test exists to prevent.
    const detail: unknown = rows.rows[0]?.detail;
    expect(typeof detail).toBe("string");
    expect(detail).toContain("discord rate limited");
  });

  it("writes no row at all when there is nothing to send", async () => {
    // A table row per quiet run is a table nobody reads and a cost nobody
    // notices.
    const result = await dispatch({
      projectId: "p1",
      runId: "r1",
      projectName: "Acme",
      decision: decideAlerts({ previous: null, current: [obs()] }),
      transport: refusingTransport,
      now: NOW,
    });

    expect(result.outcome).toBe("nothing_to_send");
    const rows = await client.execute(
      "SELECT COUNT(*) AS n FROM geo_alert_dispatches",
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });
});

describe("buildDigest", () => {
  it("sends nothing when nothing was suppressed", () => {
    expect(
      buildDigest({
        suppressed: [],
        weekOf: "2026-10-01",
        projectName: "Acme",
      }),
    ).toBeNull();
  });

  it("carries the gains, which are the only thing worth a roll-up", () => {
    const decision = decideAlerts({
      previous: [obs({ mentioned: false })],
      current: [obs({ mentioned: true })],
    });
    const digest = buildDigest({
      suppressed: decision.suppressed,
      weekOf: "2026-10-01",
      projectName: "Acme",
    });
    expect(digest?.subject).toMatch(/1 good change/);
    expect(digest?.body).toMatch(/gained mention/);
  });

  it("says why gains are not alerts, so the digest is not a downgrade", () => {
    const decision = decideAlerts({
      previous: [obs({ mentioned: false })],
      current: [obs({ mentioned: true })],
    });
    const digest = buildDigest({
      suppressed: decision.suppressed,
      weekOf: "2026-10-01",
      projectName: "Acme",
    });
    expect(digest?.body).toMatch(/not worth interrupting/i);
  });
});
