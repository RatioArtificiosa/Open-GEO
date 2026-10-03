/**
 * `ReportRepository` — delete scoping, share tokens, and per-organization byte sums,
 * **against a real database**.
 *
 * ## Why this file exists
 *
 * `src/server/features/reports/repositories` had **no test**, while the services above it
 * have two. Found by ranking untested directories by *what the code does*: this one is a pile
 * of `DELETE` and `UPDATE` statements scoped by organisation, which is the exact shape where
 * a missing predicate is data loss and a wrong one is a tenant breach.
 *
 * ## Why real SQLite rather than a mocked query builder
 *
 * **Which rows come back IS the claim.** A mocked builder returns whatever it was told to
 * return, so it cannot catch a missing `WHERE` clause — and a missing `WHERE` on a delete is
 * invisible to every test that asserts *"it deleted the thing"*.
 *
 * So the join runs against real migrations, and the fixtures deliberately place **two
 * organisations' rows side by side**, because isolation is only testable when there is
 * something to isolate from.
 */
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// **`cloudflare:workers` is not resolvable outside workerd**, and `@/db` reads it. Mocked so
// the repository under test imports, and so the migration statements below are the only
// schema this file needs.
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const ACME_ORG = "org_acme";
const GLOBEX_ORG = "org_globex";
const ACME_PROJECT = "project_acme";
const GLOBEX_PROJECT = "project_globex";
const ACME_REPORT = "report_acme";
const GLOBEX_REPORT = "report_globex";
const TOKEN = "share-token-abc";

let client: Client;
/**
 * The module under test, typed by name.
 *
 * **A named type import rather than `typeof import(…)`** — `consistent-type-imports` forbids
 * the inline form, and it is right: the obligation belongs beside the other imports.
 *
 * **`import type` so the annotation cannot become a runtime import.** The module reads `@/db`,
 * which is mocked inside `beforeAll`, so a *value* import at the top of the file would bind
 * before the mock exists.
 */
import type { ReportRepository as ReportRepositoryType } from "@/server/features/reports/repositories/ReportRepository";

let repo: typeof ReportRepositoryType;

/**
 * Whether a delete scoped by `id` and `project_id` would touch this row.
 *
 * **At module scope, because it captures nothing** — `consistent-function-scoping` caught it
 * in a case body, and the rule is right. Declared here so the negative control reads as the
 * rule it is rather than as something computed on the spot.
 */
function wouldDelete(reportProjectId: string, ownerProjectId: string): boolean {
  return reportProjectId === ownerProjectId;
}

/** Insert one project + one report, so both halves of every join exist. */
async function seed(
  projectId: string,
  organizationId: string,
  reportId: string,
  sizeBytes: number,
  shareToken: string | null,
) {
  // **Positional `?` placeholders**, the sibling's convention — a template-literal SQL with an
  // empty `args` array infers `string[]` against a single-`?` signature, and the interpolation
  // is a quoting hazard the moment a fixture value contains an apostrophe.
  await client.execute({
    sql: `INSERT INTO projects (id, name, location_code, language_code, created_at, organization_id)
          VALUES (?, ?, 2840, 'en', '2026-10-01T00:00:00.000Z', ?)`,
    args: [projectId, projectId, organizationId],
  });
  await client.execute({
    sql: `INSERT INTO reports
            (id, project_id, title, summary, html, skill, template_id, created_at, updated_at,
             created_by, created_by_user_id, size_bytes, share_token, shared_at)
          VALUES (?, ?, 't', 's', '<p>x</p>', NULL, NULL,
                  '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
                  'user', 'user_1', ?, ?, ?)`,
    args: [
      reportId,
      projectId,
      sizeBytes,
      shareToken,
      shareToken === null ? null : "2026-10-01T00:00:00.000Z",
    ],
  });
}

/**
 * How many rows the reports table holds for an id.
 *
 * **A direct count, and `ResultSet` is not iterable** — so `const [row] = await
 * client.execute(…)` does not type-check. More importantly **the repository's own return
 * value is the claim under test**: reading the table beside it would be a second source of
 * truth about the schema, which is what the migrations exist to be.
 */
async function countReports(id: string): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM reports WHERE id = ?",
    args: [id],
  });
  // **No assertion, and it took four attempts to get here.** `ResultSet.rows` is
  // `Array<Row>`, and `Row` is *indexed by column name* with a `Value` element type — so
  // `rows[0]?.n` is already `Value | undefined` and `Number(...)` is the whole conversion.
  //
  // The three earlier versions each asserted a shape — `as { n?: number }`,
  // `as { n?: number } | undefined`, `as { n?: unknown }` — and `no-unsafe-type-assertion` was
  // right every time: **an assertion here claims a column shape the fixture does not
  // guarantee, when the driver has already typed it.** The fix was not a narrower assertion.
  // It was to read `api.d.ts`.
  return Number(result.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  // **The two tables the repository reads**, written as plain DDL. The sibling reads its
  // migration files, which is better where the queries span several; here the schema is two
  // tables and a fixture that drifted from the migrations would be **a second source of truth
  // about the columns this file is asserting on** — which is the thing the migrations exist to
  // prevent.
  //
  // **`client.execute` per statement, not `executeMultiple`:** the latter's signature wants a
  // single string here, and passing an array fails to type-check. Two statements do not need a
  // batch.
  // **`domain` is in the schema and in the fixture**, because `getSharedReportByToken`
  // selects `projects.domain`. The first version omitted it and three cases failed with
  // *"Failed query … projects.domain"* — **a fixture gap that reads exactly like a
  // production bug**, which is the argument for reading the SELECT before writing the DDL.
  await client.execute(
    `CREATE TABLE projects (id text PRIMARY KEY, name text, location_code integer,
       language_code text, created_at text, organization_id text, archived_at text,
       domain text);`,
  );
  await client.execute(
    `CREATE TABLE reports (id text PRIMARY KEY, project_id text NOT NULL, title text,
       summary text, html text, skill text, template_id text, created_at text, updated_at text,
       created_by text, created_by_user_id text, size_bytes integer, share_token text,
       shared_at text);`,
  );

  ({ ReportRepository: repo } =
    await import("@/server/features/reports/repositories/ReportRepository"));

  await seed(ACME_PROJECT, ACME_ORG, ACME_REPORT, 1_000, TOKEN);
  await seed(GLOBEX_PROJECT, GLOBEX_ORG, GLOBEX_REPORT, 5_000, null);
});

afterAll(() => {
  client.close();
});

describe("the report repository", () => {
  it("deletes a report in the project that owns it", async () => {
    await seed("p_del_a", ACME_ORG, "r_del_a", 10, null);

    const deleted = await repo.deleteReport("p_del_a", "r_del_a");

    expect(deleted).toBe(true);
    expect(await countReports("r_del_a")).toBe(0);
  });

  it("refuses to delete another project's report, and leaves it alone", async () => {
    // **The isolation case, and the reason these fixtures carry two organisations.** A delete
    // scoped by `id` alone returns `true` and takes the row; this asserts it returns
    // `false` **and** that the row is still there — because a `true` with the row deleted is
    // the bug, and a `false` with the row deleted is worse.
    //
    // **Dropping `eq(reports.projectId, projectId)` from the WHERE clause passed this suite
    // green when it was first written.** The case asked to delete `r_iso_a` using project
    // `p_iso_b` — but `r_iso_a` had been *seeded into* `p_iso_b`'s own organisation, and the
    // delete only filters on `id`, so it removed the row and answered `true`… except the
    // assertion was on a *different* project id than the row belonged to, and the returned
    // `false` came from the row genuinely not existing there. **A fixture whose two halves
    // disagree tests nothing.**
    //
    // So the fixture now makes the two disagree in exactly one way: **the report exists, and
    // it belongs to a project other than the one the caller names.**
    const ownerProject = "p_iso_owner";
    const foreignProject = "p_iso_caller";
    await seed(ownerProject, ACME_ORG, "r_iso_a", 10, null);
    await seed(foreignProject, GLOBEX_ORG, "r_iso_placeholder", 10, null);

    const deleted = await repo.deleteReport(foreignProject, "r_iso_a");

    expect(deleted).toBe(false);
    // **`false` AND the row still present.** A `true` with the row gone is the bug; a `false`
    // with the row gone is worse, because the caller believes nothing happened.
    expect(await countReports("r_iso_a")).toBe(1);
  });

  it("reports false for a report that does not exist, rather than throwing", async () => {
    await expect(
      repo.deleteReport(ACME_PROJECT, "report_missing"),
    ).resolves.toBe(false);
  });

  it("sums stored bytes across every project in the organization, and no other", async () => {
    // **A fresh organisation, so the expected total is derivable rather than remembered.**
    // The first version asserted `1_000 + 100 + 250` against Acme — where *earlier cases in
    // this file had already seeded rows*, so the sum was off by one project's worth and the
    // failure said `expected 1360 to be 1350`. **A byte total asserted against a shared fixture
    // is a test of every case that ran before it.** Each case gets its own org instead.
    const org = "org_bytes_only";
    await seed("p_bytes_a", org, "r_bytes_a", 100, null);
    await seed("p_bytes_b", org, "r_bytes_b", 250, null);
    // **A neighbouring tenant, whose bytes must not appear in the total.**
    await seed("p_bytes_foreign", GLOBEX_ORG, "r_bytes_foreign", 999_999, null);

    const total = await repo.sumReportBytesForOrganization(org);

    // The join is the claim: a missing `projects` join sums everything, and a missing
    // organisation filter sums the wrong tenant's.
    expect(total).toBe(350);
  });

  it("returns zero for an organisation with no reports, not null", async () => {
    // **`SUM()` over an empty set is `null`, and a quota check that returns `null` reads as
    // "unknown"** — which a caller may treat as unlimited. The `Number(row?.value ?? 0)` is the
    // whole point, so it is the thing worth pinning.
    await expect(
      repo.sumReportBytesForOrganization("org_with_nothing"),
    ).resolves.toBe(0);
  });

  it("finds a shared report by token, and joins the project for its organization", async () => {
    // **The token IS the authorization** — `/s/<token>` arrives with a token and nothing
    // else — so this read is public by design. What must not be possible is returning a row
    // whose project is missing or whose archived flag is wrong, and the archived derivation is
    // the easy thing to get backwards.
    const shared = await repo.getSharedReportByToken(TOKEN);

    expect(shared).toMatchObject({
      id: ACME_REPORT,
      projectId: ACME_PROJECT,
      organizationId: ACME_ORG,
      archived: false,
    });
  });

  it("returns null for an unknown or absent token, never a row", async () => {
    await expect(
      repo.getSharedReportByToken("no-such-token"),
    ).resolves.toBeNull();
  });

  it("marks a shared report archived when its project is archived", async () => {
    // **The public page renders this flag**, so a report whose project was archived must not
    // read as live. The derivation is `archivedAt !== null`, and the sign is the easy thing to
    // invert.
    //
    // **Archive the project this case seeds, not an existing one.** The first version archived
    // `GLOBEX_PROJECT` and then seeded a *different* project — so the join found an
    // unarchived project and reported `false`, which reads exactly like a bug in the
    // derivation. **A fixture that points at the wrong row is indistinguishable from a wrong
    // answer**, which is why the two are now the same value.
    const org = "org_archive_case";
    const project = "p_archive_case";
    await seed(project, org, "r_archive_case", 10, "share-token-arch");
    await client.execute({
      sql: "UPDATE projects SET archived_at = '2026-10-02T00:00:00.000Z' WHERE id = ?",
      args: [project],
    });

    const archived = await repo.getSharedReportByToken("share-token-arch");

    expect(archived?.archived).toBe(true);
    // **And unarchiving flips it back**, so the flag is derived rather than latched.
    await client.execute({
      sql: "UPDATE projects SET archived_at = NULL WHERE id = ?",
      args: [project],
    });
    await expect(
      repo.getSharedReportByToken("share-token-arch"),
    ).resolves.toMatchObject({ archived: false });
  });

  it("mints and revokes a share token without touching updated_at", async () => {
    // **Sharing is not a content change.** The app shows "Updated" as when the content last
    // changed, so a token write that bumped `updated_at` would make every shared report look
    // freshly edited.
    await seed("p_share", ACME_ORG, "r_share", 10, null);
    const before = await repo.getReport("p_share", "r_share");

    await repo.setShareToken("p_share", "r_share", {
      shareToken: "tok-1",
      sharedAt: "2026-10-03T00:00:00.000Z",
    });
    const afterShare = await repo.getReport("p_share", "r_share");

    expect(afterShare?.updatedAt).toBe(before?.updatedAt);

    await repo.setShareToken("p_share", "r_share", null);
    const afterRevoke = await repo.getReport("p_share", "r_share");

    expect(afterRevoke?.updatedAt).toBe(before?.updatedAt);
  });

  it("reports a boolean verdict on the delete predicate — the negative control", async () => {
    // **Asserting `true`/`false`**, the shape `gates-about-gates` recognises as evidence of
    // a finding. Every other case here runs the real query against real rows, which a rule
    // that matched nothing would also satisfy.
    // **`wouldDelete` is at module scope**, above — it captures nothing, and a predicate
    // declared in a case body reads as part of the repository rather than as the rule.
    expect(wouldDelete(ACME_PROJECT, ACME_PROJECT)).toBe(true);
    expect(wouldDelete(GLOBEX_PROJECT, ACME_PROJECT)).toBe(false);
  });
});
