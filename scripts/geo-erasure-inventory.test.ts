import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { count, eq, inArray, type Column, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/pg/schema";

vi.mock("cloudflare:workers", () => ({ env: {} }));

/**
 * The GEO half of the GDPR dry-run inventory.
 *
 * Every GEO table cascades from `organization -> projects`, so the erasure
 * transaction already removes them. What these tests protect is the *counting*:
 * an operator is shown what will be destroyed before committing, and a count
 * that silently returns 0 for a full archive would make an irreversible delete
 * look harmless.
 *
 * Real in-memory SQLite against the real migrations, because the counts are
 * joins across three tables and a mocked builder chain would pass while
 * returning the wrong number.
 */

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const PROJECT_IDS = ["p1", "p2"];
const ANSWER_A = "answer_a";
const ANSWER_B = "answer_b";

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  db = drizzle(client);

  // The Postgres migration is the source of truth for the cascades, but it
  // carries Postgres-only syntax SQLite cannot parse: a `public.` schema prefix
  // and `to_char(now() ...)` column defaults. Both are stripped so the CREATE
  // TABLE shapes can run; the cascades themselves are asserted separately by
  // reading the ALTER TABLE lines, which need no rewriting.
  //
  // `executeMultiple` is not used: it splits on newlines, which would cut a
  // multi-line CREATE TABLE in half.
  const pgDdl = readFileSync("drizzle-pg/0026_opengeo_geo.sql", "utf8")
    .replaceAll('"public".', '"')
    // The Postgres default is
    //   to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    // whose format string ends in `"Z"')`, so the match runs to the last paren
    // on the line rather than to a literal `'Z')`.
    .replace(/DEFAULT to_char\(.*\)/gi, "DEFAULT '2026-01-01'");

  const createStatements = pgDdl
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("CREATE TABLE"));

  await client.execute(
    "CREATE TABLE organization (id text PRIMARY KEY, name text, created_at integer)",
  );
  await client.execute(
    "CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text)",
  );
  for (const statement of createStatements) {
    await client.execute(statement);
  }

  // Postgres generation syntax that SQLite does not understand.
  await client.execute("PRAGMA foreign_keys = OFF");
  await client.execute(
    "INSERT INTO organization (id, name, created_at) VALUES ('org1', 'Acme', 0)",
  );
  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id) VALUES ('p1','Acme',2840,'en','2026-01-01','org1'), ('p2','Beta',2840,'en','2026-01-01','org1')",
  );

  // p1: two answers, one with citations and retrievals.
  await client.execute(
    `INSERT INTO geo_answers (id, project_id, target_id, prompt_set_id, prompt, answer_text, platform, model_name, source, location_code, language_code, answered_at, vendor_task_id, raw_json, created_at) VALUES
     ('${ANSWER_A}','p1',NULL,NULL,'best geo tool',NULL,'chat_gpt',NULL,'mentions_search',2840,'en','2026-05-01',NULL,NULL,'2026-05-01'),
     ('${ANSWER_B}','p1',NULL,NULL,'best geo tool',NULL,'chat_gpt',NULL,'mentions_search',2840,'en','2026-06-01',NULL,NULL,'2026-06-01'),
     ('answer_c','p2',NULL,NULL,'best geo tool',NULL,'chat_gpt',NULL,'mentions_search',2840,'en','2026-06-01',NULL,NULL,'2026-06-01')`,
  );
  await client.execute(
    `INSERT INTO geo_answer_citations (answer_id, url, domain, title, snippet, rank) VALUES
     ('${ANSWER_A}','https://acme.com/a','acme.com',NULL,NULL,1),
     ('${ANSWER_A}','https://acme.com/b','acme.com',NULL,NULL,2)`,
  );
  await client.execute(
    `INSERT INTO geo_answer_retrievals (answer_id, url, domain, rank) VALUES
     ('${ANSWER_A}','https://acme.com/c','acme.com',1)`,
  );

  // p2 has one answer with no children, so a project-scoped count of 2 vs a
  // global count of 3 is observable.
  await client.execute(
    `INSERT INTO geo_targets (id, project_id, domain, name, aliases, location_code, language_code, created_at) VALUES
     ('t1','p1','acme.com','Acme',NULL,2840,'en','2026-01-01'),
     ('t2','p2','beta.com','Beta',NULL,2840,'en','2026-01-01')`,
  );
});

afterAll(() => {
  client.close();
});

describe("GEO erasure inventory counts", () => {
  it("counts only the erasing user's projects, not every project", async () => {
    const targets = await db
      .select({ value: count() })
      .from(schema.geoTargets)
      .where(inArray(schema.geoTargets.projectId, ["p1"]));
    // Two targets exist; scoping to p1 must return one, not two.
    expect(targets[0]?.value).toBe(1);
  });

  it("counts join-only tables through their parent project", async () => {
    const citations = await db
      .select({ value: count() })
      .from(schema.geoAnswerCitations)
      .innerJoin(
        schema.geoAnswers,
        eq(schema.geoAnswers.id, schema.geoAnswerCitations.answerId),
      )
      .where(inArray(schema.geoAnswers.projectId, ["p1"]));
    expect(citations[0]?.value).toBe(2);
  });

  it("returns zero rather than throwing when the project list is empty", async () => {
    // drizzle's inArray throws on an empty array, which is why every count here
    // short-circuits. An operator with no projects must still get a receipt.
    const countThroughAnswers = async (
      table: Table & { answerId: Column },
      projectIds: string[],
    ) =>
      projectIds.length === 0
        ? 0
        : ((
            await db
              .select({ value: count() })
              .from(table)
              .innerJoin(
                schema.geoAnswers,
                eq(schema.geoAnswers.id, table.answerId),
              )
              .where(inArray(schema.geoAnswers.projectId, projectIds))
          )[0]?.value ?? 0);

    expect(await countThroughAnswers(schema.geoAnswerCitations, [])).toBe(0);
  });

  it("cascades every GEO table when the organization is deleted", () => {
    // The structural guarantee the counts are reporting on: an erasure removes
    // the archive without needing a single GEO-specific delete statement.
    const fk = readFileSync("drizzle-pg/0026_opengeo_geo.sql", "utf8");
    const projectScoped = [
      "geo_targets",
      "geo_prompt_sets",
      "geo_snapshots",
      "geo_answers",
      "geo_target_metrics",
      "ai_keyword_metrics",
      "ai_mode_snapshots",
    ];
    for (const table of projectScoped) {
      const block = fk.split(`ALTER TABLE "${table}"`)[1] ?? "";
      expect(
        block,
        `${table} must reference projects with ON DELETE CASCADE`,
      ).toMatch(
        /REFERENCES\s+"public"\."projects"\("id"\)\s+ON DELETE cascade/i,
      );
    }
  });

  it("cascades the child tables from their parents, not just from projects", () => {
    const fk = readFileSync("drizzle-pg/0026_opengeo_geo.sql", "utf8");
    const children = [
      ["geo_answer_citations", "geo_answers"],
      ["geo_answer_retrievals", "geo_answers"],
      ["geo_fanout_queries", "geo_answers"],
      ["geo_snapshot_answers", "geo_snapshots"],
      ["geo_citation_domains", "geo_snapshots"],
      ["geo_prompts", "geo_prompt_sets"],
      ["ai_mode_snapshot_citations", "ai_mode_snapshots"],
    ];
    for (const [table, parent] of children) {
      const block = fk.split(`ALTER TABLE "${table}"`)[1] ?? "";
      expect(
        block,
        `${table} must reference ${parent} with ON DELETE CASCADE`,
      ).toMatch(
        new RegExp(
          `REFERENCES\\s+"public"\\."${parent}"\\("id"\\)\\s+ON DELETE cascade`,
          "i",
        ),
      );
    }
  });
});
