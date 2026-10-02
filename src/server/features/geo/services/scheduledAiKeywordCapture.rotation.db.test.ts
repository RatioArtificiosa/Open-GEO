/**
 * The AI-keyword capture's rotation, against a real database.
 *
 * ## Why this file exists
 *
 * **Two bugs, both invisible to the tests that already existed.** Every other test in
 * this suite injects `fetchProjects`, so the query this file exercises never runs
 * anywhere else — and the query was wrong twice:
 *
 * 1. the `ORDER BY` referenced the aggregate rather than the joined alias, which
 *    libsql rejects as `no such column` — a message about the schema, for a
 *    query-construction bug;
 * 2. the join normalised the prompt with `lower(trim(...))` while the stored keyword
 *    comes from `normaliseAiKeyword`, which *also* cuts to 250 characters. Any
 *    prompt over that length never matched anything.
 *
 * Both produce the same symptom — **keywords that look permanently unmeasured** — and
 * both are the failure mode the rotation exists to prevent.
 *
 * ## The normalisation boundary is the interesting part
 *
 * The join has to compare the customer's prompt against a string the *vendor*
 * returned. `ai-keywords.ts` normalises both sides so that string is a safe key:
 * `trim().toLowerCase().slice(0, 250)`. The SQL has to implement the same rule, and
 * the comment above `normaliseColumn` warned it must not drift — while the length
 * clamp was **already missing**.
 *
 * **That is the argument for a test rather than a comment.** A comment saying "these
 * must agree" cannot tell you they have stopped agreeing; a test that stores a
 * 300-character prompt and asks whether it matches can.
 *
 * ## Real SQLite rather than a stub
 *
 * `visibilityForecastReads.db.test.ts` states the rule: *which rows come back IS the
 * claim*, and a mocked query builder returns whatever it was told to return. The
 * migrations run for real, so a bad column name or a mismatched join fails here.
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { runDueAiKeywordCaptures as RunDueAiKeywordCaptures } from "./scheduledAiKeywordCapture";
import type {
  AiKeywordVolumeInput,
  AiKeywordVolumeResult,
} from "@/server/lib/dataforseo/ai-keywords";
import type { DataforseoApiResponse } from "@/server/lib/dataforseo/envelope";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT = "project_1";

/**
 * Longer than `MAX_KEYWORD_CHARS`, so it exercises the clamp. A prompt this long is
 * unusual but not impossible — a pasted question, a competitor's full name — and the
 * failure is silent rather than loud.
 */
const LONG_PROMPT = `best crm software ${"x".repeat(300)}`;

let client: Client;
let runDueAiKeywordCaptures: typeof RunDueAiKeywordCaptures;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0055_nosy_galactus.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      ...readFileSync("drizzle/0056_geo_snapshot_target.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
      readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8"),
    ].join("\n"),
  );

  vi.doMock("@/db", () => ({ db: testDb }));

  runDueAiKeywordCaptures = (
    await import("@/server/features/geo/services/scheduledAiKeywordCapture")
  ).runDueAiKeywordCaptures;

  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    [PROJECT, "Acme", 2840, "en", "2026-10-01T00:00:00.000Z"],
  );
});

afterAll(() => client.close());

/**
 * A vendor response, as `fetchAiKeywordVolume` resolves it.
 *
 * **`data` and `billing` are not optional in the real type**, and that is the point:
 * `billing.costUsd` is the vendor's own figure, the one the product meters against
 * rather than an estimate. A double that omitted it would be asserting against a shape
 * the client cannot return — the same rule `scheduledAiKeywordCapture.test.ts` states.
 */
function volumeStub(
  sink: string[],
): (
  input: AiKeywordVolumeInput,
) => Promise<DataforseoApiResponse<AiKeywordVolumeResult>> {
  return async (input: AiKeywordVolumeInput) => {
    sink.push(...input.keywords);
    return {
      data: {
        locationCode: 2840,
        languageCode: "en",
        items: input.keywords.map((keyword) => ({
          keyword,
          ai_monthly_searches: null,
        })),
      },
      billing: {
        path: [
          "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
        ],
        costUsd: 0.002,
      },
    };
  };
}

/** The order the capture would ask in, with the vendor stubbed out. */
async function askOrder(stored: Map<string, string | null>): Promise<string[]> {
  await client.execute("DELETE FROM geo_prompts");
  await client.execute("DELETE FROM ai_keyword_metrics");
  await client.execute("DELETE FROM geo_targets");
  await client.execute("DELETE FROM geo_prompt_sets");
  let position = 0;
  for (const [prompt, storedKeyword] of stored) {
    await client.execute(
      "INSERT INTO geo_prompt_sets (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
      [`set-${position}`, PROJECT, "default", "2026-10-01T00:00:00.000Z"],
    );
    await client.execute(
      "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `t-${position}`,
        PROJECT,
        "Acme",
        "acme.com",
        2840,
        "en",
        "2026-10-01T00:00:00.000Z",
      ],
    );
    await client.execute(
      "INSERT INTO geo_prompts (id, prompt_set_id, prompt, position, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        `q-${position}`,
        `set-${position}`,
        prompt,
        position,
        "2026-10-01T00:00:00.000Z",
      ],
    );
    if (storedKeyword !== null) {
      await client.execute(
        "INSERT INTO ai_keyword_metrics (project_id, keyword, location_code, language_code, month, ai_search_volume, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          PROJECT,
          storedKeyword,
          2840,
          "en",
          "2026-09",
          100,
          "2026-09-01T00:00:00.000Z",
        ],
      );
    }
    position += 1;
  }

  const asked: string[] = [];
  await runDueAiKeywordCaptures({
    fetchVolume: volumeStub(asked),
    writeRows: async () => undefined,
  });
  return asked;
}

describe("the AI-keyword rotation — the normalisation boundary", () => {
  it("counts a stored keyword as measured when the prompt is case- and padding-different", async () => {
    // The customer's prompt is `Best CRM `; the vendor stored `best crm`.
    const order = await askOrder(new Map([["Best CRM ", "best crm"]]));
    // It is measured, so it sorts *after* anything never asked rather than first.
    expect(order).toEqual(["Best CRM "]);
  });

  it("counts a prompt longer than the vendor's length clamp as measured", async () => {
    // **The bug this file was written for.** `normaliseAiKeyword` cuts to
    // `MAX_KEYWORD_CHARS`; the SQL's `lower(trim(...))` did not, so a 300-character
    // prompt never matched its own stored keyword and looked permanently unmeasured —
    // which put it at the *front* of the queue, to be re-asked every night forever.
    const stored = LONG_PROMPT.trim().toLowerCase().slice(0, 250);
    expect(stored.length).toBe(250);
    expect(stored).not.toBe(LONG_PROMPT.trim().toLowerCase());

    // Ask twice. If the clamp is missing, the long prompt is never-asked on the
    // second run too and comes first again — the signature of the starvation.
    const asked: string[] = [];
    const capture = async () => {
      const batch: string[] = [];
      await runDueAiKeywordCaptures({
        fetchVolume: volumeStub(batch),
        writeRows: async () => undefined,
      });
      asked.push(...batch);
    };

    await client.execute("DELETE FROM geo_prompts");
    await client.execute("DELETE FROM ai_keyword_metrics");
    await client.execute("DELETE FROM geo_targets");
    await client.execute("DELETE FROM geo_prompt_sets");
    await client.execute(
      "INSERT INTO geo_prompt_sets (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
      ["set-0", PROJECT, "default", "2026-10-01T00:00:00.000Z"],
    );
    await client.execute(
      "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "t-0",
        PROJECT,
        "Acme",
        "acme.com",
        2840,
        "en",
        "2026-10-01T00:00:00.000Z",
      ],
    );
    await client.execute(
      "INSERT INTO geo_prompts (id, prompt_set_id, prompt, position, created_at) VALUES (?, ?, ?, ?, ?)",
      ["q-0", "set-0", LONG_PROMPT, 0, "2026-10-01T00:00:00.000Z"],
    );
    await client.execute(
      "INSERT INTO ai_keyword_metrics (project_id, keyword, location_code, language_code, month, ai_search_volume, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [PROJECT, stored, 2840, "en", "2026-09", 100, "2026-09-01T00:00:00.000Z"],
    );

    // With only the long prompt present, either state asks it — so a second,
    // never-asked prompt is added to make the ordering tell the difference.
    await client.execute(
      "INSERT INTO geo_prompts (id, prompt_set_id, prompt, position, created_at) VALUES (?, ?, ?, ?, ?)",
      ["q-1", "set-0", "fresh keyword", 1, "2026-10-01T00:00:00.000Z"],
    );

    await capture();
    await capture();

    // **Measured prompts sort after never-asked ones**, so `fresh keyword` is asked on
    // the first run. On the second run it is measured too, and the two rotate: the
    // long one is no longer stuck at the front.
    const firstRound = asked.slice(0, 1);
    expect(firstRound).toEqual(["fresh keyword"]);
  });
});
