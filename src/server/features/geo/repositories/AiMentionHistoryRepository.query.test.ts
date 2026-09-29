import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

/**
 * The monthly mentions series.
 *
 * Two behaviours here are load-bearing and both are invisible in a unit test
 * with a mocked builder, so this runs against real SQLite and the real DDL:
 *
 * 1. **Month keys are zero-padded.** An un-padded `2026-1` sorts *before*
 *    `2025-12` as text, which would scramble the series in exactly the way a
 *    user would not notice.
 * 2. **The window is replaced, not merged.** The vendor revises history and can
 *    withdraw a month. Upserting row by row would leave a withdrawn month in the
 *    chart forever, showing data the vendor no longer claims.
 */

const { db: repoDb } = await import("@/db");
const { aiMentionHistory } = await import("@/db/schema");
const { AiMentionHistoryRepository } =
  await import("@/server/features/geo/repositories/AiMentionHistoryRepository");

// The module imports `db` from `@/db`, so point that at the in-memory client
// before anything else touches it. The client is held in a module-level binding
// rather than stashed on `globalThis`, so `afterAll` can close it without a cast.
let testClient: ReturnType<typeof createClient> | null = null;

beforeAll(async () => {
  const client = createClient({ url: "file::memory:" });
  testClient = client;
  const schema = drizzle(client);

  await client.execute(
    "CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text)",
  );
  await client.execute(
    `CREATE TABLE geo_targets (id text PRIMARY KEY, project_id text NOT NULL, domain text NOT NULL, name text NOT NULL, aliases text, location_code integer NOT NULL, language_code text NOT NULL, created_at text NOT NULL)`,
  );
  await client.execute(
    readFileSync("drizzle/0050_bumpy_bloodstrike.sql", "utf8")
      .replace("--> statement-breakpoint", ";")
      .replaceAll(/`/g, '"'),
  );
  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id) VALUES ('p1','Acme',2840,'en','2026-01-01','org1')",
  );
  await client.execute(
    "INSERT INTO geo_targets (id, project_id, domain, name, location_code, language_code, created_at) VALUES ('t1','p1','acme.com','Acme',2840,'en','2026-01-01')",
  );

  Object.assign(repoDb, schema);
});

afterAll(() => {
  testClient?.close();
});

const WINDOW = {
  projectId: "p1",
  targetId: "t1",
  platform: "chat_gpt" as const,
  locationCode: 2840,
  languageCode: "en",
  fromMonth: "2025-08",
  toMonth: "2026-06",
  capturedAt: "2026-09-28T00:00:00.000Z",
};

function month(year: number, m: number, mentions: number) {
  return {
    year,
    month: m,
    metrics: { mentions, ai_search_volume: mentions * 100 },
  };
}

async function clear(): Promise<void> {
  await repoDb.delete(aiMentionHistory);
}

describe("AiMentionHistoryRepository", () => {
  beforeEach(clear);

  it("zero-pads the month so the series sorts chronologically as text", async () => {
    // The trap: "2026-1" < "2025-12" as a string, so an unpadded key would put
    // January 2026 before December 2025 and the chart would zig-zag.
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2025, 12, 5), month(2026, 1, 6)],
    });
    const rows = await AiMentionHistoryRepository.listSeries(WINDOW);
    expect(rows.map((row) => row.month)).toEqual(["2025-12", "2026-01"]);
  });

  it("replaces the window rather than merging into it", async () => {
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2025, 12, 5), month(2026, 1, 6)],
    });
    // The vendor withdraws December and revises January.
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2026, 1, 9)],
    });
    const rows = await AiMentionHistoryRepository.listSeries(WINDOW);
    expect(rows.map((row) => row.month)).toEqual(["2026-01"]);
    // The revised value replaced the old one rather than sitting beside it.
    expect(rows[0]?.mentions).toBe(9);
  });

  it("stores null rather than zero when a metric is absent", async () => {
    // "No mentions recorded" and "zero mentions recorded" are different facts,
    // and collapsing them makes a brand vanish from a chart with no explanation.
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [
        {
          year: 2026,
          month: 3,
          metrics: { mentions: null, ai_search_volume: null },
        },
        { year: 2026, month: 4, metrics: { mentions: 0, ai_search_volume: 0 } },
      ],
    });
    const rows = await AiMentionHistoryRepository.listSeries(WINDOW);
    expect(rows[0]?.mentions).toBeNull();
    expect(rows[1]?.mentions).toBe(0);
  });

  it("drops a month outside the requested window", async () => {
    // The reference example returns one month before the documented history
    // floor. Storing it would put an unbounded series in a bounded table.
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2025, 7, 1), month(2026, 6, 3), month(2026, 12, 99)],
    });
    const rows = await AiMentionHistoryRepository.listSeries(WINDOW);
    expect(rows.map((row) => row.month)).toEqual(["2026-06"]);
  });

  it("keeps the two platforms apart", async () => {
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2026, 1, 10)],
    });
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      platform: "google_ai_overview",
      items: [month(2026, 1, 900)],
    });
    // Google and ChatGPT compute demand differently, so the same month holds two
    // different numbers and the two must never be summed into one series.
    const chatGpt = await AiMentionHistoryRepository.listSeries(WINDOW);
    const google = await AiMentionHistoryRepository.listSeries({
      ...WINDOW,
      platform: "google_ai_overview",
    });
    expect(chatGpt[0]?.mentions).toBe(10);
    expect(google[0]?.mentions).toBe(900);
  });

  it("returns oldest first, because that is the order a chart draws", async () => {
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2026, 3, 3), month(2025, 9, 1), month(2026, 1, 2)],
    });
    const rows = await AiMentionHistoryRepository.listSeries(WINDOW);
    expect(rows.map((row) => row.month)).toEqual([
      "2025-09",
      "2026-01",
      "2026-03",
    ]);
  });

  it("writes zero rows and does not throw when the vendor returns nothing", async () => {
    const written = await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [],
    });
    expect(written).toBe(0);
    expect(await AiMentionHistoryRepository.listSeries(WINDOW)).toEqual([]);
  });

  it("scopes every read to one project", async () => {
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2026, 1, 5)],
    });
    const otherProject = await AiMentionHistoryRepository.listSeries({
      ...WINDOW,
      projectId: "p_other",
    });
    expect(otherProject).toEqual([]);
  });

  it("requires the project, target, platform and market to match", async () => {
    await AiMentionHistoryRepository.replaceWindow({
      ...WINDOW,
      items: [month(2026, 1, 5)],
    });
    // A different market is a different series, even for the same target.
    const otherMarket = await AiMentionHistoryRepository.listSeries({
      ...WINDOW,
      locationCode: 2352,
    });
    expect(otherMarket).toEqual([]);
  });
});
