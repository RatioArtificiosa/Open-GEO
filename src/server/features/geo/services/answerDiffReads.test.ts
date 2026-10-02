import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { getAnswerDiff as GetAnswerDiff } from "./answerDiffReads";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let getAnswerDiff: typeof GetAnswerDiff;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: unknown) => unknown[]) => {
      for (const s of build(testDb)) await s;
    },
  }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text);`,
      ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
      ...readFileSync("drizzle/0057_geo_acquisition_mode.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => !s.includes("DROP TABLE")),
    ].join("\n"),
  );

  getAnswerDiff = (await import("./answerDiffReads")).getAnswerDiff;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM geo_answer_citations; DELETE FROM geo_answer_retrievals; DELETE FROM geo_answers; DELETE FROM geo_snapshot_answers; DELETE FROM geo_snapshots; DELETE FROM geo_prompts; DELETE FROM geo_prompt_sets; DELETE FROM geo_targets; DELETE FROM projects;",
  );
  await client.execute("INSERT INTO projects (id, name) VALUES ('p1', 'Acme')");
  await client.execute(
    `INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at)
     VALUES ('t1', 'p1', 'Acme', 'acme.com', 2840, 'en', '2026-01-01 00:00:00')`,
  );
});

/** One archived answer, with optional citations. */
async function seedAnswer(
  id: string,
  prompt: string,
  answeredAt: string,
  citations: Array<{ url: string; rank: number | null }> = [],
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO geo_answers
            (id, project_id, target_id, prompt, answer_text, platform, source,
             location_code, language_code, answered_at, created_at)
          VALUES (?, 'p1', 't1', ?, 'an answer', 'chat_gpt', 'llm_responses', 2840, 'en', ?, ?)`,
    args: [id, prompt, answeredAt, answeredAt],
  });
  for (const [i, c] of citations.entries()) {
    await client.execute({
      sql: `INSERT INTO geo_answer_citations (answer_id, url, domain, title, rank)
            VALUES (?, ?, ?, 'T', ?)`,
      args: [id, c.url, c.url.split("/")[2] ?? null, c.rank ?? i + 1],
    });
  }
}

const BASE = { projectId: "p1", domain: "acme.com", platform: "chat_gpt" };

/**
 * The moat, read from the archive.
 *
 * `diffAnswers` has been built and tested since CL-209 and had no caller, so every
 * one of its tests passed against a pair **a test built by hand**. These go through
 * the reader instead, because the reader is where the defect lived: a pure function
 * tested in isolation cannot see that nothing assembles its input from the archive,
 * which is the same reason the evidence drawer's numbers were unfalsifiable.
 */
describe("getAnswerDiff", () => {
  it("names what was lost and what was gained between two captures", async () => {
    await seedAnswer("a1", "best crm", "2026-09-01T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
      { url: "https://hubspot.com/compare", rank: 2 },
    ]);
    await seedAnswer("a2", "best crm", "2026-09-08T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
      { url: "https://g2.com/acme", rank: 2 },
    ]);

    const result = await getAnswerDiff({ ...BASE, prompt: "best crm" });

    expect(result.diff).not.toBeNull();
    const kinds = result.diff?.changes.map((c) => `${c.kind}:${c.url}`);
    // **The loss leads**, because a loss is a regression someone can act on while a
    // gain may be a result the model simply had not seen.
    expect(kinds?.[0]).toBe("lost:hubspot.com/compare");
    expect(kinds).toContain("gained:g2.com/acme");
    expect(result.diff?.summary).toMatch(/dropped/i);
    // And the reader is told how many captures exist, which is more than the two
    // compared — "based on 2 of 26" reads like the project has two.
    expect(result.capturesAvailable).toBe(2);
  });

  it("refuses on a single capture rather than reporting no change", async () => {
    // The distinction the moat turns on. "Only one capture exists" and "nothing
    // changed" are different sentences, and for a project on its first night the
    // first is the normal state.
    await seedAnswer("a1", "best crm", "2026-09-01T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
    ]);

    const result = await getAnswerDiff({ ...BASE, prompt: "best crm" });

    expect(result.diff).toBeNull();
    expect(result.noDiffReason).toMatch(/only one capture/i);
    expect(result.noDiffReason).not.toMatch(/no change|unchanged|stable/i);
    // The caveat travels even with no diff, because the *next* one will have one.
    expect(result.caveat).toMatch(/not why/i);
  });

  it("says so when nothing has been archived at all", async () => {
    const result = await getAnswerDiff({ ...BASE, prompt: "never asked" });

    expect(result.diff).toBeNull();
    expect(result.noDiffReason).toMatch(/no answer/i);
  });

  it("compares the pair the caller names, not the latest two", async () => {
    // The reproducibility claim. Defaulting to "the latest two" would silently
    // change the question whenever a capture lands between render and click.
    await seedAnswer("a1", "best crm", "2026-09-01T00:00:00.000Z", [
      { url: "https://old.example/a", rank: 1 },
    ]);
    await seedAnswer("a2", "best crm", "2026-09-08T00:00:00.000Z", [
      { url: "https://mid.example/a", rank: 1 },
    ]);
    await seedAnswer("a3", "best crm", "2026-09-15T00:00:00.000Z", [
      { url: "https://new.example/a", rank: 1 },
    ]);

    const latest = await getAnswerDiff({ ...BASE, prompt: "best crm" });
    // `before` / `after`, not `from` / `to` — the first version of this test
    // asserted `from` and failed with `expected undefined to be
    // '2026-09-08...'`, which is the test guessing a shape rather than reading it.
    expect(latest.diff?.before.answeredAt).toBe("2026-09-08T00:00:00.000Z");
    expect(latest.diff?.after.answeredAt).toBe("2026-09-15T00:00:00.000Z");

    const pinned = await getAnswerDiff({
      ...BASE,
      prompt: "best crm",
      afterId: "a2",
    });
    expect(pinned.diff?.before.answeredAt).toBe("2026-09-01T00:00:00.000Z");
    expect(pinned.diff?.after.answeredAt).toBe("2026-09-08T00:00:00.000Z");
  });

  it("reports a moved citation as a move, not as a loss and a gain", async () => {
    // Without a rank the diff collapses to a set difference and reports half of
    // what it saw: a page that dropped from 1st to 3rd is not two findings.
    await seedAnswer("a1", "best crm", "2026-09-01T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
      { url: "https://hubspot.com/compare", rank: 2 },
    ]);
    await seedAnswer("a2", "best crm", "2026-09-08T00:00:00.000Z", [
      { url: "https://hubspot.com/compare", rank: 1 },
      { url: "https://acme.com/pricing", rank: 2 },
    ]);

    const result = await getAnswerDiff({ ...BASE, prompt: "best crm" });

    const moved = result.diff?.changes.filter((c) => c.kind === "moved") ?? [];
    expect(moved).toHaveLength(2);
    expect(result.diff?.changes.some((c) => c.kind === "lost")).toBe(false);
    expect(result.diff?.changes.some((c) => c.kind === "gained")).toBe(false);
  });

  it("keeps an unpositioned citation out of the moved set", async () => {
    // CL-205 keeps an annotation with no marker and labels it, because a source the
    // vendor reported is evidence. A null rank means *we were never told where it
    // sat*, which is not "it was first" — falling back to the array index would
    // invent a position and report a page as having moved when nothing moved.
    await seedAnswer("a1", "best crm", "2026-09-01T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
      { url: "https://nowhere.example/x", rank: null },
    ]);
    await seedAnswer("a2", "best crm", "2026-09-08T00:00:00.000Z", [
      { url: "https://acme.com/pricing", rank: 1 },
      { url: "https://nowhere.example/x", rank: null },
    ]);

    const result = await getAnswerDiff({ ...BASE, prompt: "best crm" });

    expect(result.diff?.changes).toEqual([]);
    expect(result.diff?.summary).toMatch(/stable|same/i);
  });
});
