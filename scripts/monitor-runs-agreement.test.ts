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

/**
 * The raw SQL claim, with comments stripped.
 *
 * Every lookup in this file previously matched the *prose* rather than the
 * statement — `indexOf("ON CONFLICT")` found the word "shape" inside a
 * docblock sentence, and the `//` block above the claim quotes the grammar
 * (`ON CONFLICT (cols) WHERE …`) as an example. A gate that reads its own
 * documentation is not a gate.
 *
 * Only whole-line comments are removed, and a line is only a comment when it
 * *starts* with one — so a `--` or `//` inside a string literal cannot be
 * mistaken for one and the statement stays intact.
 */
function claimSource(): string {
  return read(REPOSITORY)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("/*") &&
        !trimmed.startsWith("*")
      );
    })
    .join("\n");
}

/** The four columns that make a monitor's identity, in the order the index uses. */
const IDENTITY_COLUMNS = [
  "projectId",
  "monitorType",
  "monitorSubject",
  "platform",
] as const;

/**
 * The same four columns as the raw SQL names them.
 *
 * The claim is written as raw SQL because Drizzle's builder cannot express a
 * partial unique index as a conflict target, so this is the form the conflict
 * clause actually has — and the form a drift between the two files would show in.
 */
const IDENTITY_SNAKE_CASE = [
  "project_id",
  "monitor_type",
  "monitor_subject",
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
    //
    // Read the column names out of **both** sides and compare, rather than
    // asserting a literal. Asserting a literal only pins the repository to
    // itself — the exact mistake the first version of this file made, and the
    // one a drift guard exists to prevent.
    const source = claimSource();
    const at = source.indexOf("ON CONFLICT (");
    expect(at).toBeGreaterThan(-1);
    // Split on commas, so the last column — which has no trailing comma — is
    // counted. The first version matched `/(\w+),/` and silently dropped it.
    const claimed = (source.slice(at, at + 200).split(")")[0] ?? "")
      .replace("ON CONFLICT (", "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    expect(claimed).toEqual([...IDENTITY_SNAKE_CASE]);
  });

  it("carries the partial-index predicate inside the conflict target", () => {
    // **This one was found by the real database, twice.**
    //
    // A unique index over `WHERE status IN ('pending','running')` cannot be
    // matched by `ON CONFLICT (cols)` alone. SQLite rejects the statement
    // outright — "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
    // constraint" — on the **first** insert, so the patrol would never run at all
    // rather than merely losing its protection.
    //
    // Every text assertion in this file passed with the clause missing, and then
    // again with the predicate in the wrong position (Drizzle's
    // `onConflictDoNothing({ where })` renders it after `DO NOTHING`, a syntax
    // error). A text gate can check that two files agree; it cannot know what
    // the engine's grammar requires. That limit is the reason the patrol suite
    // runs its claim against a real in-memory SQLite — and this assertion exists
    // only to keep the two spellings from drifting apart.
    const source = claimSource();
    const at = source.indexOf("ON CONFLICT (");
    expect(at).toBeGreaterThan(-1);
    const clause = source.slice(at, at + 300);
    // Predicate before the action keyword: `... WHERE <pred> DO NOTHING`.
    const whereAt = clause.indexOf("WHERE status IN");
    const doAt = clause.indexOf("DO NOTHING");
    expect(whereAt).toBeGreaterThan(-1);
    expect(doAt).toBeGreaterThan(-1);
    expect(whereAt).toBeLessThan(doAt);
    // And it must be the same two statuses the index is scoped to.
    expect(clause).toContain("'pending', 'running'");
  });

  it("uses a targeted conflict, never an un-targeted one", () => {
    // An un-targeted `ON CONFLICT DO NOTHING` also swallows a PRIMARY KEY
    // collision, so a run that silently never started would look exactly like a
    // successful claim. `tryCreateRun` in the rank-tracking repository is
    // un-targeted; this is the fix, and this is what stops it regressing.
    //
    // Checked as raw SQL because that is the form the repository now uses: a
    // bare `ON CONFLICT DO NOTHING` with no column list is the un-targeted one.
    const source = claimSource();
    expect(source).toMatch(/ON CONFLICT \(\s*project_id\s*,/);
    expect(source).not.toMatch(/ON CONFLICT DO NOTHING/);
    // And it must not have quietly fallen back to Drizzle's builder, which
    // cannot express a partial target — that is the mistake this file replaced.
    expect(source).not.toContain("onConflictDoNothing");
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
