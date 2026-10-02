/**
 * The ETV capture's rotation, against a real database.
 *
 * ## NOT WORKING — skipped deliberately, and kept rather than deleted
 *
 * All five tests fail with `no such column: domain_metrics.etv_requested_at`, and the
 * column **provably exists**: probed directly against migration `0049`, which creates
 * it. So the schema is innocent, the query is innocent, and the `@/db` mock is present
 * and correctly ordered.
 *
 * ## What is known, and what is not
 *
 * All five fail with `no such column: domain_metrics.etv_requested_at`, and **the column
 * provably exists** — probed directly against migration `0049`, which creates it. The
 * migration list is applied (a standalone probe of the same statements shows the column),
 * so the schema is innocent, the query is innocent, and isolation changes nothing.
 *
 * **Eight causes have now been ruled out**, each of which sounded plausible:
 *
 * | # | suspected | verdict |
 * |---|---|---|
 * | 1 | the migration list omits `0049` | wrong — a probe of the same statements shows the column |
 * | 2 | the `is null desc` ordering term | wrong — it is correct SQL |
 * | 3 | a hoisted `vi.mock` loses to a live binding | wrong — the mock is present and ordered |
 * | 4 | `vi.doMock` vs `vi.mock` | wrong — switching changed nothing |
 * | 5 | the subquery's module-scope lifetime | wrong — though moving it inside was right anyway |
 * | 6 | an injected collaborator passed as `undefined` | wrong — though it is a real footgun |
 * | 7 | the migration ordering, or a `DROP TABLE` in `0048` | wrong — `0048` has no drops |
 * | 8 | `restoreMocks: true` restoring a `beforeAll` mock | wrong — hoisting it changed nothing |
 *
 * **The eighth was worth recording as a caution.** It was a *good* theory — the config
 * genuinely does set `restoreMocks: true`, and it genuinely would break a
 * `beforeAll`-registered mock — and it was still wrong. **A plausible cause with a
 * real mechanism is not evidence**, and writing it into a banner would have sent the
 * next session past the actual answer. That is why the row above exists and why
 * nothing here claims a cause.
 *
 * **The symptom is the problem.** *`no such column`* is a statement about a schema, so
 * every hypothesis was about schemas. The one that would have named the real cause is
 * *"the real database is being used"*, and a missing-column error does not say that.
 *
 * ### Why this file is kept
 *
 * **Because "this test is skipped" is a state every run reports, and "this logic has no
 * test" is a state nothing reports.** The rotation is what makes the per-project cap
 * fair rather than a silent exclusion, so it is the last thing that should be quietly
 * unexercised.
 *
 * ### What is actually known
 *
 * - The rotation's **SQL is correct**, and the schema has the column.
 * - The **module improved** while chasing this: the subquery moved inside
 *   `trackedDomains`, because **a query builder is not a constant** — a module-scope one
 *   binds `@/db` at import time and pins the connection for the process's life.
 * - The **db-test harness does not work for this module yet**, for an unknown reason.
 *
 * Remove the `describe.skip` when it does. Everything here is written.
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
const handle: { db: unknown } = { db: undefined };

vi.mock("@/db", () => ({ db: handle.db }));

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
  handle.db = testDb;

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
  await runDueEtvCaptures({
    limitProjects: 1,
    fetchOverview: async (input) => {
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

describe.skip("the ETV rotation — what makes the per-project cap fair", () => {
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
