import { readFileSync } from "node:fs";
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTUMN_PAID_PLAN_ID } from "@/shared/billing";
import type { syncAutumnCustomerStatus as syncType } from "./customer-status-sync";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const { autumnMock, loopsSyncMock } = vi.hoisted(() => ({
  autumnMock: { customers: { getOrCreate: vi.fn() } },
  loopsSyncMock: vi.fn(),
}));

vi.mock("@/server/billing/autumn", () => ({ autumn: autumnMock }));
vi.mock("@/server/billing/loops-sync", () => ({
  syncBillingStatusToLoops: loopsSyncMock,
}));

/**
 * The funnel's paid stage must fire on the transition, not on the sync (A9).
 *
 * Svix retries every non-2xx and webhooks arrive out of order; the row
 * upsert converges either way, but an event fired per sync would count one
 * conversion per retry. Real in-memory SQLite with the real billing-status
 * migrations — the claim is about rows, so rows are what is asserted.
 *
 * The subject loads dynamically after the doMock calls: a static import would
 * bind the real `@/db` before the in-memory double replaces it.
 */
let client: Client;
let syncAutumnCustomerStatus: typeof syncType;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  const runMigration = async (name: string) => {
    const sql = readFileSync(`drizzle/${name}`, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.includes("DROP TABLE")) continue;
      await client.execute(statement);
    }
  };
  // The status row references organization: the table must exist for the
  // child CREATE to plan, even with FK enforcement off.
  await client.execute("CREATE TABLE organization (id text PRIMARY KEY)");
  for (const org of ["org_1", "org_2", "org_3"]) {
    await client.execute({
      sql: "INSERT INTO organization (id) VALUES (?)",
      args: [org],
    });
  }
  await runMigration("0021_autumn_billing.sql");
  await runMigration("0023_sad_cobalt_man.sql");
  syncAutumnCustomerStatus = (await import("./customer-status-sync"))
    .syncAutumnCustomerStatus;
});

afterAll(() => {
  client.close();
});

function payingCustomer(id: string) {
  return {
    id,
    subscriptions: [{ planId: AUTUMN_PAID_PLAN_ID, status: "active" }],
  };
}

function freeCustomer(id: string) {
  return {
    id,
    subscriptions: [{ planId: "free", status: "active" }],
  };
}

describe("syncAutumnCustomerStatus planChanged", () => {
  it("fires on the first paying sync, not on the replay", async () => {
    autumnMock.customers.getOrCreate.mockResolvedValue(payingCustomer("org_1"));
    expect((await syncAutumnCustomerStatus("org_1")).planChanged).toBe(true);
    expect((await syncAutumnCustomerStatus("org_1")).planChanged).toBe(false);
  });

  it("stays silent on downgrades and scheduled plans", async () => {
    autumnMock.customers.getOrCreate.mockResolvedValue(payingCustomer("org_2"));
    expect((await syncAutumnCustomerStatus("org_2")).planChanged).toBe(true);
    autumnMock.customers.getOrCreate.mockResolvedValue(freeCustomer("org_2"));
    expect((await syncAutumnCustomerStatus("org_2")).planChanged).toBe(false);
    autumnMock.customers.getOrCreate.mockResolvedValue({
      id: "org_2",
      subscriptions: [{ planId: AUTUMN_PAID_PLAN_ID, status: "scheduled" }],
    });
    expect((await syncAutumnCustomerStatus("org_2")).planChanged).toBe(false);
  });

  it("fires when a free org becomes paying", async () => {
    autumnMock.customers.getOrCreate.mockResolvedValue(freeCustomer("org_3"));
    expect((await syncAutumnCustomerStatus("org_3")).planChanged).toBe(false);
    autumnMock.customers.getOrCreate.mockResolvedValue(payingCustomer("org_3"));
    expect((await syncAutumnCustomerStatus("org_3")).planChanged).toBe(true);
  });
});
