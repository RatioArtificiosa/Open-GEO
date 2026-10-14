/**
 * Migration `0065` — the key fix, and what it does to rows that are already there.
 *
 * ## Why this exists as a test at all
 *
 * A migration that changes a unique key is the one migration shape where a mistake is
 * invisible until it has already run somewhere: the `ALTER TABLE` succeeds, the indexes
 * rebuild, and the *first* symptom is either a silent drop or a foreign-key violation
 * on a table nobody is looking at. `0064` shipped a key without the brand, so two
 * monitored brands in one project collided on `(project, platform, model, day)` and the
 * second insert was dropped by `onConflictDoNothing` while the sweep reported success.
 * `0065` repairs the key; this file proves the repair is complete **and** that it does
 * not needlessly destroy the rows it repairs.
 *
 * ## The case the first draft got wrong
 *
 * The backfill's scalar subquery yields NULL for a project whose non-archived targets
 * number zero — an archived project, or one whose targets are all archived. Assigning
 * NULL into a NOT NULL column is a constraint error, so the original migration *aborted
 * the whole batch* rather than leaving those rows for the delete. Wrapping it in
 * COALESCE turns "nothing found" into the empty string the delete already removes, so
 * the batch completes and the delete decides. The archived-project case below is the
 * regression test for exactly that.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

describe("drizzle/0065: the forecast key now carries the brand", () => {
  it("reconstructs what the rows know and deletes only what is genuinely unknowable", async () => {
    const client = createClient({ url: "file::memory:" });

    await client.executeMultiple(
      [
        `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text, organization_id text, archived_at text);`,
        ...readFileSync("drizzle/0048_opengeo_geo.sql", "utf8")
          .split("--> statement-breakpoint")
          .filter((statement) => !statement.includes("DROP TABLE")),
        readFileSync("drizzle/0064_steady_fenris.sql", "utf8"),
      ].join(""),
    );

    /**
     * Three projects with deliberately different shapes.
     *
     * `p1` — **one brand in two markets.** Two `geo_targets` rows, one domain. The
     * point of the case is that "which brand" has one answer even though "which
     * target" has two, which is why the backfill counts `DISTINCT domain` and would
     * have deleted a perfectly good forecast had it counted rows.
     *
     * `p2` — **two brands.** Genuinely ambiguous: the domain was never recorded, and
     * any value here would be fabricated.
     *
     * `p3` — **one target, archived project.** The subquery must not write NULL, and
     * the row must not survive as unattributable either.
     */
    await client.execute(
      "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES ('p1', 'P1', 2840, 'en', '2026-01-01T00:00:00.000Z')",
    );
    await client.execute(
      "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES ('p2', 'P2', 2840, 'en', '2026-01-01T00:00:00.000Z')",
    );
    await client.execute(
      "INSERT INTO projects (id, name, location_code, language_code, created_at, archived_at) VALUES ('p3', 'P3', 2840, 'en', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
    );

    for (const [id, project, domain, location] of [
      ["t1", "p1", "acme.com", 2840],
      ["t2", "p1", "acme.com", 2124],
      ["t3", "p2", "b.com", 2840],
      ["t4", "p2", "c.com", 2840],
      ["t5", "p3", "x.com", 2840],
    ] as const) {
      await client.execute({
        sql: "INSERT INTO geo_targets (id, project_id, domain, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          id,
          project,
          domain,
          domain,
          location,
          "en",
          "2026-01-01T00:00:00.000Z",
        ],
      });
    }

    // The rows `0064`'s key made unresolvable: a `citation_win` row per brand (whose
    // subject *is* the domain, so the fix is a copy) and a `visibility_pace` row per
    // project (whose brand was never recorded).
    const insert = `INSERT INTO geo_forecast_snapshots
      (project_id, kind, subject, model_version, issued_on, horizon_days,
       share_bp, low_bp, high_bp, per_week_bp, now_bp, based_on,
       based_on_weeks, confidence, note, created_at)
      VALUES (?, ?, ?, ?, '2026-07-16', 90, 4000, 3000, 5000, 400, 3400, 40,
              12, 'moderate', NULL, '2026-07-16')`;

    await client.execute({
      sql: insert,
      args: ["p1", "citation_win", "acme.com", "forecast-v1"],
    });
    await client.execute({
      sql: insert,
      args: ["p2", "citation_win", "c.com", "forecast-v1"],
    });
    await client.execute({
      sql: insert,
      args: ["p1", "visibility_pace", "chat_gpt", "forecast-v1"],
    });
    await client.execute({
      sql: insert,
      args: ["p2", "visibility_pace", "chat_gpt", "forecast-v1"],
    });
    await client.execute({
      sql: insert,
      args: ["p3", "visibility_pace", "chat_gpt", "forecast-v1"],
    });

    // **The whole batch, in one call.** If any statement fails the migration is
    // half-applied, which is the shape this test is guarding against.
    await client.executeMultiple(
      readFileSync("drizzle/0065_swift_mercury.sql", "utf8"),
    );

    const rows = await client.execute(
      "SELECT project_id, kind, subject, domain FROM geo_forecast_snapshots ORDER BY kind, project_id",
    );

    expect(rows.rows).toEqual([
      // The citation rows are attributed exactly, because the sweep already wrote
      // `subject = domain` for that kind.
      {
        project_id: "p1",
        kind: "citation_win",
        subject: "acme.com",
        domain: "acme.com",
      },
      {
        project_id: "p2",
        kind: "citation_win",
        subject: "c.com",
        domain: "c.com",
      },
      // The single-brand project keeps its visibility forecast, with the one brand it
      // monitors recovered from two target rows.
      {
        project_id: "p1",
        kind: "visibility_pace",
        subject: "chat_gpt",
        domain: "acme.com",
      },
    ]);

    // The two brands project lost its visibility row: the brand was never recorded, so
    // the row is not readable evidence and the next sweep writes it correctly.
    expect(
      rows.rows.some(
        (row) => row.project_id === "p2" && row.kind === "visibility_pace",
      ),
    ).toBe(false);

    // And the archived project's row did not survive the COALESCE path: NULL would have
    // been written without it, and the row is unattributable either way.
    expect(rows.rows.some((row) => row.project_id === "p3")).toBe(false);
  });

  it("keeps the backfill query valid in both dialects, which is a real difference", () => {
    // **The difference is not theoretical.** SQLite accepts a bare column alongside a
    // GROUP BY and returns some row's value; **Postgres rejects it outright** with
    // "must appear in the GROUP BY clause or be used in an aggregate function". The
    // first draft of this migration selected `t.domain` with `GROUP BY t.project_id`,
    // which ran green on every test in this file — because every test in this file is
    // SQLite — and would have failed the moment the pg dialect was applied. So the
    // guard asserts the aggregate in both files, including the one no test exercises.
    for (const file of [
      "drizzle/0065_swift_mercury.sql",
      "drizzle-pg/0041_sturdy_machine_man.sql",
    ]) {
      const sql = readFileSync(file, "utf8");
      // Every SELECT that reads a column out of `geo_targets` must aggregate it. The
      // one here exists precisely to pick the project's single brand out of a group.
      const selects = sql.match(/SELECT [\s\S]*?FROM [`"]?geo_targets/g) ?? [];
      expect(selects.length).toBeGreaterThan(0);
      for (const query of selects) {
        expect(query).toMatch(/SELECT\s+MIN\(/);
      }
      // And the group it summarises must count distinct brands, not rows.
      expect(sql).toMatch(/COUNT\(DISTINCT [`"]?domain[`"]?\)\s*=\s*1/);
    }
  });

  it("rebuilds both indexes with the domain in the key, on both dialects", () => {
    // Read from the SQL rather than from a live database, because one of the two
    // dialects has no instance in test: the file has to *say* the right thing, and
    // `org-cascade.test.mjs` takes the same approach for the cascade.
    for (const file of [
      "drizzle/0065_swift_mercury.sql",
      "drizzle-pg/0041_sturdy_machine_man.sql",
    ]) {
      const sql = readFileSync(file, "utf8");
      expect(sql).toContain("domain");
      expect(sql).toMatch(/DROP INDEX .?geo_forecast_snapshots_point_idx/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX/);
      // The new unique key, in order: project, kind, domain, subject, model, day.
      expect(sql).toMatch(
        /project_id.*kind.*domain.*subject.*model_version.*issued_on/,
      );
    }
  });
});
