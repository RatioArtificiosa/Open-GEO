import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { vi } from "vitest";

/**
 * A real in-memory SQLite carrying the real GEO migrations.
 *
 * Shared because two suites now need it — `alertRunner.test.ts` and
 * `alertBrandScoping.test.ts` — and **two copies of a database harness drift**:
 * the second one omits a migration, its suite fails on `no such column`, and the
 * error points at the schema rather than at the missing migration. That is the
 * exact failure `scripts/migration-coverage.test.ts` exists to stop, and the
 * cheapest way not to invite it is to have one harness.
 *
 * Real SQLite rather than a mocked `db`, for the same reason
 * `scheduledGeoPatrol.test.ts` uses it: **which rows come back IS the claim being
 * tested.** A stubbed query builder returns whatever it was told to return and so
 * cannot catch a missing `WHERE` clause — which is precisely the cross-brand bug
 * these suites exist to hold shut.
 */

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "p1";

export const T1 = new Date("2026-10-01T00:00:00.000Z");
export const T2 = new Date("2026-10-02T00:00:00.000Z");
export const T8 = new Date("2026-10-08T00:00:00.000Z");

let client: Client;

/**
 * The brand every single-brand test uses, so `target()` and `snapshot()` agree
 * without each call site repeating the id.
 *
 * Module-private: it is the default for `snapshot`, which is the only consumer,
 * and exporting it would offer a second place for a test to import a target id
 * from — which is how two suites end up disagreeing about which brand a row
 * belongs to.
 */
const DEFAULT_TARGET = "t1";

/**
 * Installs the in-memory database and its `vi.doMock("@/db")`.
 *
 * Called by each suite's own `beforeAll` **before** importing the module under
 * test. The ordering is load-bearing rather than stylistic: both modules read
 * `@/db` at import time, so an import that ran first would capture a real,
 * unconfigured client and every query would fail on `undefined.prepare` — an
 * error about the database raised by a test about the alerting decision.
 *
 * Exported and called explicitly rather than relying on a bare `import
 * "./alertFixture"`, for two reasons. `no-unassigned-import` forbids the bare
 * form, and more importantly a suite that does not visibly call its setup has
 * invisible setup — and *this* setup is precisely the ordering that matters.
 */
export async function installAlertFixture(): Promise<void> {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      // 0048 creates the GEO tables, 0054 the alert dispatch table, 0055 the run
      // denominator the alerting reader filters on.
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0054_freezing_ultimo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      // 0056 adds geo_snapshots.target_id, which the alerting reader filters on.
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );
}

/**
 * Empties the database between tests, and puts the project back.
 *
 * Exported and called from each suite's `beforeEach` rather than registered as a
 * `beforeEach` here: a hook declared in an imported module belongs to *that
 * module's* file, so it would either not run at all or run at the wrong time, and
 * a fixture that appears to reset but does not is worse than one that obviously
 * does not. Each suite calling it is one line and is honest about when the reset
 * happens.
 */
export async function resetAlertFixture(): Promise<void> {
  await client.executeMultiple(
    "DELETE FROM geo_alert_dispatches; DELETE FROM geo_snapshot_answers; DELETE FROM geo_answers; DELETE FROM geo_snapshots; DELETE FROM geo_targets; DELETE FROM projects;",
  );
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
}

export function closeAlertFixture(): void {
  client.close();
}

/**
 * A page an answer cited.
 *
 * `geo_answer_citations` de-duplicates by `(answer_id, url)`, so re-running a
 * prompt cannot inflate a count. That is why the alerting reader relies on this
 * table rather than re-deriving a set from answer text.
 */
export async function citation(answerId: string, url: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_answer_citations (answer_id, url) VALUES (?, ?)`,
    args: [answerId, url],
  });
}

/**
 * A finished run belonging to a brand.
 *
 * `targetId` defaults to {@link DEFAULT_TARGET} because most tests in these suites
 * are about a single brand and writing the same literal at every call site is how
 * a fixture ends up lying: a test that meant `t_acme` and passed `t_globex` would
 * still compile. The multi-brand tests pass their own ids explicitly.
 *
 * It is a **required concept** even though it has a default: since CL-501e an
 * unattributed run has no baseline by design, so a fixture that wrote `null` would
 * make every test exercise the refusal path instead of the behaviour under test.
 * Use {@link unattributedSnapshot} for the unattributed case, on purpose.
 */
export async function snapshot(
  id: string,
  at: Date,
  targetId: string = DEFAULT_TARGET,
): Promise<void> {
  // The default target is created on demand because `geo_snapshots.target_id`
  // is a foreign key (CL-501e) and these suites are about the *comparison*, not
  // about target setup. Making every test call `target()` first would be a
  // pre-condition that is invisible in the test body and easy to forget — and a
  // forgotten one fails on a foreign key, which reads as a schema problem rather
  // than a missing fixture row.
  await ensureTarget(targetId);
  await client.execute({
    sql: `INSERT INTO geo_snapshots (id, project_id, target_id, started_at, status, created_by)
          VALUES (?, ?, ?, ?, 'complete', 'schedule')`,
    args: [id, PROJECT, targetId, at.toISOString()],
  });
}

/**
 * Create the target row if it is not already there.
 *
 * The domain it invents is derived from the id, so **a test that wants its own
 * domain must call {@link target} first.** Otherwise the mention rule looks for
 * `t_acme.example.com` while the test's answers say `acme.com`, finds nothing,
 * and the run reports `dispatched` with an empty message — which reads as a broken
 * dispatcher rather than a fixture disagreeing with its own answers. Two of the
 * multi-brand tests lost an hour to exactly that.
 */
async function ensureTarget(id: string): Promise<void> {
  const existing = await client.execute({
    sql: "SELECT id FROM geo_targets WHERE id = ?",
    args: [id],
  });
  if (existing.rows.length > 0) return;
  await client.execute({
    sql: `INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at)
          VALUES (?, ?, ?, ?, 2840, 'en', '2026-01-01 00:00:00')`,
    args: [id, PROJECT, id, `${id}.example.com`],
  });
}

/**
 * A run in a state that must never become a baseline.
 *
 * The target defaults for the same reason as {@link snapshot}: the status is what
 * the test is about, and an unattributed run would be refused earlier — for a
 * different reason — so the test would pass without exercising anything.
 */
export async function snapshotWithStatus(
  id: string,
  at: Date,
  status: "running" | "failed" | "cancelled",
  targetId: string = DEFAULT_TARGET,
): Promise<void> {
  await ensureTarget(targetId);
  await client.execute({
    sql: `INSERT INTO geo_snapshots (id, project_id, target_id, started_at, status, created_by)
          VALUES (?, ?, ?, ?, ?, 'schedule')`,
    args: [id, PROJECT, targetId, at.toISOString(), status],
  });
}

/**
 * A finished run with **no brand** — every run written before CL-501e.
 *
 * Kept as a helper rather than written inline, because "an unattributed run has no
 * comparison" is a real behaviour and deserves a test rather than an ad-hoc row.
 */
export async function unattributedSnapshot(
  id: string,
  at: Date,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_snapshots (id, project_id, started_at, status, created_by)
          VALUES (?, ?, ?, 'complete', 'schedule')`,
    args: [id, PROJECT, at.toISOString()],
  });
}

/**
 * A monitored target, so an answer has a brand to be *about*.
 *
 * Not optional in these suites: `geo_answers.target_id` is what the reader
 * resolves the domain from, and an answer with no target carries no domain, which
 * `decideAlerts` refuses to compare — so a fixture without one would silently
 * exercise the refusal path instead of the behaviour under test.
 */
export async function target(id: string, domain: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_targets
            (id, project_id, name, domain, location_code, language_code, created_at)
          VALUES (?, ?, ?, ?, 2840, 'en', '2026-01-01 00:00:00')`,
    args: [id, PROJECT, domain, domain],
  });
}

/**
 * An answer row, plus its join into the snapshot.
 *
 * `text` being null is the *normal* `mentions_search` shape, not a gap.
 *
 * `source` and `targetId` are an options object rather than two more positional
 * parameters: six positional arguments including two of the same primitive type is
 * a call site where swapping them compiles perfectly and inserts a row that is
 * quietly wrong.
 */
export async function answer(
  id: string,
  snapshotId: string,
  prompt: string,
  text: string | null,
  options: {
    source?: "mentions_search" | "llm_responses";
    targetId?: string | null;
  } = {},
): Promise<void> {
  const { source = "mentions_search", targetId = null } = options;
  await client.execute({
    sql: `INSERT INTO geo_answers
            (id, project_id, target_id, prompt, answer_text, platform, source, location_code, language_code, answered_at, created_at)
          VALUES (?, ?, ?, ?, ?, 'chat_gpt', ?, 2840, 'en', ?, ?)`,
    args: [
      id,
      PROJECT,
      targetId,
      prompt,
      text,
      source,
      T2.toISOString(),
      T2.toISOString(),
    ],
  });
  await client.execute({
    sql: "INSERT INTO geo_snapshot_answers (snapshot_id, answer_id) VALUES (?, ?)",
    args: [snapshotId, id],
  });
}
