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
  getEvidenceForSnapshot,
  getSpendReconciliation,
  listEvidencedSnapshots,
} from "@/server/features/geo/services/evidenceDrawer";

/**
 * The Evidence Drawer.
 *
 * Runs against a **real in-memory SQLite** built from the real migrations, for
 * the reason CL-150c established: a mocked database cannot tell you that a join
 * is wrong, and this module's central claim is that a number can be traced to
 * the call that produced it. That claim is about *rows actually relating to each
 * other*.
 *
 * The property under test throughout is that **an honest answer is preferred to
 * a complete-looking one.** Every case below is a situation where the easy
 * rendering is a clean list, and the correct rendering names what is missing.
 */
let client: Client;

let getEvidence: typeof getEvidenceForSnapshot;
let reconcile: typeof getSpendReconciliation;
let listEvidenced: typeof listEvidencedSnapshots;

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
      ...readFileSync("drizzle/0051_ordinary_sprite.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  const drawer = await import("@/server/features/geo/services/evidenceDrawer");
  getEvidence = drawer.getEvidenceForSnapshot;
  reconcile = drawer.getSpendReconciliation;
  listEvidenced = drawer.listEvidencedSnapshots;
});

afterAll(async () => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM geo_vendor_tasks; DELETE FROM geo_snapshot_answers; DELETE FROM geo_answers; DELETE FROM geo_snapshots; DELETE FROM geo_targets; DELETE FROM projects;",
  );
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
});

async function seedSnapshot(id: string): Promise<void> {
  // `geo_snapshots` has no `captured_at` and no `created_at`: its clock is
  // `started_at`, and `created_by` is NOT NULL. The drawer reads this table for
  // existence only, so guessing column names here is how a "snapshot not found"
  // test would pass for the wrong reason.
  await client.execute({
    sql: `INSERT INTO geo_snapshots (id, project_id, started_at, status, created_by)
          VALUES (?, 'p1', '2026-09-29T00:00:00.000Z', 'complete', 'schedule')`,
    args: [id],
  });
}

async function seedAnswer(
  id: string,
  snapshotId: string,
  overrides: Record<string, string | null> = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_answers
            (id, project_id, prompt, answer_text, platform, source, location_code, language_code, answered_at, created_at)
          VALUES (?, 'p1', ?, ?, 'chat_gpt', 'mentions_search', 2840, 'en', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z')`,
    args: [id, overrides.prompt ?? "best acme", overrides.answerText ?? null],
  });
  await client.execute({
    sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?, ?)",
    args: [snapshotId, id],
  });
}

async function seedCall(
  id: string,
  snapshotId: string | null,
  overrides: Record<string, string | number | null> = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_vendor_tasks
            (id, project_id, snapshot_id, path, request_body, response_body, status_code, cost_usd, charged_usd, started_at, completed_at)
          VALUES (?, 'p1', ?, 'v3/ai_optimization/llm_mentions/search/live', ?, ?, ?, ?, ?, '2026-09-29T00:00:00.000Z', ?)`,
    args: [
      id,
      snapshotId,
      // `"key" in overrides`, not `??`: the tests that matter here pass an
      // **explicit null** to simulate a call recorded with no request body or no
      // cost. `overrides.x ?? default` treats null as absent and substitutes the
      // default, so three of these tests were silently seeding a *complete* call
      // and asserting a gap that could never appear. The failures looked like
      // gaps in the drawer; they were gaps in the fixture.
      "requestBody" in overrides ? overrides.requestBody : '{"targets":[]}',
      "responseBody" in overrides ? overrides.responseBody : '{"tasks":[]}',
      "statusCode" in overrides ? overrides.statusCode : 20000,
      "costUsd" in overrides ? overrides.costUsd : 0.02,
      "chargedUsd" in overrides ? overrides.chargedUsd : 0.04,
      "completedAt" in overrides
        ? overrides.completedAt
        : "2026-09-29T00:00:01.000Z",
    ],
  });
}

describe("evidence drawer", () => {
  it("returns the answers and the calls behind one snapshot", async () => {
    // The whole contract in one case: given a number, name the prompt, the
    // answer, the source and the cost that produced it.
    await seedSnapshot("s1");
    await seedAnswer("a1", "s1", { prompt: "best acme tools" });
    await seedCall("c1", "s1");

    const drawer = await getEvidence("s1");

    expect(drawer.answers).toHaveLength(1);
    expect(drawer.answers[0]?.prompt).toBe("best acme tools");
    expect(drawer.calls).toHaveLength(1);
    expect(drawer.calls[0]?.costUsd).toBeCloseTo(0.02, 5);
    expect(drawer.gaps).toEqual([]);
  });

  it("links answers to a snapshot through the join table, not a column", async () => {
    // `geo_answers` has no `snapshot_id`. An answer belonging to a *different*
    // snapshot must not leak into this one, which is what a plausible-looking
    // shortcut on the relation would do.
    await seedSnapshot("s1");
    await seedSnapshot("s2");
    await seedAnswer("a1", "s1", { prompt: "ours" });
    await seedAnswer("a2", "s2", { prompt: "theirs" });
    await seedCall("c1", "s1");

    const drawer = await getEvidence("s1");

    expect(drawer.answers.map((a) => a.prompt)).toEqual(["ours"]);
  });

  it("reports no evidence at all, in words, when the call was never recorded", async () => {
    // The case the whole table exists for: derived rows with no trace of what
    // was asked. Rendering an empty list would read as "nothing to see here"
    // rather than "we cannot show our work".
    await seedSnapshot("s1");
    await seedAnswer("a1", "s1");

    const drawer = await getEvidence("s1");

    expect(drawer.calls).toEqual([]);
    expect(drawer.gaps).toHaveLength(1);
    expect(drawer.gaps[0]?.kind).toBe("no_evidence");
    expect(drawer.gaps[0]?.detail).toMatch(
      /derived from a response we cannot show/i,
    );
  });

  it("says so when the snapshot itself is not in the archive", async () => {
    // A bad link and a missing record are different sentences. Conflating them
    // makes a broken route look like an empty result.
    const drawer = await getEvidence("does-not-exist");

    expect(drawer.answers).toEqual([]);
    expect(drawer.calls).toEqual([]);
    expect(drawer.gaps[0]?.kind).toBe("no_evidence");
    expect(drawer.gaps[0]?.detail).toMatch(/not in the archive/i);
  });

  it("flags a truncated response rather than letting it read as complete", async () => {
    // The recorder marks truncation explicitly. If the drawer did not surface
    // that, a half-body would support a re-derivation that looks correct and is
    // not — the exact failure the marker was added to prevent.
    await seedSnapshot("s1");
    await seedCall("c1", "s1", {
      responseBody: `{"tasks":[],"note":"x"}…[truncated at 17 of 900000 chars]`,
    });

    const drawer = await getEvidence("s1");

    expect(drawer.gaps.map((g) => g.kind)).toContain("truncated_response");
  });

  it("does not call a complete response truncated", async () => {
    await seedSnapshot("s1");
    await seedCall("c1", "s1", {
      responseBody: '{"tasks":[{"id":"x"}]}',
    });

    const drawer = await getEvidence("s1");

    expect(drawer.gaps).toEqual([]);
  });

  it("flags a call that was recorded but never completed", async () => {
    // Its cost is provisional, so a total including it is a claim about money
    // that has not settled.
    await seedSnapshot("s1");
    await seedCall("c1", "s1", { completedAt: null });

    const drawer = await getEvidence("s1");

    expect(drawer.gaps.map((g) => g.kind)).toContain("never_completed");
  });

  it("flags a call with no request body, because it cannot be re-sent", async () => {
    await seedSnapshot("s1");
    await seedCall("c1", "s1", { requestBody: null });

    const drawer = await getEvidence("s1");

    expect(drawer.gaps.map((g) => g.kind)).toContain("missing_request");
  });

  it("does not flag a missing answer body for a mentions_search row", async () => {
    // The one trap worth guarding hard. `llm_mentions/search` returns a mention
    // *count* and never the answer text, so `answer_text` is null on every
    // healthy row. Flagging it would put a "gap" on every snapshot and teach the
    // reader to skim past the list — which is how a real gap gets missed.
    await seedSnapshot("s1");
    await seedAnswer("a1", "s1", { answerText: null });
    await seedCall("c1", "s1");

    const drawer = await getEvidence("s1");

    expect(drawer.answers[0]?.answerText).toBeNull();
    expect(drawer.gaps).toEqual([]);
  });

  it("does not lose the mention count by treating the row as empty", async () => {
    // The archive row itself must still be returned; "we have no text" and "we
    // have no data" are different, and only the first is true here.
    await seedSnapshot("s1");
    await seedAnswer("a1", "s1", { answerText: null });
    await seedCall("c1", "s1");

    const drawer = await getEvidence("s1");

    expect(drawer.answers).toHaveLength(1);
  });
});

describe("spend reconciliation", () => {
  it("reports vendor and charged separately, and the difference", async () => {
    // One number rendered as "cost" would hide which of three legible causes
    // applies, and "why does the bill disagree with the receipt" is exactly the
    // question a customer asks.
    await seedSnapshot("s1");
    await seedCall("c1", "s1", { costUsd: 0.02, chargedUsd: 0.04 });

    const result = await reconcile("s1");

    expect(result.vendorUsd).toBeCloseTo(0.02, 5);
    expect(result.chargedUsd).toBeCloseTo(0.04, 5);
    expect(result.differenceUsd).toBeCloseTo(0.02, 5);
    expect(result.note).toMatch(/not being absorbed/i);
  });

  it("says nothing when the two agree", async () => {
    await seedSnapshot("s1");
    await seedCall("c1", "s1", { costUsd: 0.02, chargedUsd: 0.02 });

    const result = await reconcile("s1");

    expect(result.differenceUsd).toBe(0);
    expect(result.note).toBeNull();
  });

  it("calls a total with an unpriced call a lower bound, not a figure", async () => {
    // The vendor cost is nullable and the recorder is best-effort, so a sum can
    // be quietly incomplete. A total presented as final would be wrong in the
    // direction that hides our own gap.
    await seedSnapshot("s1");
    await seedCall("c1", "s1", { costUsd: 0.02, chargedUsd: 0.04 });
    await seedCall("c2", "s1", { costUsd: null, chargedUsd: null });

    const result = await reconcile("s1");

    expect(result.unpricedCalls).toBe(2);
    expect(result.note).toMatch(/lower bound/i);
  });

  it("sums in integer micro-dollars so the total is reproducible", async () => {
    // Summing floats accumulates the error that makes an argument about a bill
    // unfalsifiable. Three hundred 0.01 calls is where naive summation shows it.
    await seedSnapshot("s1");
    for (let i = 0; i < 300; i++) {
      await seedCall(`c${i}`, "s1", { costUsd: 0.01, chargedUsd: 0.01 });
    }

    const result = await reconcile("s1");

    expect(result.vendorUsd).toBeCloseTo(3, 6);
    expect(result.vendorUsd).toBe(3);
  });
});

describe("listEvidencedSnapshots", () => {
  it("returns only snapshots that actually have a recorded call", async () => {
    // This list is the entry point to the drawer, so a row with no evidence in
    // it is a link that opens onto "we cannot show our work" — technically
    // true, practically a dead end the reader cannot use.
    await seedSnapshot("s1");
    await seedSnapshot("s2");
    await seedCall("c1", "s1");

    const listed = await listEvidenced("p1");

    expect(listed.map((s) => s.snapshotId)).toEqual(["s1"]);
    expect(listed[0]?.calls).toBe(1);
  });

  it("never returns a snapshot id that is null or empty", async () => {
    // A call recorded with no snapshot is a real row (it happened), but it has
    // no drawer to open, so it must not appear with a blank id.
    await seedSnapshot("s1");
    await seedCall("c1", "s1");
    await seedCall("orphan", null);

    const listed = await listEvidenced("p1");

    for (const row of listed) {
      expect(row.snapshotId.length).toBeGreaterThan(0);
    }
    expect(listed.map((s) => s.snapshotId)).not.toContain("");
  });
});
