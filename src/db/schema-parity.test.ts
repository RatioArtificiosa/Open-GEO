import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { sort } from "remeda";
import { describe, expect, it } from "vitest";
// **The barrels the repositories import, not a hand-typed list of modules.**
//
// The first version of this file imported 13 schema modules per dialect, and
// `src/db/schema.ts` registered 19. The six it missed — `vendor-tasks`,
// `monitor-runs`, `geo-pending-tasks`, `alert-dispatches`, `labs-categories`,
// `keyword-opportunity-inputs` — included `keywordOpportunityInputs`, the exact
// table whose Postgres barrel pointed at the SQLite file and whose migration was
// therefore never generated (`2a785c9`, "the postgres barrel pointed at the
// sqlite table, so its migration was never generated"). The gate that claims to
// catch a table added to one dialect but not the other was blind to 6 of 60
// tables, and one of them was the table that had just shipped the bug.
//
// A hand-maintained import list is a gate that decays on every new table. These
// two barrels are the same objects every repository binds, so enumerating them
// means the coverage cannot drift: adding a 20th schema module to both barrels
// adds it to this test's population automatically, in either dialect.
import * as sqliteSchema from "./d1/schema";
import * as pgSchema from "./pg/schema";
// Imported only to partition the population: better-auth's generated schemas are
// compared with relaxed rules below (column names + nullability, not dataType),
// because `auth:generate` is intentionally dialect-native there. The set of names
// is what separates the two groups — not a hand-typed list, which is the whole
// point of this file's new shape.
import * as sqliteBetterAuth from "./better-auth-schema";
import * as pgBetterAuth from "./pg/better-auth-schema";

// Guards the ONE structural artifact `db:generate` does not regenerate: the
// hand-written Postgres schema. The provider-aware `db`/`@/db/schema` barrel
// types Postgres as the SQLite schema via a cast, so these two schemas MUST stay
// structurally interchangeable or that cast lies. This test fails loudly the
// moment they drift (e.g. a table added to one dialect but not the other).

type Dialect = "sqlite" | "pg";

/**
 * Resolved from the repo root, because the barrel assertion below reads
 * `src/db/schema.ts` and vitest's cwd varies by invocation.
 */
const REPO_ROOT = process.cwd().endsWith("\\src")
  ? process.cwd().replace(/[\\/]src[\\/]?$/, "")
  : process.cwd();

const sortStrings = (values: string[]) =>
  sort(values, (a, b) => a.localeCompare(b));

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return sortStrings(value.filter((v): v is string => typeof v === "string"));
}

function tablesFrom(...modules: Record<string, unknown>[]) {
  const out = new Map<string, Table>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (is(value, Table)) out.set(getTableName(value), value);
    }
  }
  return out;
}

const getConfig = (table: Table, dialect: Dialect) =>
  dialect === "pg" ? getPgTableConfig(table) : getSqliteTableConfig(table);

type ColumnInfo = {
  name: string;
  notNull: boolean;
  dataType: string;
  hasDefault: boolean;
  enumValues: string[] | null;
};

/**
 * Column shape, with SQLite's rowid aliasing made explicit.
 *
 * ## Why this normalizes `hasDefault` for one exact case
 *
 * In SQLite, `INTEGER PRIMARY KEY` is **not** a plain column — it is an alias for
 * the rowid, so the engine assigns a value whenever an insert omits it. Drizzle
 * reports that truthfully as `hasDefault: true`, and it does so whether or not
 * `autoIncrement` is passed, because it is a fact about the engine rather than
 * about the declaration.
 *
 * Postgres has no equivalent: a bare `integer PRIMARY KEY` has no default at all.
 *
 * That is an irreducible engine difference, not schema drift — the same kind of
 * exemption `schema-parity.test.ts` already makes for better-auth's `timestamptz`
 * / `jsonb` columns. `category_taxonomy` is the only table where it bites: its
 * `criterion_id` is the *vendor's* id, supplied on every insert, so the SQLite
 * default never fires and the Postgres column never needs one.
 *
 * The normalization is scoped to SQLite integer primary keys and to nothing else,
 * so a real default appearing or disappearing on any other column still fails.
 */
function columnsOf(table: Table): ColumnInfo[] {
  return Object.values(getTableColumns(table)).map((col) => ({
    name: col.name,
    notNull: col.notNull,
    // `dataType` resolves to `any` via Drizzle's column config generic; narrow it.
    dataType: typeof col.dataType === "string" ? col.dataType : "unknown",
    hasDefault: col.hasDefault,
    enumValues: asStringArray(col.enumValues),
  }));
}

/**
 * `columnsOf` with the SQLite rowid aliasing normalized away.
 *
 * In SQLite, `INTEGER PRIMARY KEY` is an alias for the rowid, so the engine
 * assigns a value when an insert omits it — Drizzle reports that as
 * `hasDefault: true`, and does so whether or not `autoIncrement` is declared,
 * because it is a fact about the engine rather than about the declaration.
 * Postgres has no equivalent: a bare `integer PRIMARY KEY` has no default.
 *
 * This is an irreducible engine difference, not schema drift — the same class of
 * exemption the file already makes for better-auth's `timestamptz` / `jsonb`
 * columns. `category_taxonomy.criterion_id` is the only table where it bites:
 * its id is the *vendor's*, supplied on every insert, so the SQLite default never
 * fires and the Postgres column never needs one.
 *
 * Scoped to integer primary keys and to nothing else, so a real default
 * appearing or disappearing on any other column still fails loudly.
 */
function columnsOfIgnoringRowidDefault(
  sqliteTable: Table,
  pgTable: Table,
): { sqlite: ColumnInfo[]; pg: ColumnInfo[] } {
  const integerPrimaryKeys = new Set<string>();
  for (const table of [sqliteTable, pgTable]) {
    // **Keyed by the *column name*, not the JS property key.** drizzle tables
    // expose both — `getTableColumns` is keyed by `criterionId` while the column
    // reports `criterion_id` — and the first version of this normalization keyed
    // the set by the property and compared against `row.name`, so it matched
    // nothing and silently normalized nothing. A gate that normalizes on a key
    // it can never match is worse than no gate: it reads as coverage.
    for (const [, col] of Object.entries(getTableColumns(table))) {
      if (col.primary && col.dataType === "number") {
        integerPrimaryKeys.add(col.name);
      }
    }
  }
  const normalize = (rows: ColumnInfo[]) =>
    rows.map((row) =>
      integerPrimaryKeys.has(row.name) ? { ...row, hasDefault: false } : row,
    );
  return {
    sqlite: normalize(columnsOf(sqliteTable)),
    pg: normalize(columnsOf(pgTable)),
  };
}

function columnName(candidate: unknown): string | null {
  if (
    candidate &&
    typeof candidate === "object" &&
    "name" in candidate &&
    typeof candidate.name === "string"
  ) {
    return candidate.name;
  }
  return null;
}

// Unique constraints reduced to "sortedCols[|partial]" — including whether the
// index carries a WHERE predicate so a partial→full change (which alters the
// onConflict invariant) is caught even though the predicate text is dialect-
// specific.
function uniqueColumnTuples(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  const tuples = new Set<string>();
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    const cols = index.config.columns
      .map(columnName)
      .filter((name): name is string => name !== null);
    tuples.add(
      sortStrings(cols).join(",") + (index.config.where ? "|partial" : ""),
    );
  }
  for (const constraint of config.uniqueConstraints) {
    tuples.add(sortStrings(constraint.columns.map((c) => c.name)).join(","));
  }
  for (const col of Object.values(getTableColumns(table))) {
    if (col.isUnique) tuples.add(col.name);
  }
  return sortStrings([...tuples]);
}

function primaryKeyColumns(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  const pk = new Set<string>();
  for (const col of Object.values(getTableColumns(table))) {
    if (col.primary) pk.add(col.name);
  }
  for (const composite of config.primaryKeys) {
    for (const col of composite.columns) pk.add(col.name);
  }
  return sortStrings([...pk]);
}

// FK as "cols->refTable.refCols onDelete=action" so a dropped/changed cascade is
// caught (the parity property repositories rely on for cascading deletes).
function foreignKeys(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  return sortStrings(
    config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      const cols = sortStrings(ref.columns.map((c) => c.name)).join(",");
      const refTable = getTableName(ref.foreignTable);
      const refCols = sortStrings(ref.foreignColumns.map((c) => c.name)).join(
        ",",
      );
      return `${cols}->${refTable}.${refCols} onDelete=${fk.onDelete ?? "none"}`;
    }),
  );
}

function checkNames(table: Table, dialect: Dialect): string[] {
  return sortStrings(
    getConfig(table, dialect).checks.map((check) => check.name),
  );
}

const sqliteAllTables = tablesFrom(sqliteSchema);
const pgAllTables = tablesFrom(pgSchema);

/**
 * better-auth's generated tables, by name on each dialect.
 *
 * They are compared with the relaxed rules below, so the population is split *by
 * the module that defines it* rather than by a list someone maintains — that
 * list is exactly what went stale and left six tables unguarded.
 */
const sqliteAuthTableNames = new Set(tablesFrom(sqliteBetterAuth).keys());
const pgAuthTableNames = new Set(tablesFrom(pgBetterAuth).keys());

/** Every table except better-auth's: the ones strict parity holds for. */
function appTablesOnly(all: Map<string, Table>): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const [name, table] of all) {
    if (sqliteAuthTableNames.has(name) || pgAuthTableNames.has(name)) continue;
    out.set(name, table);
  }
  return out;
}

const sqliteAppTables = appTablesOnly(sqliteAllTables);
const pgAppTables = appTablesOnly(pgAllTables);
const sqliteAuthTables = tablesFrom(sqliteBetterAuth);
const pgAuthTables = tablesFrom(pgBetterAuth);

/**
 * **The assertion this file was missing for two releases.**
 *
 * A hand-maintained import list left 6 of 60 tables unguarded — including
 * `keyword_opportunity_inputs`, the table whose Postgres barrel pointed at the
 * SQLite file so its migration was never generated (`2a785c9`). The population is
 * now derived from the barrels, so this describe block is the belt to that
 * braces: if the two dialects' barrels ever disagree about which modules exist,
 * the table-set assertion reports it instead of quietly comparing fewer tables.
 */
describe("schema parity: the barrels agree", () => {
  it("define the same number of tables on both backends", () => {
    expect(pgAllTables.size).toBe(sqliteAllTables.size);
  });

  it("register the same better-auth tables on both backends", () => {
    // Set comparison, not a sort: the repo lib target predates
    // Array#toSorted, and the claim is membership rather than order.
    expect(new Set(pgAuthTableNames)).toEqual(new Set(sqliteAuthTableNames));
    // Non-empty, or the partition above silently excludes everything and the
    // strict comparisons below pass by doing nothing.
    expect(sqliteAuthTableNames.size).toBeGreaterThan(0);
  });

  it("leaves a non-empty strict population", () => {
    // The same guard for the app side: a partition that matched everything would
    // make every assertion below vacuous.
    expect(sqliteAppTables.size).toBeGreaterThan(40);
    expect(pgAppTables.size).toBe(sqliteAppTables.size);
  });

  it("re-exports every table the dialect barrels export", () => {
    // `src/db/schema.ts` destructures `runtimeSchema` — the spread of both
    // barrels — into named exports. A table that exists in a barrel but not in
    // that destructuring is unreachable: no repository can import it, and the
    // `as unknown as AppSchema` cast at the bottom of the file covers a type the
    // app never sees. That is not hypothetical — `keywordOpportunityInputs` was
    // in the dialect barrels and absent from the provider barrel for exactly
    // long enough to ship a pg-only migration bug.
    //
    // Filtered to Tables, because the barrels also export `relations` objects
    // and the odd constant — those are not re-exported by the provider barrel
    // and asserting otherwise would fail on the first one added.
    const tableExportNames = [
      ...new Set(
        [...Object.entries(sqliteSchema), ...Object.entries(pgSchema)]
          .filter(([, value]) => is(value, Table))
          .map(([name]) => name),
      ),
    ];
    const source = readFileSync(join(REPO_ROOT, "src/db/schema.ts"), "utf8");
    const destructured = new Set(
      [...source.matchAll(/\b(\w+),/g)].map((m) => m[1]),
    );
    const unreachable = tableExportNames.filter(
      (name) => !destructured.has(name),
    );
    expect(
      unreachable,
      `tables a dialect barrel exports that src/db/schema.ts does not ` +
        `re-export — no repository can import them:\n  ${unreachable.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("schema parity: application tables", () => {
  it("define the same set of tables on both backends", () => {
    expect(sortStrings([...pgAppTables.keys()])).toEqual(
      sortStrings([...sqliteAppTables.keys()]),
    );
  });

  for (const [name, sqliteTable] of sqliteAppTables) {
    const pgTable = pgAppTables.get(name);
    if (!pgTable) continue; // reported by the table-set assertion above

    describe(`table "${name}"`, () => {
      it("has matching columns (name, nullability, type, default, enum)", () => {
        // dataType is dialect-agnostic ("string"/"number"/"boolean"/"date") so
        // text/text, boolean/boolean, serial/autoincrement match; a real type
        // mismatch is caught. `columnsOfIgnoringRowidDefault` is the documented
        // SQLite-rowid exemption above — scoped to integer primary keys, so it
        // cannot hide a real default difference anywhere else.
        expect(columnsOfIgnoringRowidDefault(sqliteTable, pgTable).pg).toEqual(
          columnsOfIgnoringRowidDefault(sqliteTable, pgTable).sqlite,
        );
      });
      it("has matching primary key", () => {
        expect(primaryKeyColumns(pgTable, "pg")).toEqual(
          primaryKeyColumns(sqliteTable, "sqlite"),
        );
      });
      it("has matching unique constraints (onConflict targets)", () => {
        expect(uniqueColumnTuples(pgTable, "pg")).toEqual(
          uniqueColumnTuples(sqliteTable, "sqlite"),
        );
      });
      it("has matching foreign keys (incl. onDelete)", () => {
        expect(foreignKeys(pgTable, "pg")).toEqual(
          foreignKeys(sqliteTable, "sqlite"),
        );
      });
      it("has matching check constraints", () => {
        expect(checkNames(pgTable, "pg")).toEqual(
          checkNames(sqliteTable, "sqlite"),
        );
      });
    });
  }
});

describe("schema parity: better-auth tables", () => {
  // better-auth schemas are generated per-dialect (auth:generate) and are
  // intentionally dialect-native in column TYPE (SQLite integer-timestamp_ms /
  // text-json vs Postgres timestamptz / jsonb). So we assert structure that
  // MUST match — table set, column names, nullability, PK, unique constraints —
  // but not dataType. This catches a column/table added or removed on one
  // dialect but not the other (e.g. a stale-oauth-tables drift, or a
  // better-auth upgrade applied to only one schema).
  it("define the same set of tables on both backends", () => {
    expect(sortStrings([...pgAuthTables.keys()])).toEqual(
      sortStrings([...sqliteAuthTables.keys()]),
    );
  });

  for (const [name, sqliteTable] of sqliteAuthTables) {
    const pgTable = pgAuthTables.get(name);
    if (!pgTable) continue;

    describe(`table "${name}"`, () => {
      it("has matching column names + nullability", () => {
        const shape = (table: Table) =>
          Object.fromEntries(columnsOf(table).map((c) => [c.name, c.notNull]));
        expect(shape(pgTable)).toEqual(shape(sqliteTable));
      });
      it("has matching primary key", () => {
        expect(primaryKeyColumns(pgTable, "pg")).toEqual(
          primaryKeyColumns(sqliteTable, "sqlite"),
        );
      });
      it("has matching unique constraints", () => {
        expect(uniqueColumnTuples(pgTable, "pg")).toEqual(
          uniqueColumnTuples(sqliteTable, "sqlite"),
        );
      });
    });
  }
});

// Secondary indexes that better-auth's `generate` CLI does NOT emit — they are
// hand-added to both schema files for query performance. Running `auth:generate`
// overwrites the files and drops them, so this guard fails loudly (on either
// dialect) if a regen forgets to re-apply them. Columns are SQL column names.
const REQUIRED_BETTER_AUTH_INDEXES: {
  table: string;
  columns: string[];
  unique: boolean;
}[] = [
  { table: "session", columns: ["user_id"], unique: false },
  { table: "account", columns: ["user_id"], unique: false },
  { table: "account", columns: ["account_id", "provider_id"], unique: false },
  { table: "verification", columns: ["identifier"], unique: false },
  { table: "verification", columns: ["expires_at"], unique: false },
  { table: "organization", columns: ["slug"], unique: true },
  { table: "member", columns: ["organization_id"], unique: false },
  { table: "member", columns: ["user_id"], unique: false },
  // Backstop for duplicate memberships (also guarded by beforeAcceptInvitation).
  { table: "member", columns: ["organization_id", "user_id"], unique: true },
  { table: "invitation", columns: ["organization_id"], unique: false },
  { table: "invitation", columns: ["email"], unique: false },
];

function indexKeys(table: Table, dialect: Dialect): string[] {
  const config = getConfig(table, dialect);
  return config.indexes.map((index) => {
    const cols = index.config.columns
      .map(columnName)
      .filter((name): name is string => name !== null);
    return `${sortStrings(cols).join(",")}|${index.config.unique ? "unique" : "index"}`;
  });
}

describe("better-auth required indexes (CLI omits them; re-apply after auth:generate)", () => {
  for (const dialect of ["sqlite", "pg"] as const) {
    const tables = dialect === "pg" ? pgAuthTables : sqliteAuthTables;
    describe(dialect, () => {
      for (const req of REQUIRED_BETTER_AUTH_INDEXES) {
        const label = `${req.table}(${req.columns.join(",")})${req.unique ? " unique" : ""}`;
        it(`has index ${label}`, () => {
          const table = tables.get(req.table);
          expect(table, `missing table "${req.table}"`).toBeDefined();
          if (!table) return;
          const key = `${sortStrings(req.columns).join(",")}|${req.unique ? "unique" : "index"}`;
          expect(indexKeys(table, dialect)).toContain(key);
        });
      }
    });
  }
});

describe("no direct db.batch (must use runBatch)", () => {
  // `db.batch` only exists on the D1 driver; on Postgres it throws. All atomic
  // multi-statement writes must go through `runBatch`, which is the only file
  // allowed to call `.batch`.
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(path));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        out.push(path);
    }
    return out;
  }

  it("is not called outside src/db/runBatch.ts", () => {
    const offenders = walk("src")
      .filter((path) => !path.endsWith(join("db", "runBatch.ts")))
      .filter((path) => /\.batch\(/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
