import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gate `check:journals` cannot be: **does each migration's DDL actually
 * build the schema the snapshots claim it built?**
 *
 * ## The bug this exists to prevent
 *
 * `src/db/audit.schema.ts` declared `fixesJson` from its first commit, and
 * `drizzle-pg/0036_labs_categories.sql` created the column on Postgres. The D1
 * migration that creates `audit_readiness` — `0059` — did not. It was then
 * hand-edited once more (plain index → unique index) *still* without anyone
 * noticing, and the result shipped: a table present on both dialects with a
 * different column set, written and read on D1, so **every site audit that
 * reached the readiness step threw `table audit_readiness has no column named
 * fixes_json`** on the default provider.
 *
 * ## Why `db:generate` could not see it
 *
 * The snapshot chain had been regenerated from the *schema* while the migration
 * was written by hand, so `0060_snapshot.json` and `0061_snapshot.json` both
 * already declared `fixes_json`. drizzle-kit diffs schema against snapshot,
 * found nothing to do, and printed **"No schema changes, nothing to migrate"**.
 * The drift was invisible to the one tool whose job is to see it, and it would
 * have stayed that way permanently — the next `generate` diffs against a
 * snapshot that lies in the same direction.
 *
 * `check:journals` checks that journal entries match `.sql` files and that the
 * ordering is sane. It reads no DDL. That is the hole this file fills.
 *
 * ## How it checks, and why by execution
 *
 * Text-matching DDL is a trap: SQLite's table-rebuild pattern (`CREATE TABLE
 * __new_x` → copy → `DROP TABLE x` → `ALTER TABLE __new_x RENAME TO x`) makes any
 * regex that maps a `CREATE TABLE` to its final table name wrong, and
 * `ALTER TABLE ... ADD COLUMN` has enough spellings to fill a page.
 *
 * So for SQLite this **runs the migrations** — Node 22 ships `node:sqlite`, so
 * the whole D1 chain is applied to an in-memory database and introspected with
 * `PRAGMA table_info`. That is the same thing `wrangler d1 migrations apply`
 * does, so it also catches SQL that does not *parse*, which no snapshot
 * comparison can.
 *
 * Postgres has no in-process engine, so it gets the structural half only: the
 * final snapshot's columns must each be created by a `CREATE TABLE` or added by
 * an `ALTER TABLE ... ADD COLUMN` in that dialect's files. Postgres has no
 * table-rebuild idiom, so that mapping is unambiguous there.
 */

const REPO_ROOT = process.cwd().endsWith("scripts")
  ? process.cwd().replace(/scripts[\\/]?$/, "")
  : process.cwd();

/** Read the final snapshot: the one no other snapshot names as `prevId`. */
function readFinalSnapshot(dir: string) {
  const metaDir = join(REPO_ROOT, dir, "meta");
  const snapshots = readdirSync(metaDir)
    .filter((name) => name.endsWith("_snapshot.json"))
    .sort();
  const referenced = new Map<string, string>();
  for (const name of snapshots) {
    const parsed = JSON.parse(readFileSync(join(metaDir, name), "utf8"));
    referenced.set(parsed.id as string, parsed.prevId as string);
  }
  const finalName = snapshots.find((name) => {
    const parsed = JSON.parse(readFileSync(join(metaDir, name), "utf8"));
    return ![...referenced.values()].includes(parsed.id as string);
  });
  if (!finalName) throw new Error(`${dir}: no final snapshot found`);
  return JSON.parse(readFileSync(join(metaDir, finalName), "utf8"));
}

/** Snapshot column names, keyed by table, with the dialect schema prefix off. */
function snapshotColumnsByTable(snapshot: {
  tables: Record<string, { columns: Record<string, unknown> }>;
}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    out.set(tableName.replace(/^public\./, ""), Object.keys(table.columns));
  }
  return out;
}

/**
 * The D1 migration filenames, in journal order.
 *
 * Exposed because the negative control at the bottom of this file needs to skip
 * one of them, and hardcoding the list there would mean the control silently
 * started testing nothing the moment a migration was added.
 */
function d1MigrationFiles(): string[] {
  return readdirSync(join(REPO_ROOT, "drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Apply the D1 chain to a fresh in-memory SQLite and return the columns the
 * final snapshot declares that the applied chain never created.
 *
 * **This exists so the negative control can call it.** A gate that has never
 * been shown to fail is a script reporting success — `scripts/gates-about-gates.test.ts`
 * names exactly that failure mode, and this repo's whole gate philosophy rests
 * on proving a gate can fire. So the control feeds this the one input that must
 * fail (the chain with the fix removed) and asserts it does.
 */
function d1UnaccountedColumns(skipPrefixes: string[] = []): string[] {
  const db = new DatabaseSync(":memory:");
  for (const name of d1MigrationFiles()) {
    if (skipPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const sql = readFileSync(join(REPO_ROOT, "drizzle", name), "utf8");
    for (const statement of sqliteStatements(sql)) db.exec(statement);
  }
  return unaccountedColumnsFor(db, readFinalSnapshot("drizzle"));
}

/** One migration file's SQL as individual statements. */
function sqliteStatements(sql: string): string[] {
  // Strip `--` comments: `node:sqlite` executes the file verbatim, and a comment
  // containing a `;` would split a statement in two.
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Columns the snapshot declares that the database does not have. */
function unaccountedColumnsFor(
  db: DatabaseSync,
  snapshot: ReturnType<typeof readFinalSnapshot>,
): string[] {
  const unaccounted: string[] = [];
  for (const [table, columns] of snapshotColumnsByTable(snapshot)) {
    const actual = new Set(
      db
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all()
        .map((row) => (row as { name: string }).name),
    );
    for (const column of columns) {
      if (!actual.has(column)) unaccounted.push(`${table}.${column}`);
    }
  }
  return unaccounted;
}

// ── SQLite: apply the chain to a real engine and introspect it ───────────────

describe("the D1 migrations build the schema the snapshot claims", () => {
  const files = d1MigrationFiles();

  const db = new DatabaseSync(":memory:");
  const applied: string[] = [];
  for (const name of files) {
    const sql = readFileSync(join(REPO_ROOT, "drizzle", name), "utf8");
    for (const statement of sqliteStatements(sql)) db.exec(statement);
    applied.push(name);
  }

  const snapshot = readFinalSnapshot("drizzle");

  it("applies every D1 migration without a SQL error", () => {
    // A chain that does not execute is a deploy failure, not a lint failure.
    expect(applied.length).toBe(files.length);
    expect(applied.length).toBeGreaterThan(50);
  });

  it("creates every table the final snapshot declares", () => {
    const declared = snapshotColumnsByTable(snapshot);
    const existing = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((row) => (row as { name: string }).name),
    );
    expect([...declared.keys()].filter((t) => !existing.has(t))).toEqual([]);
  });

  it("creates every column the final snapshot declares", () => {
    // **The assertion that caught `audit_readiness.fixes_json`.**
    expect(
      unaccountedColumnsFor(db, snapshot),
      `columns the D1 migrations never create but the snapshot declares. ` +
        `The snapshot was regenerated from the schema while the SQL was ` +
        `hand-written, so \`db:generate\` reports "no schema changes" and the ` +
        `drift is permanent — add a forward-only ALTER migration:\n  `,
    ).toEqual([]);
  });

  it("leaves no column in the database the snapshot never declared", () => {
    // The mirror direction, and the reason this is one assertion rather than
    // none: a column that exists on disk but not in the snapshot is a column the
    // ORM will never select, which reads as "the feature is broken" rather than
    // "the migration ran ahead of the schema".
    const declared = snapshotColumnsByTable(snapshot);
    const extra: string[] = [];
    for (const [table, columns] of declared) {
      const snapshotSet = new Set(columns);
      for (const row of db
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all()) {
        const name = (row as { name: string }).name;
        if (!snapshotSet.has(name)) extra.push(`${table}.${name}`);
      }
    }
    expect(
      extra,
      `columns the D1 database has that the snapshot does not declare — a ` +
        `migration ran ahead of the schema:\n  ${extra.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ── Postgres: structural comparison against the final snapshot ───────────────

describe("the Postgres migrations build the schema the snapshot claims", () => {
  const dir = "drizzle-pg";
  const sql = readdirSync(join(REPO_ROOT, dir))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(join(REPO_ROOT, dir, name), "utf8"))
    .join("\n");

  const created = new Map<string, Set<string>>();

  const note = (table: string, column: string) => {
    const set = created.get(table) ?? new Set<string>();
    set.add(column);
    created.set(table, set);
  };

  // `CREATE TABLE "public"."name" ( ... )` — body read with balanced parens so a
  // `CHECK (...)`, a `DEFAULT (...)`, or a `REFERENCES x(col)` inside it cannot
  // terminate the column list early.
  const createTable =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)["`]?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = createTable.exec(sql)) !== null) {
    const table = match[1].replace(/^public\./, "");
    const body = readBalanced(sql, match.index + match[0].length);
    for (const line of body.split("\n")) {
      const column = readColumnName(line);
      if (column) note(table, column);
    }
  }

  const alterTable =
    /ALTER\s+TABLE\s+(?:ONLY\s+)?["`]?([\w.]+)["`]?\s+ADD\s+(?:COLUMN\s+)?/gi;
  while ((match = alterTable.exec(sql)) !== null) {
    const table = match[1].replace(/^public\./, "");
    const statement = sql
      .slice(match.index + match[0].length)
      .split(";")[0]
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join(" ");
    for (const part of statement.split(",")) {
      const added = part.match(/^\s*(?:ADD\s+(?:COLUMN\s+)?)?["`]?(\w+)["`]?/);
      if (added) note(table, added[1]);
    }
  }

  it("creates every column the final Postgres snapshot declares", () => {
    const declared = snapshotColumnsByTable(readFinalSnapshot(dir));
    const unaccounted: string[] = [];
    for (const [table, columns] of declared) {
      const createdFor = created.get(table);
      for (const column of columns) {
        if (!createdFor?.has(column)) unaccounted.push(`${table}.${column}`);
      }
    }
    expect(
      unaccounted,
      `columns the Postgres snapshot declares but no drizzle-pg migration ` +
        `creates — the table is missing or short a column on every Postgres ` +
        `self-host, while \`db:generate\` sees no change:\n  ` +
        unaccounted.join("\n  "),
    ).toEqual([]);
  });
});

/** Read a balanced-paren block starting just after the opening paren. */
function readBalanced(text: string, start: number): string {
  let depth = 1;
  let index = start;
  for (; index < text.length && depth > 0; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
  }
  return text.slice(start, index - 1);
}

/** The column name on one line of a `CREATE TABLE` body, or null. */
function readColumnName(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("--")) return null;
  if (
    /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|EXCLUDE|LIKE|INHERITS|PARTITION)\b/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  return trimmed.match(/^["`]?(\w+)["`]?/)?.[1] ?? null;
}

// ── The negative control ─────────────────────────────────────────────────────
//
// `scripts/gates-about-gates.test.ts` keeps a pin of every gate with no
// negative control, on the grounds that a gate which has only ever passed is a
// script reporting success. This file was on that pin the moment it was written,
// so it earns its way off by proving it can fail.
//
// The control is not a synthetic fixture. It is the real chain with the real
// `0062_audit_readiness_fixes_json.sql` removed — the exact bug that shipped —
// run through the same code path the real assertion uses. That matters: a
// negative control built from a made-up input proves the detector fires on the
// made-up input, not on the thing it is supposed to catch.

describe("the D1 column check can actually fail", () => {
  const FIX_MIGRATION = "0062_audit_readiness_fixes_json";

  it("reports nothing missing when the whole chain is applied", () => {
    expect(d1UnaccountedColumns()).toEqual([]);
  });

  it(`names \`audit_readiness.fixes_json\` when ${FIX_MIGRATION} is absent`, () => {
    // The shipped bug, reproduced exactly. `0059_audit_readiness.sql` creates
    // the table without the column, `src/db/audit.schema.ts` writes and reads
    // it, and the snapshot chain already claimed it existed — so dropping the
    // one migration that fixed it must surface it here, or this gate is not a
    // gate.
    expect(d1UnaccountedColumns([FIX_MIGRATION])).toContain(
      "audit_readiness.fixes_json",
    );
  });

  it("fails for a reason a reader can act on", () => {
    // The finding names the table and the column, because a gate that reports
    // "something is wrong" without saying what is a gate nobody can fix.
    const findings = d1UnaccountedColumns([FIX_MIGRATION]);
    expect(findings).toContain("audit_readiness.fixes_json");
    expect(
      findings.every((finding) => /^[\w]+\.[\w]+$/.test(finding)),
      `every finding must read as table.column so the fix is obvious: ${findings.join(", ")}`,
    ).toBe(true);
  });

  it("scopes its finding to the one column the shipped bug was about", () => {
    // Dropping a *table* migration surfaces that table's columns, because the
    // column check subsumes the table check — a table that was never created is
    // a table whose columns are all missing. That is the right behaviour, and it
    // is worth stating: the assertion does not need a separate table gate to be
    // load-bearing.
    //
    // What matters for the control is that the shipped bug produced **exactly
    // one** finding, the one column, from a chain that was otherwise complete.
    // A gate that reported a wall of columns for a one-column bug would be
    // reporting noise, and the reader would stop reading it.
    expect(d1UnaccountedColumns([FIX_MIGRATION])).toEqual([
      "audit_readiness.fixes_json",
    ]);
  });
});
