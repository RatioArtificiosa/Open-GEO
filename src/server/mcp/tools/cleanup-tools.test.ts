import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { removeSavedKeywordsTool } from "./remove-saved-keywords";
import { deleteReportTool } from "./report-tools";
import { deleteReportTemplateTool } from "./report-template-tools";
import {
  deleteSiteAuditTool,
  listSiteAuditsTool,
} from "./site-audit-cleanup-tools";
import { makeToolContext } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  deleteReport: vi.fn(),
  removeSavedKeywords: vi.fn(),
  deleteTemplate: vi.fn(),
  getAuditForProject: vi.fn(),
  getAuditsByProject: vi.fn(),
  deleteAuditForProject: vi.fn(),
  terminate: vi.fn(),
  status: vi.fn(),
  destroyScratchpad: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    SITE_AUDIT_WORKFLOW: { get: async () => mocks },
    AUDIT_ENGINE: { destroyScratchpad: mocks.destroyScratchpad },
  },
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: mocks,
  }),
);
vi.mock("@/server/features/reports/repositories/ReportRepository", () => ({
  ReportRepository: mocks,
}));
vi.mock(
  "@/server/features/reports/repositories/ReportTemplateRepository",
  () => ({
    ReportTemplateRepository: mocks,
  }),
);
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: mocks,
}));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
  mocks.deleteReport.mockResolvedValue(true);
  mocks.deleteTemplate.mockResolvedValue(true);
  mocks.getAuditForProject.mockResolvedValue({
    id: "audit_1",
    status: "completed",
  });
  mocks.getAuditsByProject.mockResolvedValue([]);
});

const context = makeToolContext();
const deletes = [
  {
    tool: deleteReportTool,
    call: () =>
      deleteReportTool.handler(
        { projectId: "project_1", reportId: "report_1" },
        context,
      ),
    storage: mocks.deleteReport,
    scopedArgs: ["project_1", "report_1"],
  },
  {
    tool: deleteReportTemplateTool,
    call: () =>
      deleteReportTemplateTool.handler(
        { projectId: "project_1", templateId: "template_1" },
        context,
      ),
    storage: mocks.deleteTemplate,
    scopedArgs: ["project_1", "template_1"],
  },
  {
    tool: deleteSiteAuditTool,
    call: () =>
      deleteSiteAuditTool.handler(
        { projectId: "project_1", auditId: "audit_1" },
        context,
      ),
    storage: mocks.deleteAuditForProject,
    scopedArgs: ["audit_1", "project_1"],
  },
];

describe.each(deletes)("$tool.name", ({ tool, call, storage, scopedArgs }) => {
  it("deletes only within the authorized project", async () => {
    expect((await call()).structuredContent.deleted).toBe(true);
    expect(storage).toHaveBeenCalledWith(...scopedArgs);
  });

  it("refuses an inaccessible project before deleting anything", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage).not.toHaveBeenCalled();
  });

  it("refuses missing IDs or IDs belonging to another project", async () => {
    mocks.deleteReport.mockResolvedValue(false);
    mocks.deleteTemplate.mockResolvedValue(false);
    mocks.getAuditForProject.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires an explicit target and advertises destructive behavior", () => {
    expect(
      z.object(tool.config.inputSchema).safeParse({ projectId: "project_1" })
        .success,
    ).toBe(false);
    expect(tool.config.annotations.destructiveHint).toBe(true);
  });
});

describe("site audit cleanup", () => {
  it("lists empty history without starting or deleting an audit", async () => {
    const result = await listSiteAuditsTool.handler(
      { projectId: "project_1" },
      context,
    );
    expect(result.structuredContent.audits).toEqual([]);
    expect(mocks.getAuditsByProject).toHaveBeenCalledWith("project_1");
    expect(mocks.deleteAuditForProject).not.toHaveBeenCalled();
  });

  it("preserves the dashboard's role restriction", async () => {
    await expect(
      deleteSiteAuditTool.handler(
        { projectId: "project_1", auditId: "audit_1" },
        makeToolContext({ role: "member" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.getAuditForProject).not.toHaveBeenCalled();
    expect(mocks.deleteAuditForProject).not.toHaveBeenCalled();
  });

  it("stops a running workflow before deleting its results and scratchpad", async () => {
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit_1",
      status: "running",
      workflowInstanceId: "workflow_1",
    });
    await deleteSiteAuditTool.handler(
      { projectId: "project_1", auditId: "audit_1" },
      context,
    );
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteAuditForProject.mock.invocationCallOrder[0],
    );
    expect(mocks.destroyScratchpad).toHaveBeenCalledWith("audit_1");
  });

  it("keeps data when a workflow cannot be stopped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit_1",
      status: "running",
      workflowInstanceId: "workflow_1",
    });
    mocks.terminate.mockRejectedValue(new Error("Still running"));
    mocks.status.mockResolvedValue({ status: "running" });
    await expect(
      deleteSiteAuditTool.handler(
        { projectId: "project_1", auditId: "audit_1" },
        context,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.deleteAuditForProject).not.toHaveBeenCalled();
  });
});

describe("remove_saved_keywords", () => {
  it("passes exact row IDs to the scoped service and reports actual deletions", async () => {
    mocks.removeSavedKeywords.mockResolvedValue(1);
    const ids = ["saved_1", "saved_1", "missing_or_foreign"];
    const result = await removeSavedKeywordsTool.handler(
      { projectId: "project_1", savedKeywordIds: ids },
      context,
    );
    expect(mocks.removeSavedKeywords).toHaveBeenCalledWith(ids, "project_1");
    expect(result.structuredContent).toMatchObject({
      projectId: "project_1",
      requested: 3,
      deletedCount: 1,
    });
    expect(
      removeSavedKeywordsTool.config.outputSchema.safeParse(
        result.structuredContent,
      ).success,
    ).toBe(true);
  });

  it("refuses inaccessible projects before deletion", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    await expect(
      removeSavedKeywordsTool.handler(
        { projectId: "project_1", savedKeywordIds: ["saved_1"] },
        context,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.removeSavedKeywords).not.toHaveBeenCalled();
  });

  it("reports zero when no requested row belongs to the project", async () => {
    mocks.removeSavedKeywords.mockResolvedValue(0);
    const result = await removeSavedKeywordsTool.handler(
      { projectId: "project_1", savedKeywordIds: ["missing_or_foreign"] },
      context,
    );
    expect(result.structuredContent.deletedCount).toBe(0);
  });

  it.each([undefined, [], [""], Array.from({ length: 2001 }, () => "saved_1")])(
    "rejects a missing, empty, invalid, or oversized target list (%#)",
    (savedKeywordIds) => {
      expect(
        z
          .object(removeSavedKeywordsTool.config.inputSchema)
          .safeParse({ projectId: "project_1", savedKeywordIds }).success,
      ).toBe(false);
    },
  );
});
