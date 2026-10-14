/**
 * The GEO tool suites' shared scaffolding.
 *
 * **Why this exists as a module.** `geo-tools.test.ts` had grown past the repo's
 * 400-line lint ceiling, and the honest split was along the line the file
 * already had: the archive-reading tools (`geo-tools.test.ts`), the forecast
 * (`geo-forecast-tool.test.ts`), and the citation-gap surface
 * (`geo-citation-gap-tool.test.ts`). All three need the same mocked seams —
 * the auth wrapper, the services, and the two helpers that call a tool and read
 * its prose — and three copies of a mock is how the copies drift until one
 * suite tests nothing.
 *
 * So the seams live here, and each suite imports what it uses.
 */

import { vi } from "vitest";
import {
  makeToolContext,
  textContent,
} from "@/server/mcp/tools/tool-test-support";

/**
 * `withMcpProjectAuth` performs a real project-membership lookup before the
 * handler runs. Mocking the auth wrapper (rather than the database) is what
 * makes these suites about the tool's wording rather than about authorisation,
 * and it guarantees no SQL can execute.
 */
vi.mock("cloudflare:workers", () => ({ env: {} }));

export const listTargets = vi.fn();
export const getVisibility = vi.fn();
export const getCitationGap = vi.fn();
export const listAnswerHistory = vi.fn();
export const listRuns = vi.fn();
export const forecastForStoredSeries = vi.fn();
export const latestReadinessState = vi.fn();

vi.mock("@/server/mcp/project-auth", () => ({
  withMcpProjectAuth:
    (
      handler: (
        args: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => unknown,
    ) =>
    async (
      args: Record<string, unknown>,
      toolContext: { auth: Record<string, unknown> },
    ) =>
      handler(args, {
        auth: toolContext.auth,
        baseUrl: "https://open-geo.test",
        organizationId: "org_123",
        project: {
          id: "p1",
          name: "Acme",
          locationCode: 2840,
          languageCode: "en",
        },
        billing: { organizationId: "org_123" },
      }),
  requireProjectAccess: vi.fn(),
}));

vi.mock("@/server/features/geo/repositories/GeoSetupRepository", () => ({
  GeoSetupRepository: { listTargets },
}));

vi.mock("@/server/features/geo/services/GeoService", () => ({
  GeoService: {
    getVisibility,
    getCitationGap,
    listAnswerHistory,
    listRuns,
  },
}));

// The forecast reader reaches `@/db`, so it is mocked like `GeoService`: these
// suites are about the *wording* a tool hands an agent, and a tool that cannot
// say what it does not know is the thing being tested.
vi.mock("@/server/features/geo/services/visibilityForecastReads", () => ({
  forecastForStoredSeries,
}));

// The audit readiness the citation gap's win probability reads. Mocked for the
// same reason as the rest: no SQL may run, and the readiness state is an input
// the tests set explicitly — including the "no audit ever ran" case, which is
// one of the module's three states.
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: { latestReadinessState },
}));

export type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

export const TARGET = { id: "t1", domain: "acme.com", name: "Acme" };

/**
 * Read the human-facing text out of an MCP response.
 *
 * The tools put their whole point in prose — the "must not be summed" warning,
 * the retrieval-unavailable explanation — so the assertions are about wording,
 * which is the one thing an agent will actually repeat to a user.
 */
export function textOf(result: ToolResult) {
  return textContent(result);
}

/**
 * Call a tool the way the MCP server does: validated args in, a full tool
 * context in. The auth wrapper (mocked above) supplies the project-scoped
 * context the handler expects, including `baseUrl`, which `buildProjectMeta`
 * needs to build the dashboard link it returns in `meta`.
 */
export async function callTool<TTool extends { handler: unknown }>(
  tool: TTool,
  data: Record<string, unknown>,
): Promise<ToolResult> {
  // Generic rather than one fixed handler type: each tool's handler takes its
  // own validated args, and pinning a single shared signature would force a
  // cast at every call site. The tools are loaded dynamically, so their inferred
  // types flow through untouched.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool graph is loaded dynamically, so its concrete handler type is not visible here; this widens `unknown` to the one shape the MCP server guarantees
  const handler = tool.handler as (
    args: Record<string, unknown>,
    context: unknown,
  ) => Promise<ToolResult>;
  // The handler reads its fields straight off `args`; `projectId` is injected by
  // the auth wrapper in production and supplied here.
  return handler({ projectId: "p1", ...data }, makeToolContext());
}
