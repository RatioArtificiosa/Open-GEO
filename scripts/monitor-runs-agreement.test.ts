import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repository and its index must agree.
 *
 * The property is a **drift** guard, and drift is invisible to a type checker:
 * if the repository targeted a different column set than the partial unique
 * index, everything would compile, every test would pass, and a duplicate cron
 * trigger would raise a unique violation at the customer instead of returning
 * "already running".
 *
 * ## Why this is a source scan and not a database test
 *
 * The first version mocked `@/db` with a hand-rolled chainable stub, and it cost
 * seven lint errors to say nothing the scan says better: the mock asserted the
 * repository's *own* shape back at itself, so a change to both would have
 * passed. A gate that checks two files against **each other** cannot be satisfied
 * by changing one of them, which is the entire risk.
 *
 * And it needs no database, so it runs in CI everywhere.
 */

const REPO_ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const SQLITE_SCHEMA = "src/db/monitor-runs.schema.ts";
const PG_SCHEMA = "src/db/pg/monitor-runs.schema.ts";
const REPOSITORY =
  "src/server/features/geo/repositories/MonitorRunRepository.ts";

/** The four columns that make a monitor's identity, in the order the index uses. */
const IDENTITY_COLUMNS = [
  "projectId",
  "monitorType",
  "monitorSubject",
  "platform",
] as const;

/** The statuses that hold the slot. Mirrors the index's `WHERE`. */
const ACTIVE_STATUSES = ["pending", "running"] as const;

describe("monitor_runs: the index and the repository agree", () => {
  it("builds the partial unique index on the identity columns, in both dialects", () => {
    for (const file of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const source = read(file);
      const index = source.slice(
        source.indexOf("monitor_runs_one_active_per_monitor_idx"),
      );
      for (const column of IDENTITY_COLUMNS) {
        expect(index, `${file} is missing ${column}`).toContain(
          `table.${column}`,
        );
      }
      for (const status of ACTIVE_STATUSES) {
        expect(index, `${file} is missing status ${status}`).toContain(status);
      }
    }
  });

  it("targets the conflict on the same four columns, in the same order", () => {
    // Order matters to Postgres, which matches a unique index by its column
    // list; a reordered target would not match the index and would raise.
    const source = read(REPOSITORY);
    // Anchored on the *call*, not the bare name: the module docblock discusses
    // `onConflictDoNothing` in prose, and matching that would read the
    // explanation instead of the code. The first version did, and asserted an
    // empty list.
    const at = source.indexOf(".onConflictDoNothing({");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, at + 400);
    const found = [...block.matchAll(/monitorRuns\.(\w+)/g)].map((m) => m[1]);
    expect(found.slice(0, 4)).toEqual([...IDENTITY_COLUMNS]);
  });

  it("uses a targeted conflict, never an un-targeted one", () => {
    // An un-targeted `ON CONFLICT DO NOTHING` also swallows a PRIMARY KEY
    // collision, so a run that silently never started would look exactly like a
    // successful claim. `tryCreateRun` in the rank-tracking repository is
    // un-targeted; this is the fix, and this is what stops it regressing.
    const source = read(REPOSITORY);
    expect(source).toMatch(/\.onConflictDoNothing\(\{\s*target:/);
    expect(source).not.toMatch(/\.onConflictDoNothing\(\);/);
  });

  it("normalises an absent subject or platform to empty rather than null", () => {
    // The identity is a triple and "no subject" is a real monitor — a
    // whole-project one. A null would make that indistinguishable from "not set
    // yet", and the two would never be recognised as the same run.
    const source = read(REPOSITORY);
    expect(source).toMatch(/monitorSubject = identity\.monitorSubject \?\? ""/);
    expect(source).toMatch(/platform = identity\.platform \?\? ""/);
  });

  it("guards a finish on the active statuses, so a late callback cannot win", () => {
    // Without the guard, a duplicate callback would overwrite a real error
    // message with a success and a real cost with a zero.
    const source = read(REPOSITORY);
    expect(source).toMatch(
      /inArray\(monitorRuns\.status, \[\.\.\.ACTIVE_STATUSES\]\)/,
    );
  });

  it("keeps the index scoped to in-flight runs", () => {
    // A unique index over all statuses would permit exactly one run per
    // monitor, ever — and the archive would be a single row.
    for (const file of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const source = read(file);
      expect(source).toMatch(
        /\.where\(sql`\$\{table\.status\} IN \('pending', 'running'\)/,
      );
    }
  });

  it("stores money as integer micro-units, not as a float", () => {
    // A money column in floating point accumulates exactly the error that makes
    // a reconciliation argument unfalsifiable.
    for (const file of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const source = read(file);
      expect(source).toContain("costUsdMicros");
      expect(source).toContain("chargedUsdMicros");
      expect(source).not.toMatch(/real\("costUsd/);
    }
  });
});
