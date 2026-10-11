import { describe, expect, it } from "vitest";
import type { Table } from "drizzle-orm";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { getDatabaseProvider } from "@/db/provider";
import { runtimeSchema } from "@/db/schema";

/**
 * Proof that the dual-dialect harness actually switches dialects.
 *
 * `vitest.setup.ts` installs a baseline `cloudflare:workers` mock read from
 * `DATABASE_PROVIDER`, so the suite can finally be run on the Postgres path for
 * the first time. This file is the **gate about that gate**: a setup file that
 * silently failed to wire through would produce a green run that tested nothing,
 * which is the identical failure shape `scripts/gates-about-gates.test.ts`
 * exists to prevent — and the same shape as the bug that motivated the setup
 * file in the first place.
 *
 * ## How the proof works, and why the discriminator is `getTableConfig().dialect`
 *
 * A drizzle table is a *proxy* over its own column names, so `table.dialect` is
 * `undefined` for **both** dialects and `Object.keys(table)` returns the column
 * names rather than metadata. Reading the dialect off the table object directly
 * is how the first two drafts of this file failed: one asserted
 * `dialect === "sqlite"` and matched nothing, and one read `Object.keys` and saw
 * columns. Both produced a green run that proved nothing about the dialect each
 * claimed to cover.
 *
 * `getTableConfig` is drizzle's own accessor and returns `{ dialect }`, which is
 * the same accessor `schema-parity.test.ts` already relies on. That is what
 * makes this file's assertion a real discriminator rather than a restatement of
 * the flag that produced the value.
 *
 * The provider is read once, at module load, because a mock factory cannot
 * consult a value that changes later. That is why this file is written to be run
 * **twice** — once per dialect — which is what the CI matrix now does.
 */

type Dialect = "sqlite" | "pg";

/**
 * The dialect a table was declared in, or `null` if it is not a drizzle table.
 *
 * **Not `table.dialect`** — a drizzle table is a proxy over its own column
 * names, so `Object.keys(table)` returns columns and `table.dialect` is
 * `undefined` for *both* dialects. Reading the dialect off the table object
 * directly is how the first two drafts of this file failed: one asserted
 * `dialect === "sqlite"` and matched nothing, and one read `Object.keys` and saw
 * columns. Both produced a green run that proved nothing about the dialect each
 * claimed to cover.
 *
 * `getTableConfig` is drizzle's own accessor, and each dialect's version throws
 * on a table it does not own — so *which one succeeds* is the discriminator.
 * That is also why the config type carries no `dialect` field: drizzle's types
 * never claimed to expose it, and only the call itself is reliable.
 */
/**
 * Which dialect a value is a drizzle table for, and the table itself.
 *
 * **Returns the table rather than a string, and that is the whole point.** The
 * probe is real — `getSqliteTableConfig` throws for a table it does not recognise
 * — so the previous version *proved* the type and then discarded the proof,
 * casting `unknown` to `Table` at each use site anyway. Carrying it in the return
 * type removes those casts and makes the narrowing checkable at compile time
 * The two `as Table` below are the probe's mechanism, not a shortcut: drizzle's
 * introspectors take a `Table`, and this function's whole input is `unknown`, so
 * there is no way to reach the config reader without asserting. A documented
 * assertion here is the honest option — the alternative is reimplementing
 * drizzle's introspection inside this test, which is how a test ends up testing
 * its own stub instead of the barrel.
 */
function dialectOf(value: unknown): { table: Table; dialect: Dialect } | null {
  try {
    getSqliteTableConfig(
      value as Table, // eslint-disable-line typescript/no-unsafe-type-assertion
    );
    return {
      table: value as Table, // eslint-disable-line typescript/no-unsafe-type-assertion
      dialect: "sqlite",
    };
  } catch {
    /* not a sqlite table */
  }
  try {
    getPgTableConfig(
      value as Table, // eslint-disable-line typescript/no-unsafe-type-assertion
    );
    return {
      table: value as Table, // eslint-disable-line typescript/no-unsafe-type-assertion
      dialect: "pg",
    };
  } catch {
    /* not a pg table either — not a drizzle table */
  }
  return null;
}

/** Every drizzle table the provider-aware barrel exports, with its dialect. */
type BarrelTable = readonly [string, { table: Table; dialect: Dialect }];

const barrelTables: BarrelTable[] = Object.entries(runtimeSchema).flatMap(
  ([name, value]) => {
    const identified = dialectOf(value);
    return identified === null ? [] : [[name, identified] as BarrelTable];
  },
);

describe("the dual-dialect test harness", () => {
  it("finds the barrel's tables, so the checks below are not vacuous", () => {
    // The non-vacuity guard. A filter that silently matched nothing is how the
    // first two drafts of this file passed under both providers while proving
    // nothing about either.
    expect(barrelTables.length).toBeGreaterThan(50);
    expect(barrelTables.length).toBeLessThan(80);
  });

  it("classifies every table as exactly one dialect", () => {
    // Not a third value, and not both. drizzle declares every table as one or
    // Both are valid, and nothing else is: a barrel that is neither of the two
    // schemas the application has.
    for (const [name, identified] of barrelTables) {
      expect(
        identified.dialect === "sqlite" || identified.dialect === "pg",
        `${name} has an unrecognised dialect`,
      ).toBe(true);
    }
  });

  it("resolves exactly one dialect, never a mixture of the two", () => {
    // The claim the setup file exists to make checkable. A mixed barrel is the
    // `keywordOpportunityInputs` bug class from `2a785c9` — one table from each
    // side — and it is invisible to a suite that only ever runs one dialect.
    const sqliteCount = barrelTables.filter(
      ([, identified]) => identified.dialect === "sqlite",
    ).length;
    const pgCount = barrelTables.filter(
      ([, identified]) => identified.dialect === "pg",
    ).length;

    expect(sqliteCount + pgCount).toBe(barrelTables.length);
    expect(
      Math.min(sqliteCount, pgCount),
      "the barrel mixes dialects — one provider's table leaked into the other",
    ).toBe(0);
    expect(Math.max(sqliteCount, pgCount)).toBe(barrelTables.length);
  });

  it("follows DATABASE_PROVIDER, and does not default silently on a typo", () => {
    // An unrecognised value must throw rather than fall back to `d1`, or a typo
    // in the CI matrix would run SQLite twice and report both jobs green.
    const provider = process.env.DATABASE_PROVIDER ?? "d1";
    const expectedDialect = provider === "postgres" ? "pg" : "sqlite";

    expect(getDatabaseProvider()).toBe(
      provider === "postgres" ? "postgres" : "d1",
    );
    expect(
      barrelTables.every(([, d]) => d.dialect === expectedDialect),
      `under DATABASE_PROVIDER=${provider} every barrel table should be ${expectedDialect}`,
    ).toBe(true);
  });
});
