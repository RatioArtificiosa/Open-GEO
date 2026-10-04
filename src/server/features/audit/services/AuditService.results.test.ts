import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `AuditService.getResults` — the reader the readiness report reaches the client
 * through.
 *
 * ## Why this file exists
 *
 * **A mutation that dropped `readiness` from the returned payload passed every
 * other test in the repository.** The report is persisted, and the phase's tests
 * assert the write — but nothing asserted the *read*, because `getResults` had no
 * test at all. That is the same shape as the missing-seam finding from earlier in
 * this work: not a missing assertion so much as a function nothing was checking.
 *
 * The distinction this pins is the one the whole null convention exists for:
 * **a missing report and a report with nothing to fix are different answers**, and
 * a reader that collapses them tells a customer their site is fine because we
 * crashed.
 */

const { getAuditResultsForProjectMock, deleteAuditForProjectMock } = vi.hoisted(
  () => ({
    getAuditResultsForProjectMock: vi.fn(),
    deleteAuditForProjectMock: vi.fn(),
  }),
);

vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: { create: vi.fn(), get: vi.fn() },
  },
}));
vi.mock("@/server/features/audit/repositories/auditSummaryQueries", () => ({
  getAuditResultsForProject: getAuditResultsForProjectMock,
  getAuditForProject: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getIssueTypePageCountsForAudit: vi.fn(),
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    createAudit: vi.fn(),
    updateAuditProgress: vi.fn(),
    completeAudit: vi.fn(),
    failAudit: vi.fn(),
    getAuditForWorkflow: vi.fn(),
    insertCrawledBatch: vi.fn(),
    insertIssues: vi.fn(),
    insertLighthouseResults: vi.fn(),
    getAuditForProject: vi.fn(),
    getLatestAuditForProject: vi.fn(),
    getIssuesForAudit: vi.fn(),
    getPagesForAudit: vi.fn(),
    countPagesByFetchClass: vi.fn(),
    hasPagesForAudit: vi.fn(),
    getAuditsByProject: vi.fn(),
    getAuditUsageForOrganization: vi.fn(),
    getAuditResultsForProject: vi.fn(),
    getLighthouseResultById: vi.fn(),
    deleteAuditForProject: deleteAuditForProjectMock,
  },
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasManagedAccess: vi.fn(async () => false),
  customerHasPaidPlan: vi.fn(async () => false),
  getOrCreateOrganizationCustomer: vi.fn(),
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

import { AuditService } from "./AuditService";

const CONFIG = JSON.stringify({ maxPages: 50, lighthouseStrategy: "auto" });

function auditRow() {
  return {
    id: "audit-1",
    startUrl: "https://example.com/",
    status: "completed",
    pagesCrawled: 3,
    pagesTotal: 3,
    startedAt: "2026-10-04T00:00:00.000Z",
    completedAt: "2026-10-04T00:05:00.000Z",
    config: CONFIG,
  };
}

function readinessRow() {
  return {
    id: "r1",
    auditId: "audit-1",
    summary: "One thing to fix first.",
    whyNoScore:
      "A blocked crawler and perfect content average to a healthy middle.",
    fixesJson: JSON.stringify([
      {
        id: "crawler-blocked",
        kind: "switch",
        fix: "Allow GPTBot",
        because: "nothing else works until agents can read the site",
        example: null,
        order: 0,
      },
    ]),
    coverageJson: JSON.stringify(["robots.txt was read"]),
    unavailableJson: JSON.stringify([
      { what: "robots.txt", because: "unreadable" },
    ]),
    fixCount: 1,
    pageCount: 2,
    createdAt: "2026-10-04T00:04:00.000Z",
  };
}

beforeEach(() => {
  getAuditResultsForProjectMock.mockReset();
  getAuditResultsForProjectMock.mockResolvedValue({
    audit: auditRow(),
    pages: [],
    lighthouse: [],
    issues: [],
    readiness: null,
  });
});

describe("AuditService.getResults", () => {
  it("returns the readiness report, parsed", async () => {
    getAuditResultsForProjectMock.mockResolvedValue({
      audit: auditRow(),
      pages: [],
      lighthouse: [],
      issues: [],
      readiness: readinessRow(),
    });

    const results = await AuditService.getResults("audit-1", "project-1");

    // **The assertion a mutation caught.** Without this, dropping `readiness` from
    // the payload passed every other suite — the write was pinned but the read was
    // not.
    expect(results.readiness).not.toBeNull();
    expect(results.readiness?.fixes.map((f) => f.id)).toEqual([
      "crawler-blocked",
    ]);
    expect(results.readiness?.whyNoScore).toContain("healthy middle");
  });

  it("returns null when the phase did not complete, not an empty report", async () => {
    getAuditResultsForProjectMock.mockResolvedValue({
      audit: auditRow(),
      pages: [],
      lighthouse: [],
      issues: [],
      readiness: null,
    });

    const results = await AuditService.getResults("audit-1", "project-1");

    // **Distinct from a report with an empty `fixes`.** The first says our run did
    // not finish; the second says it finished and found nothing. Collapsing them
    // tells a customer their site is fine because we crashed.
    expect(results.readiness).toBeNull();
  });

  it("keeps an empty fix list as a clean audit", async () => {
    getAuditResultsForProjectMock.mockResolvedValue({
      audit: auditRow(),
      pages: [],
      lighthouse: [],
      issues: [],
      readiness: { ...readinessRow(), fixesJson: "[]", fixCount: 0 },
    });

    const results = await AuditService.getResults("audit-1", "project-1");

    expect(results.readiness).not.toBeNull();
    expect(results.readiness?.fixes).toEqual([]);
  });

  it("still returns pages, lighthouse and issues alongside the report", async () => {
    getAuditResultsForProjectMock.mockResolvedValue({
      audit: auditRow(),
      pages: [{ id: "p1", url: "https://example.com/a" }],
      lighthouse: [],
      issues: [],
      readiness: readinessRow(),
    });

    const results = await AuditService.getResults("audit-1", "project-1");

    // **Adding a field must not cost the existing ones** — the regression a new
    // column in a returned payload is most likely to cause.
    expect(results.pages).toHaveLength(1);
    expect(results.lighthouse).toEqual([]);
    expect(results.issues).toEqual([]);
  });

  it("still refuses an audit belonging to another project", async () => {
    getAuditResultsForProjectMock.mockResolvedValue({
      audit: null,
      pages: [],
      lighthouse: [],
      issues: [],
      readiness: readinessRow(),
    });

    // **A readiness row for an audit the project does not own must not become a
    // readable report.** The row is joined through the audit, so a null audit means
    // the join failed — and serving the report anyway would leak one project's
    // findings to another.
    await expect(
      AuditService.getResults("audit-1", "project-1"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
