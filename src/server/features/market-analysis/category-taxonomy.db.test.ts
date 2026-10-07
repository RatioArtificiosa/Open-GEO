/**
 * The taxonomy read against a real database.
 *
 * ## Why a real database and not a stubbed one
 *
 * The claim being tested is *which rows come back for a set of ids*, and that claim lives in SQL:
 * an `in` clause over the right column, and a guard that keeps an empty id list from generating
 * `in ()`, which SQLite rejects. A query-builder stub returns whatever it was told to return, so
 * it can confirm a mapping and say nothing at all about the query.
 *
 * ## The guard is the interesting half
 *
 * `findCategoryNames([])` is reachable in normal use: a domain that ranks nowhere returns items
 * with no categories, so the caller collects zero ids. Without the guard that is a failed request
 * rather than an empty profile, which is why it is asserted here rather than left to inspection.
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { findCategoryNames as FindCategoryNames } from "./category-taxonomy";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let findCategoryNames: typeof FindCategoryNames;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);

  await client.executeMultiple(
    [
      // Read as a literal, so renaming the migration fails here rather than in production.
      readFileSync("drizzle/0060_labs_categories.sql", "utf8"),
    ].join("\n"),
  );

  vi.doMock("@/db", () => ({ db: testDb }));
  findCategoryNames = (await import("./category-taxonomy")).findCategoryNames;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM category_taxonomy");
});

async function seed(rows: Array<[number, string]>) {
  const values = rows.map(([id, path]) => `(${id}, '${path}')`).join(", ");
  await client.execute(
    `INSERT INTO category_taxonomy (criterion_id, path) VALUES ${values}`,
  );
}

describe("findCategoryNames", () => {
  it("resolves the ids it has", async () => {
    await seed([
      [10007, "/Computers/Software"],
      [13418, "/Business/Printing, Copying & Mailing"],
    ]);

    const names = await findCategoryNames([10007, 13418]);

    expect(names.get(10007)).toBe("/Computers/Software");
    expect(names.get(13418)).toBe("/Business/Printing, Copying & Mailing");
  });

  it("omits an id the taxonomy does not have, rather than inventing a name", async () => {
    // Absence is the signal the caller uses to keep the category with `name: null`. A fallback
    // like `String(id)` here would look helpful and would put a fake label in a customer's
    // profile.
    await seed([[10007, "/Computers/Software"]]);

    const names = await findCategoryNames([10007, 99999]);

    expect(names.has(10007)).toBe(true);
    expect(names.has(99999)).toBe(false);
    expect(names.size).toBe(1);
  });

  it("returns nothing for an empty id list instead of failing the query", async () => {
    // `inArray([])` renders `in ()`, which SQLite rejects with a syntax error. A domain that
    // ranks in no categories reaches this path, so it must be an empty answer and not a 500.
    await seed([[10007, "/Computers/Software"]]);

    const names = await findCategoryNames([]);

    expect(names.size).toBe(0);
  });

  it("de-duplicates the ids it is asked for", async () => {
    await seed([[10007, "/Computers/Software"]]);

    const names = await findCategoryNames([10007, 10007, 10007]);

    expect(names.size).toBe(1);
  });
});
