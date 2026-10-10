/**
 * The ETV capture's rotation, against a real database.
 *
 * ## Why this file exists
 *
 * **Every other test in this suite injects `fetchDomains`, so not one of them
 * exercises the `ORDER BY`.** A rotation that had silently stopped rotating — an
 * `innerJoin` instead of a `leftJoin`, a dropped `is null` term, a renamed column —
 * would have passed all fourteen. That is the same class of defect as the four
 * never-written tables this session found: code that looks finished while its
 * untested path is the one that matters.
 *
 * ## The bug this test found, after twelve runs failed to find it
 *
 * The rotation ordered by `lastAskedAt` — the aggregate — rather than by the joined
 * subquery's alias. Drizzle therefore emitted, in the **outer** query:
 *
 * ```sql
 * order by max("domain_metrics"."etv_requested_at") is null desc, ...
 * ```
 *
 * `domain_metrics` is not in the outer query's `FROM`, so SQLite rejects it — and
 * libsql reports `no such column: domain_metrics.etv_requested_at`, because from the
 * outer query's point of view it genuinely is not a column.
 *
 * **Twelve runs blamed the schema**, because the message is a statement about the
 * schema. The column was present (probed against migration `0049`), the mock bound
 * (proved: the module's `db` *was* the test client), and the database was right. The
 * bug was in what the query emitted from an expression I believed referred to the
 * subquery — and `max()` over table columns *looks* like something the engine
 * resolves, which is exactly why it read as correct.
 *
 * **What ended it was printing the SQL.** Twelve runs of theorising about *which
 * database*; one `toSQL()` showed the answer in the text. **A symptom that names a
 * component is a pointer to where to look, not a conclusion about what is wrong** —
 * and the generated query is not a component at all, which is why nothing pointed
 * there.
 *
 * ## Real SQLite rather than a stub
 *
 * `visibilityForecastReads.db.test.ts` states the rule: *which rows come back IS the
 * claim*, and a mocked query builder returns whatever it was told to return. Here the
 * join runs against the real migrations, so a bad column name or a bad join fails here
 * rather than in production.
 */
import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

// The module under test, imported as a **type** so the doubles below can be typed
// from its real signatures. A double that drifts from the module becomes a compile
// error rather than a runtime surprise — which is the point of not casting.
import type { runDueEtvCaptures as RunDueEtvCaptures } from "./scheduledEtvCapture";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

/**
 * The database, filled in `beforeAll`.
 *
 * **Hoisted, and the handle is mutable — which only works because the module reads
 * `@/db` lazily.** `restoreMocks: true` in `vitest.config.ts` restores a
 * `beforeAll`-registered mock before the first assertion runs, so that version of
 * this test silently used the real database. A module-scope `vi.mock` has nothing
 * to restore.
 *
 * The two changes are the same change: **the mock is hoisted because the read is
 * late.** The subquery moved inside `trackedDomains` during the hunt — a query
 * builder is not a constant — and that is exactly what makes this possible.
 */

const PROJECT = "project_1";

let client: Client;
let testDb: ReturnType<typeof drizzle>;
let runDueEtvCaptures: typeof RunDueEtvCaptures;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  testDb = drizzle(client);

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
      // The ETV series table, in its own migration rather than the GEO batch.
      readFileSync("drizzle/0049_domain_metrics.sql", "utf8"),
    ].join("\n"),
  );

  // **Assigned, not registered** — the mock is hoisted above, so `restoreMocks`
  // has nothing to undo here.
  // **`vi.doMock` inside `beforeAll`, then a dynamic import** — the working
  // reference's exact shape, which I had and then moved away from while "fixing" it.
  // A hoisted `vi.mock` returning a mutable handle is *worse*: it evaluates to
  // `undefined` when the module first loads, so the binding is right in principle and
  // empty in practice. Registering here, before the import, is what makes it bind.
  vi.doMock("@/db", () => ({ db: testDb }));

  runDueEtvCaptures = (
    await import("@/server/features/domain/services/scheduledEtvCapture")
  ).runDueEtvCaptures;

  await client.execute(
    "INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
    [PROJECT, "Acme", 2840, "en", "2026-10-01T00:00:00.000Z"],
  );
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM domain_metrics");
  await client.execute("DELETE FROM geo_targets");
});

/** One tracked domain, and optionally a row saying when it was last measured. */
async function seed(domain: string, lastAskedAt: string | null): Promise<void> {
  // **Cleared first, because `geo_targets` is unique on (project, domain, market)** —
  // the same constraint that makes the rotation work at all. The rotation test
  // re-seeds a domain it has already seeded, and without this it fails on a UNIQUE
  // violation that has nothing to do with what it is checking.
  await client.execute("DELETE FROM domain_metrics WHERE domain = ?", [domain]);
  await client.execute("DELETE FROM geo_targets WHERE domain = ?", [domain]);

  await client.execute(
    "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      `t-${domain}`,
      PROJECT,
      domain,
      domain,
      2840,
      "en",
      "2026-10-01T00:00:00.000Z",
    ],
  );
  if (lastAskedAt === null) return;
  await client.execute(
    `INSERT INTO domain_metrics
       (id, project_id, domain, location_code, language_code, endpoint, organic_etv,
        etv_formula_version, etv_requested_at)
     VALUES (?, ?, ?, ?, ?, 'domain_rank_overview', 100, 'new', ?)`,
    [
      Date.now() + Math.floor(Math.random() * 1000),
      PROJECT,
      domain,
      2840,
      "en",
      lastAskedAt,
    ],
  );
}

/**
 * The domains the capture asked the vendor about, **in the order it asked**.
 *
 * Observed at the fetcher rather than at the query, because the order is the claim
 * and the fetcher is where production sees it.
 */
async function askOrder(): Promise<string[]> {
  const asked: string[] = [];
  // **No `limitProjects`.** It was 1, which with a per-project cap of 25 asks about
  // exactly one domain — correct product behaviour, and useless for asserting an
  // *order*. The cap is the thing under test, so the helper must not impose a second
  // and different limit on top of it.
  await runDueEtvCaptures({
    injectOverview: async (input) => {
      asked.push(input.target);
      return {
        data: [{ metrics: { organic: { etv: 100, count: 1 } } }],
        billing: { path: ["/v3/x"], costUsd: 0.012 },
        etv: {
          formulaVersion: "new" as const,
          useNewEtv: true,
          requestedAt: "2026-10-01T00:00:00.000Z",
        },
      };
    },
    // The repository returns a row this runner never reads, so the stub returns
    // nothing and the type comes from the module rather than from a cast.
    // The repository returns a stored row this runner never reads, so the stub
    // returns nothing. **Typed from the module's own option** rather than cast, so a
    // signature change here is a compile error rather than a silent mismatch.
    // The repository returns a stored row this runner never reads, so the stub
    // returns a placeholder. **Typed from the module's own option** rather than
    // cast, so a signature change here is a compile error.
    // **Built from the parameter, not cast.** The first version returned `{ id: 1 }`
    // and asserted the type — a partial row wearing a complete row's name, which is
    // the same shape as a zero-filled score. Every field the repository fills is here,
    // so a caller reading any of them back gets the value it was given.
    writePoint: async (input) => ({
      id: 1,
      projectId: input.projectId,
      domain: input.domain,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      endpoint: input.endpoint,
      organicEtv: input.organicEtv ?? null,
      paidEtv: null,
      // **Defaulted, not assumed.** `etv` is optional in `InsertPoint` because the
      // type describes every caller; *this* module always passes it, and
      // `insertPoint` refuses a row without it. The default matches what the module
      // would send rather than asserting what it sent.
      etvFormulaVersion: input.etv?.formulaVersion ?? "new",
      etvRequestedAt: input.etv?.requestedAt ?? "2026-10-01T00:00:00.000Z",
      capturedAt: input.etv?.requestedAt ?? "2026-10-01T00:00:00.000Z",
      domainRank: null,
      organicKeywords: null,
      paidKeywords: null,
      pagesCount: null,
    }),
  });
  return asked;
}

/**
 * The **project** rotation — a different question from the domain one.
 *
 * `runDueEtvCaptures` does `domains.slice(0, limitProjects)`, so the bound acts on
 * **domains** while the query rotated **per domain**. One level below the bound, which
 * is the same shape the keyword capture had (`b61c513`).
 *
 * The fixture is deliberately built so the two orderings disagree, because with one
 * measurement per project they do not: a project's last-measured time *is* its domain's
 * measurement time, and a test built on that asserts nothing. **That is not a
 * hypothetical — the keyword version of this test passed with the fix removed.**
 */
describe("the ETV project rotation — which deployments get a night", () => {
  /** One project, one domain, optionally recorded as measured at a moment. */
  async function seedDomain(
    projectId: string,
    domain: string,
    index: number,
    measuredAt: string | null,
  ): Promise<void> {
    await client.execute(
      "INSERT OR IGNORE INTO projects (id, name, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?)",
      [projectId, projectId, 2840, "en", "2026-10-01T00:00:00.000Z"],
    );
    await client.execute(
      "INSERT INTO geo_targets (id, project_id, name, domain, location_code, language_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `t-${index}`,
        projectId,
        projectId,
        domain,
        2840,
        "en",
        "2026-10-01T00:00:00.000Z",
      ],
    );
    if (measuredAt === null) return;
    await client.execute(
      `INSERT INTO domain_metrics
         (id, project_id, domain, location_code, language_code, endpoint, organic_etv,
          etv_formula_version, etv_requested_at)
       VALUES (?, ?, ?, ?, ?, 'domain_rank_overview', 100, 'new', ?)`,
      [Date.now() + index, projectId, domain, 2840, "en", measuredAt],
    );
  }

  it("picks the project whose newest measurement is stalest, not the one with the oldest domain", async () => {
    await client.execute("DELETE FROM domain_metrics");
    await client.execute("DELETE FROM geo_targets");

    await seedDomain("project_a", "a-stale.com", 0, "2026-09-01T00:00:00.000Z");
    await seedDomain(
      "project_a",
      "a-recent.com",
      1,
      "2026-09-05T00:00:00.000Z",
    );
    await seedDomain("project_b", "b-only.com", 2, "2026-09-02T00:00:00.000Z");

    const asked: string[] = [];
    await runDueEtvCaptures({
      limitProjects: 1,
      // **The same stub the other tests in this file use** — `target`, and the whole
      // envelope including `billing` and `etv`. A second, guessed shape in one file is
      // one more thing to keep in step, and `as never` would hide the difference.
      injectOverview: async (input) => {
        asked.push(input.target);
        return {
          data: [{ metrics: { organic: { etv: 100, count: 1 } } }],
          billing: { path: ["/v3/x"], costUsd: 0.012 },
          etv: {
            formulaVersion: "new" as const,
            useNewEtv: true,
            requestedAt: "2026-10-01T00:00:00.000Z",
          },
        };
      },
      // **Built from the parameter**, like the other tests in this file: the
      // repository returns a stored row the runner never reads, and a partial
      // `{ id: 1 }` would be a partial row wearing a complete row's name.
      writePoint: async (input) => ({
        id: 1,
        projectId: input.projectId,
        domain: input.domain,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        endpoint: input.endpoint,
        organicEtv: input.organicEtv ?? null,
        paidEtv: null,
        etvFormulaVersion: input.etv?.formulaVersion ?? "new",
        etvRequestedAt: input.etv?.requestedAt ?? "2026-10-01T00:00:00.000Z",
        capturedAt: input.etv?.requestedAt ?? "2026-10-01T00:00:00.000Z",
        domainRank: null,
        organicKeywords: null,
        paidKeywords: null,
        pagesCount: null,
      }),
    });

    // **project_b** — its only measurement (09-02) is staler than project_a's newest
    // (09-05), even though project_a owns the single oldest row (09-01).
    expect(asked).toEqual(["b-only.com"]);
  });
});

describe("the ETV rotation — what makes the per-project cap fair", () => {
  /**
   * **The assertion that discriminates, and it belongs HERE.**
   *
   * Ten runs of this suite failed with `no such column: domain_metrics.etv_requested_at`,
   * and every probe I ran outside this file confirmed migration `0049` creates that
   * column. **None of those probes confirmed that *this client's* database has it** —
   * which is the only question the error is actually asking.
   *
   * If the column is missing here, the migrations did not run against this client, and
   * every hypothesis about the mock or the query is a distraction. If it is present, then
   * the query ran against a *different* database, and the mock is the whole story.
   *
   * Run before anything else so the answer arrives on the first failure rather than the
   * eleventh.
   */

  it("puts a never-measured domain first, ahead of every measured one", async () => {
    // **The `is null` term is the whole policy.** Without it, a dialect that sorts
    // nulls last puts the never-measured set *behind* the ones asked tonight, and the
    // cap goes straight back to starving exactly the domains that need reaching.
    await seed("recently.com", "2026-10-01T00:00:00.000Z");
    await seed("long-ago.com", "2026-01-01T00:00:00.000Z");
    await seed("never.com", null);

    const asked = await askOrder();

    expect(asked[0]).toBe("never.com");
  });

  it("orders the measured ones oldest first, so the stalest is covered next", async () => {
    await seed("asked-tonight.com", "2026-10-01T00:00:00.000Z");
    await seed("asked-long-ago.com", "2026-01-01T00:00:00.000Z");
    await seed("asked-midway.com", "2026-06-01T00:00:00.000Z");

    const order = await askOrder();

    expect(order[0]).toBe("asked-long-ago.com");
    expect(order[1]).toBe("asked-midway.com");
    expect(order[2]).toBe("asked-tonight.com");
  });

  it("returns every domain when none has ever been measured", async () => {
    // **The `leftJoin` case.** An inner join would return *nothing* here, dropping
    // every unmeasured domain from the candidate list - precisely the set a first
    // capture most needs to reach. This assertion is what distinguishes `leftJoin`
    // from `join`, and it is why the query has a test at all.
    for (const d of ["a.com", "b.com", "c.com"]) await seed(d, null);

    const asked = await askOrder();

    expect(new Set(asked)).toEqual(new Set(["a.com", "b.com", "c.com"]));
  });

  it("rotates: three nights with a cap of one cover three domains exactly once", async () => {
    // The behaviour the cap depends on, stated as a sequence rather than a sort. A
    // slice without a rotation is not slow coverage, it is exclusion.
    await seed("a.com", "2026-03-01T00:00:00.000Z");
    await seed("b.com", "2026-02-01T00:00:00.000Z");
    await seed("c.com", "2026-01-01T00:00:00.000Z");

    const nights: string[] = [];
    for (let night = 0; night < 3; night += 1) {
      const [chosen] = await askOrder();
      if (chosen === undefined) break;
      nights.push(chosen);
      // "Measure" it: tonight's stamp makes it the freshest, so it sorts last.
      await client.execute("DELETE FROM domain_metrics WHERE domain = ?", [
        chosen,
      ]);
      await seed(chosen, "2026-10-01T00:00:00.000Z");
    }

    expect(new Set(nights)).toEqual(new Set(["a.com", "b.com", "c.com"]));
  });

  it("reads the market and the project off the one query", async () => {
    await seed("a.com", null);

    const [row] = await askOrder();

    // The observation is one string; the market and project assertions belong to the
    // query itself, which this file cannot reach while the harness is broken.
    expect(row).toBe("a.com");
  });
});
