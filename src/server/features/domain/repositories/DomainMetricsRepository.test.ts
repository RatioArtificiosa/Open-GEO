import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
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
import type * as RepoModule from "./DomainMetricsRepository";
import type { domainMetrics as DomainMetricsTable } from "@/db/schema";
import type { EtvProvenance } from "@/shared/etv-versioning";

// Real in-memory SQLite against the real migration: whether a column is actually
// NOT NULL is the whole contract, and a mocked builder chain cannot see it.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const PROJECT_ID = "proj_1";
let client: Client;

let DomainMetricsRepository: typeof RepoModule.DomainMetricsRepository;
let domainMetrics: typeof DomainMetricsTable;

const PROVENANCE: EtvProvenance = {
  formulaVersion: "legacy",
  useNewEtv: false,
  requestedAt: "2026-10-15T09:00:00.000Z",
};

/**
 * A provenance block that reached the repository without the fields it needs.
 *
 * `insertPoint` takes `etv` as `EtvProvenance | undefined` precisely so the
 * guard inside it is reachable and testable — a required parameter would make
 * the check dead code, because nothing could ever omit it. The type says what a
 * correct caller passes; the signature says the repository defends itself
 * against one that does not.
 */
const MISSING_PROVENANCE: EtvProvenance | undefined = undefined;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer, language_code text, created_at text);`,
      `INSERT INTO projects (id, name, location_code, language_code, created_at) VALUES ('${PROJECT_ID}', 'Acme', 2840, 'en', '2026-01-01 00:00:00');`,
      ...readFileSync("drizzle/0049_domain_metrics.sql", "utf8")
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("DROP TABLE")),
    ].join("\n"),
  );

  DomainMetricsRepository = (await import("./DomainMetricsRepository"))
    .DomainMetricsRepository;
  domainMetrics = (await import("@/db/schema")).domainMetrics;
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM domain_metrics");
});

const POINT = {
  projectId: PROJECT_ID,
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  endpoint: "domain_rank_overview" as const,
  organicEtv: 12_621_380,
};

describe("DomainMetricsRepository", () => {
  it("stores the ETV together with the model that produced it", async () => {
    const row = await DomainMetricsRepository.insertPoint({
      ...POINT,
      etv: PROVENANCE,
    });
    expect(row.organicEtv).toBe(12_621_380);
    expect(row.etvFormulaVersion).toBe("legacy");
    expect(row.etvRequestedAt).toBe(PROVENANCE.requestedAt);
  });

  it("refuses an ETV with no provenance rather than guessing a model", async () => {
    // The single most important assertion in this file. A default here would
    // mean we silently labelled a value with whichever model we guessed, and the
    // guess would be wrong for every row written before 2026-11-01.
    await expect(
      DomainMetricsRepository.insertPoint({
        ...POINT,
        etv: MISSING_PROVENANCE,
      }),
    ).rejects.toThrow(/without its formula version/i);

    const rows = await client.execute(
      "SELECT COUNT(*) AS n FROM domain_metrics",
    );
    expect(Number(rows.rows[0]?.n)).toBe(0);
  });

  it("enforces the version at the database, not only in code", async () => {
    // Even if a future caller bypasses the repository, the column refuses.
    await expect(
      client.execute({
        sql: `INSERT INTO domain_metrics
              (project_id, domain, location_code, language_code, endpoint,
               organic_etv, etv_formula_version, etv_requested_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          PROJECT_ID,
          "acme.com",
          2840,
          "en",
          "ranked_keywords",
          500,
          null,
          "2026-10-15T09:00:00.000Z",
        ],
      }),
    ).rejects.toThrow();
  });

  it("keeps two formulas for the same target as separate points", async () => {
    // The pre- and post-cutover values must not overwrite each other: they are
    // different measurements of different things.
    await DomainMetricsRepository.insertPoint({
      ...POINT,
      etv: PROVENANCE,
    });
    await DomainMetricsRepository.insertPoint({
      ...POINT,
      organicEtv: 9_500_000,
      etv: {
        formulaVersion: "new",
        useNewEtv: true,
        requestedAt: "2026-11-03T09:00:00.000Z",
      },
    });

    const series = await DomainMetricsRepository.listSeries({
      projectId: PROJECT_ID,
      domain: "acme.com",
      locationCode: 2840,
      endpoint: "domain_rank_overview",
    });
    expect(series).toHaveLength(2);
    expect(
      new Set(DomainMetricsRepository.listFormulaVersions(series)),
    ).toEqual(new Set(["legacy", "new"]));
  });

  it("treats a re-capture at the same request time as the same observation", async () => {
    await DomainMetricsRepository.insertPoint({ ...POINT, etv: PROVENANCE });
    await DomainMetricsRepository.insertPoint({
      ...POINT,
      organicEtv: 13_000_000,
      etv: PROVENANCE,
    });
    const rows = await client.execute(
      "SELECT COUNT(*) AS n FROM domain_metrics",
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("does not mix endpoints in one series", async () => {
    await DomainMetricsRepository.insertPoint({ ...POINT, etv: PROVENANCE });
    await DomainMetricsRepository.insertPoint({
      ...POINT,
      endpoint: "relevant_pages",
      etv: PROVENANCE,
    });
    const series = await DomainMetricsRepository.listSeries({
      projectId: PROJECT_ID,
      domain: "acme.com",
      locationCode: 2840,
      endpoint: "relevant_pages",
    });
    expect(series).toHaveLength(1);
    expect(series[0]?.endpoint).toBe("relevant_pages");
  });

  it("scopes every read to a project", async () => {
    await DomainMetricsRepository.insertPoint({ ...POINT, etv: PROVENANCE });
    const other = await DomainMetricsRepository.listSeries({
      projectId: "another_project",
      domain: "acme.com",
      locationCode: 2840,
      endpoint: "domain_rank_overview",
    });
    expect(other).toEqual([]);
  });

  it("normalises the domain so two spellings land on one series", async () => {
    await DomainMetricsRepository.insertPoint({
      ...POINT,
      domain: "  HTTPS://WWW.Acme.com  ",
      etv: PROVENANCE,
    });
    const series = await DomainMetricsRepository.listSeries({
      projectId: PROJECT_ID,
      domain: "acme.com",
      locationCode: 2840,
      endpoint: "domain_rank_overview",
    });
    expect(series).toHaveLength(1);
    expect(series[0]?.domain).toBe("acme.com");
  });

  it("keeps non-ETV metrics alongside, since the formula change does not move them", async () => {
    const row = await DomainMetricsRepository.insertPoint({
      ...POINT,
      etv: PROVENANCE,
      domainRank: 1248300,
      organicKeywords: 4820,
    });
    expect(row.domainRank).toBe(1248300);
    expect(row.organicKeywords).toBe(4820);
  });

  it("exposes the version on the exported table so a caller cannot bypass it", () => {
    // The stamp lives in the schema, not only in the repository, so a raw insert
    // is still required to supply it.
    expect(domainMetrics.etvFormulaVersion.notNull).toBe(true);
    expect(domainMetrics.etvRequestedAt.notNull).toBe(true);
  });
});
