/**
 * The markup dial's resolution order, against a real database.
 *
 * ## Why a real table
 *
 * The point of moving the multiplier out of code is that the operator's row
 * beats the env binding, which beats no markup at all. That is a precedence
 * rule, and a precedence rule proven with a mocked query builder proves
 * nothing: the mock returns whatever the test told it to, so the one thing
 * under test — which source is consulted — is exactly the thing the mock
 * replaced. The mock therefore has to be the database's *transport*, not its
 * answers, which is what the in-memory SQLite below is.
 *
 * ## What the order protects
 *
 * A value set in the admin area that silently stops applying the moment
 * anyone touches the deployment's environment is a dial that does not work,
 * and nothing would say so — the hosted service would just quietly bill at a
 * different rate than the owner chose.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type * as CostMarkupModule from "./costMarkup";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let mod: typeof CostMarkupModule;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);

  // `billing_config.updated_by_user_id` references `user(id)`, so the table it
  // points at has to exist for the foreign key to be created — a real database
  // enforces the constraint the schema declares, and a mocked one does not.
  await client.executeMultiple(`
    CREATE TABLE user (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, email_verified integer NOT NULL DEFAULT 0, created_at text NOT NULL DEFAULT (current_timestamp), updated_at text NOT NULL DEFAULT (current_timestamp));
    CREATE TABLE billing_config (
      key text PRIMARY KEY NOT NULL,
      value text NOT NULL,
      updated_by_user_id text,
      updated_at text DEFAULT (current_timestamp) NOT NULL,
      FOREIGN KEY (updated_by_user_id) REFERENCES user(id) ON UPDATE no action ON DELETE set null
    );
  `);

  // **Mocked before the module under test is imported**, and only the
  // transport. `vi.doMock` applies to modules loaded afterwards, so a static
  // import of `./costMarkup` here would bind the real `@/db` first and this
  // whole file would exercise the production binding instead.
  vi.doMock("@/db", () => ({ db: testDb }));

  mod = await import("./costMarkup");
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.execute("DELETE FROM billing_config");
  delete process.env[mod.COST_MARKUP_ENV_VAR];
});

// A fresh deployment with nothing configured charges the raw vendor rate. The
// default earns nothing on purpose: a default that earns money is a margin
// nobody chose, sitting in an MIT-licensed repository.
it("falls back to no markup", async () => {
  expect(await mod.resolveCostMarkup()).toBe(mod.NO_MARKUP);
  expect(await mod.describeCostMarkup()).toEqual({
    markup: mod.NO_MARKUP,
    source: "default",
  });
});

it("uses the env binding when there is no operator row", async () => {
  process.env[mod.COST_MARKUP_ENV_VAR] = "1.5";
  expect(await mod.resolveCostMarkup()).toBe(1.5);
  expect((await mod.describeCostMarkup()).source).toBe("environment");
});

it("prefers the operator's row over the env binding", async () => {
  process.env[mod.COST_MARKUP_ENV_VAR] = "1.5";
  await mod.setConfiguredCostMarkupOverride({ markup: 2 });
  expect(await mod.resolveCostMarkup()).toBe(2);
  expect((await mod.describeCostMarkup()).source).toBe("operator");
});

it("round-trips the override and clears it back to the env value", async () => {
  await mod.setConfiguredCostMarkupOverride({ markup: 1.75 });
  expect(await mod.getConfiguredCostMarkupOverride()).toBe(1.75);

  await mod.setConfiguredCostMarkupOverride({ markup: null });
  expect(await mod.getConfiguredCostMarkupOverride()).toBeNull();

  process.env[mod.COST_MARKUP_ENV_VAR] = "1.25";
  expect(await mod.resolveCostMarkup()).toBe(1.25);
});

it("records who changed the dial", async () => {
  // The foreign key is real, so the actor has to exist — which is also the
  // point: an audit column that does not reference anyone records nothing.
  await client.execute({
    sql: "INSERT INTO user (id, name, email) VALUES (?, ?, ?)",
    args: ["user_admin", "Admin", "admin@example.com"],
  });
  await mod.setConfiguredCostMarkupOverride({
    markup: 1.4,
    updatedByUserId: "user_admin",
  });
  const rows = await client.execute(
    "SELECT key, value, updated_by_user_id FROM billing_config",
  );
  expect(rows.rows[0]).toMatchObject({
    key: mod.COST_MARKUP_CONFIG_KEY,
    value: "1.4",
    updated_by_user_id: "user_admin",
  });
});

// The column default fires on INSERT and never on the UPDATE half of an upsert,
// so an explicit value is the only thing that makes this column mean "when the
// dial moved" rather than "when the dial was first written". CodeRabbit caught
// the omission; the row would have kept its insert timestamp forever.
it("moves the timestamp when the dial changes, and the actor with it", async () => {
  // Both actors, because the foreign key is real. The column records who made
  // the change, so a change attributed to a user who does not exist is not a
  // record of anything.
  await client.executeMultiple(`
    INSERT INTO user (id, name, email) VALUES ('user_first', 'First', 'first@example.com');
    INSERT INTO user (id, name, email) VALUES ('user_second', 'Second', 'second@example.com');
  `);
  await mod.setConfiguredCostMarkupOverride({
    markup: 1.4,
    updatedByUserId: "user_first",
  });
  const before = await readUpdatedAt();
  expect(before).not.toBeNull();

  // A timestamp written by the same clock one millisecond later is the
  // smallest difference the column is able to represent, and the smallest one
  // that still proves the value is not frozen.
  await sleep(2);
  await mod.setConfiguredCostMarkupOverride({
    markup: 1.75,
    updatedByUserId: "user_second",
  });
  const after = await readUpdatedAt();
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);

  // And the actor, for the same reason — an audit row with the right timestamp
  // and the wrong person attributes the change to somebody else.
  const rows = await client.execute(
    "SELECT updated_by_user_id FROM billing_config",
  );
  expect(rows.rows[0]?.updated_by_user_id).toBe("user_second");
});

/**
 * The raw value of `updated_at`, whatever the driver hands back.
 *
 * The value is only ever compared for change, so its exact runtime type does
 * not matter — and reading it as `unknown` rather than through `String()` avoids
 * both no-base-to-string, which flags stringifying a value the type system
 * cannot vouch for, and pretending to know a type the untyped SQL path does not
 * give us.
 */
async function readUpdatedAt(): Promise<unknown> {
  const rows = await client.execute({
    sql: "SELECT updated_at FROM billing_config WHERE key = ?",
    args: [mod.COST_MARKUP_CONFIG_KEY],
  });
  return rows.rows[0]?.updated_at ?? null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A row holding garbage must fail loudly. Swallowing it would fall through to
// no markup — the one failure mode this design exists to avoid, because a
// charge that never happened looks exactly like a free product.
it("refuses an unusable stored value instead of silently charging nothing", async () => {
  await client.execute({
    sql: "INSERT INTO billing_config (key, value) VALUES (?, ?)",
    args: [mod.COST_MARKUP_CONFIG_KEY, "not-a-number"],
  });
  await expect(mod.getConfiguredCostMarkupOverride()).rejects.toThrow(
    /not a usable multiplier/,
  );
  await expect(mod.resolveCostMarkup()).rejects.toThrow();
});

it("refuses to write an unusable value in the first place", async () => {
  await expect(
    mod.setConfiguredCostMarkupOverride({ markup: 0 }),
  ).rejects.toThrow(/above zero/);
  expect(await mod.getConfiguredCostMarkupOverride()).toBeNull();
});
