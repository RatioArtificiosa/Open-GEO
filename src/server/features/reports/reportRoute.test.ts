import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleReportRequest, NOT_FOUND_BODY } from "@/routes/r/$reportId";
import { PRINT_SCRIPT, REPORT_CSP, reportCsp } from "@/shared/report-sandbox";

const mocks = vi.hoisted(() => ({
  resolveUserContextFromHeaders: vi.fn(),
  getProjectForOrganization: vi.fn(),
  getArchivedProjectForOrganization: vi.fn(),
  getReportProjectId: vi.fn(),
  getReportHtml: vi.fn(),
  getReportTitle: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { AUTH_MODE: "hosted" } }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUserContextFromHeaders,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.getProjectForOrganization,
    getArchivedProjectForOrganization: mocks.getArchivedProjectForOrganization,
  },
}));
vi.mock("@/server/features/reports/repositories/ReportRepository", () => ({
  ReportRepository: {
    getReportProjectId: mocks.getReportProjectId,
    getReportHtml: mocks.getReportHtml,
    getReportTitle: mocks.getReportTitle,
  },
}));

const HTML = "<!doctype html><html><body>report</body></html>";

const request = () => new Request("https://app.example.com/r/report-1");

// CL-303: the same document, requested as a download rather than printed.
const downloadRequest = () =>
  new Request("https://app.example.com/r/report-1?download=1");

beforeEach(() => {
  mocks.resolveUserContextFromHeaders.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    emailVerified: true,
    organizationId: "org-1",
    role: "owner",
  });
  mocks.getReportProjectId.mockResolvedValue("project-1");
  mocks.getProjectForOrganization.mockResolvedValue({ id: "project-1" });
  mocks.getArchivedProjectForOrganization.mockResolvedValue(null);
  mocks.getReportHtml.mockResolvedValue(HTML);
  mocks.getReportTitle.mockResolvedValue("GEO audit — badseo.dev");
});

describe("handleReportRequest", () => {
  it("serves the stored document with the sandbox headers", async () => {
    const response = await handleReportRequest("report-1", request());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HTML);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": REPORT_CSP,
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
    // Authorized against the row's project before the document is read, so an
    // unauthorized request never pulls one onto the worker's heap.
    expect(mocks.getProjectForOrganization).toHaveBeenCalledWith(
      "project-1",
      "org-1",
    );
  });

  // "Export" is one click only because the served document prints itself; the
  // script-src hash is what lets that one script run while the report's own
  // scripts stay blocked.
  it("appends the print script and widens the sandbox in print mode", async () => {
    const response = await handleReportRequest(
      "report-1",
      new Request("https://app.example.com/r/report-1?print=1"),
    );

    expect(await response.text()).toBe(
      `<!doctype html><html><body>report<script>${PRINT_SCRIPT}</script></body></html>`,
    );
    expect(response.headers.get("content-security-policy")).toBe(
      reportCsp(true),
    );
  });

  // See withPrintScript: a dangling `<script src="…" ` absorbs any attribute on
  // the tag we splice in.
  it("gives a dangling script tag in the document no attribute to absorb", async () => {
    mocks.getReportHtml.mockResolvedValue(
      '<!doctype html><html><body><script src="https://evil.example/x.js" </body></html>',
    );

    const response = await handleReportRequest(
      "report-1",
      new Request("https://app.example.com/r/report-1?print=1"),
    );

    const body = await response.text();
    // The spliced tag carries no attributes, so the dangling tag absorbs
    // nothing but a valueless `<script` attribute name.
    expect(body).toBe(
      '<!doctype html><html><body><script src="https://evil.example/x.js" ' +
        `<script>${PRINT_SCRIPT}</script></body></html>`,
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "'nonce-",
    );
  });

  it.each([
    [
      "an unknown report",
      () => mocks.getReportProjectId.mockResolvedValue(null),
    ],
    // Another organization's project is indistinguishable from one that does
    // not exist, on purpose.
    [
      "a project the viewer cannot access",
      () => mocks.getProjectForOrganization.mockResolvedValue(null),
    ],
  ])("answers the same 404 for %s", async (_case, arrange) => {
    arrange();

    const response = await handleReportRequest("report-1", request());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BODY);
    expect(mocks.getReportHtml).not.toHaveBeenCalled();
  });

  it("names an archived project of the viewer's own organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    mocks.getArchivedProjectForOrganization.mockResolvedValue({
      id: "project-1",
      name: "badseo.dev",
    });

    const response = await handleReportRequest("report-1", request());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      "This project is archived, so its reports are hidden. Restore badseo.dev to read them.",
    );
    expect(mocks.getReportHtml).not.toHaveBeenCalled();
  });

  it("bounces an unauthenticated viewer to sign-in", async () => {
    mocks.resolveUserContextFromHeaders.mockRejectedValue(
      new Error("UNAUTHENTICATED"),
    );

    const response = await handleReportRequest("report-1", request());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/sign-in?redirect=%2Fr%2Freport-1",
    );
  });

  // A session-store or config failure must not read as "you are logged out" and
  // send the reader round a sign-in loop that cannot fix it.
  it("lets a non-auth failure escape instead of bouncing to sign-in", async () => {
    mocks.resolveUserContextFromHeaders.mockRejectedValue(
      new Error("AUTH_CONFIG_MISSING"),
    );

    await expect(handleReportRequest("report-1", request())).rejects.toThrow(
      "AUTH_CONFIG_MISSING",
    );
  });

  // CL-303. A download, not a print dialog: the same document, attached, so the
  // reader receives a file rather than a tab they have to close.
  describe("download mode", () => {
    it("serves the document as an attachment named for the report", async () => {
      const response = await handleReportRequest("report-1", downloadRequest());

      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      // **Named for the report, not the id.** An agency sending a client
      // "report-7f3a.html" has already lost the first impression.
      expect(disposition).toContain("GEO-audit-badseo.dev.html");
    });

    // CodeRabbit's second finding: a download is not rendered, so a `print()`
    // call in the saved file could never fire. It was dead code in the artefact
    // and a live risk in it, because a file opened from disk arrives with no CSP.
    it("injects no print script, because a download is never rendered", async () => {
      const body = await (
        await handleReportRequest("report-1", downloadRequest())
      ).text();

      expect(body).not.toContain("print()");
      expect(body).not.toContain("<script");
    });

    it("sends the locked-down policy, because the file has no script", async () => {
      const response = await handleReportRequest("report-1", downloadRequest());
      const csp = response.headers.get("content-security-policy") ?? "";

      // **Not the print policy.** The saved document is inert — every script is
      // stripped — so `allow-scripts` here would authorise a script that is not
      // there, and would be the one place the download is permissive if the
      // stripping ever regressed.
      expect(csp).toBe(REPORT_CSP);
      expect(csp).not.toContain("allow-scripts");
    });

    it("sends a document that cannot execute anything", async () => {
      const body = await (
        await handleReportRequest("report-1", downloadRequest())
      ).text();

      // **The header does not travel with the file**, so the file has to be safe
      // on its own. A report is written by a model from crawled pages, SERP titles
      // and GSC queries, all attacker-influenceable, and a client opening the file
      // from disk is executing whatever was in it.
      expect(body).not.toContain("<script");
      expect(body).toContain('http-equiv="Content-Security-Policy"');
    });

    it("names the file from the id when the title cannot make one", async () => {
      mocks.getReportTitle.mockResolvedValue(null);

      const response = await handleReportRequest("report-1", downloadRequest());

      expect(response.headers.get("content-disposition")).toContain(
        'filename="report-report-1.html"',
      );
    });

    // The title reaches a response header, so reading it before authorizing would
    // disclose a report's name to someone who cannot open it.
    it.each([
      [
        "an unknown report",
        () => mocks.getReportProjectId.mockResolvedValue(null),
      ],
      [
        "a project the viewer cannot access",
        () => mocks.getProjectForOrganization.mockResolvedValue(null),
      ],
    ])("does not read the title for %s", async (_case, arrange) => {
      arrange();

      const response = await handleReportRequest("report-1", downloadRequest());

      expect(response.status).toBe(404);
      expect(mocks.getReportTitle).not.toHaveBeenCalled();
      expect(mocks.getReportHtml).not.toHaveBeenCalled();
    });
  });
});
