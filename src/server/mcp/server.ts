import {
  type CallToolResult,
  McpServer,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  createMcpToolContext,
  type McpProps,
  type ToolContext,
} from "@/server/mcp/context";
import { instrumentMcpToolHandler } from "@/server/mcp/instrumentation";
import { objectSchema } from "@/server/mcp/output-schemas";
import { adTrafficCrossCheckTool } from "@/server/mcp/tools/ad-traffic-cross-check-tool";
import { addRankTrackingKeywordsTool } from "@/server/mcp/tools/add-rank-tracking-keywords";
import { aiKeywordVolumeTool } from "@/server/mcp/tools/ai-keyword-volume-tool";
import { aiModeQueryTool } from "@/server/mcp/tools/ai-mode-query-tool";
import { breakoutDetectorTool } from "@/server/mcp/tools/breakout-detector-tool";
import { getCategoryDomainMetricsTool } from "@/server/mcp/tools/category-domain-metrics";
import { categoryMomentumTool } from "@/server/mcp/tools/category-momentum-tool";
import { compareSentimentTool } from "@/server/mcp/tools/compare-ai-web-sentiment-tool";
import { computeShareOfVoiceTool } from "@/server/mcp/tools/compute-share-of-voice";
import { createProjectTool } from "@/server/mcp/tools/create-project";
import { createRankTrackerTool } from "@/server/mcp/tools/create-rank-tracker";
import {
  findSerpCompetitorsTool,
  getGoogleBusinessQuestionsTool,
  getKeywordMetricsTool,
  getLocalSerpResultsTool,
  getRankedKeywordsTool,
  searchLocalBusinessesTool,
} from "@/server/mcp/tools/dataforseo-research-tools";
import { estimateRankTrackerCostTool } from "@/server/mcp/tools/estimate-rank-tracker-cost";
import { forecastTrafficTool } from "@/server/mcp/tools/forecast-traffic-tool";
import { getGeoAnswerDiffTool } from "@/server/mcp/tools/geo-answer-diff-tool";
import { geoBrandFramingTool } from "@/server/mcp/tools/geo-brand-framing-tool";
import {
  getGeoCitationGapTool,
  getGeoRunsTool,
} from "@/server/mcp/tools/geo-diagnostic-tools";
import { geoPromptRunTool } from "@/server/mcp/tools/geo-prompt-run-tool";
import {
  getGeoAnswerHistoryTool,
  getGeoVisibilityForecastTool,
  getGeoVisibilityTool,
  listGeoTargetsTool,
} from "@/server/mcp/tools/geo-read-tools";
import { getGeoTopCitationsTool } from "@/server/mcp/tools/geo-top-citations-tool";
import { getBacklinksOverviewTool } from "@/server/mcp/tools/get-backlinks-overview";
import { getBacklinksProfileTool } from "@/server/mcp/tools/get-backlinks-profile";
import { getDomainKeywordSuggestionsTool } from "@/server/mcp/tools/get-domain-keyword-suggestions";
import { getDomainOverviewTool } from "@/server/mcp/tools/get-domain-overview";
import { getRankTrackerTool } from "@/server/mcp/tools/get-rank-tracker";
import { getSerpResultsTool } from "@/server/mcp/tools/get-serp-results";
import { getWebCitationsTool } from "@/server/mcp/tools/get-web-citations-tool";
import {
  getGoogleAnalyticsAudienceBreakdownTool,
  getGoogleAnalyticsEcommercePerformanceTool,
  getGoogleAnalyticsKeyEventsTool,
  getGoogleAnalyticsMeasurementHealthTool,
  getGoogleAnalyticsOrganicLandingPagesTool,
  getGoogleAnalyticsOrganicOverviewTool,
  getGoogleAnalyticsPagePerformanceTool,
  getGoogleAnalyticsSiteSearchTool,
  getGoogleAnalyticsTrafficAcquisitionTool,
  getSearchOpportunitiesTool,
} from "@/server/mcp/tools/google-analytics-tools";
import { listProjectsTool } from "@/server/mcp/tools/list-projects";
import { listSavedKeywordsTool } from "@/server/mcp/tools/list-saved-keywords";
import {
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
  getLocalRankGridTool,
  listBusinessCategoriesTool,
} from "@/server/mcp/tools/local-seo-tools";
import {
  getCategoryKeywordsTool,
  getDomainCategoriesTool,
} from "@/server/mcp/tools/market-tools";
import {
  getPageWaterfallTool,
  startPageSpeedAuditTool,
} from "@/server/mcp/tools/page-speed-tools";
import {
  getProjectContextTool,
  updateProjectContextTool,
} from "@/server/mcp/tools/project-context";
import { reconcileKeywordVolumesTool } from "@/server/mcp/tools/reconcile-keyword-volumes";
import { removeRankTrackingKeywordsTool } from "@/server/mcp/tools/remove-rank-tracking-keywords";
import { removeSavedKeywordsTool } from "@/server/mcp/tools/remove-saved-keywords";
import { reportPublishTool } from "@/server/mcp/tools/report-publish-tool";
import {
  deleteReportTemplateTool,
  listReportTemplatesTool,
  saveReportTemplateTool,
} from "@/server/mcp/tools/report-template-tools";
import {
  deleteReportTool,
  getReportTool,
  listReportsTool,
  saveReportTool,
} from "@/server/mcp/tools/report-tools";
import { researchKeywordsTool } from "@/server/mcp/tools/research-keywords";
import { runRankTrackerTool } from "@/server/mcp/tools/run-rank-tracker";
import { saveKeywordsTool } from "@/server/mcp/tools/save-keywords";
import {
  getSearchConsolePerformanceTool,
  inspectUrlsTool,
} from "@/server/mcp/tools/search-console-tools";
import { searchSerpLocationsTool } from "@/server/mcp/tools/search-serp-locations";
import { serpAskTool } from "@/server/mcp/tools/serp-ask-tool";
import {
  deleteSiteAuditTool,
  listSiteAuditsTool,
} from "@/server/mcp/tools/site-audit-cleanup-tools";
import {
  getAuditIssuesTool,
  getAuditPagesTool,
  getAuditStatusTool,
  runSiteAuditTool,
} from "@/server/mcp/tools/site-audit-tools";
import {
  getSearchDemographyTool,
  getSearchRegionsTool,
} from "@/server/mcp/tools/trends-audience-tools";
import { getTrendsOverviewTool } from "@/server/mcp/tools/trends-overview-tool";
import { getSearchTrendsTool } from "@/server/mcp/tools/trends-tools";
import { whatToBuildTool } from "@/server/mcp/tools/what-to-build-tool";
import { whoamiTool } from "@/server/mcp/tools/whoami";

type ToolSchema = z.ZodType | z.ZodRawShape;

// Tools declare inputSchema as either a raw Zod shape (most tools) or a full
// z.object (the GA4 tools); both normalize to one object schema at
// registration.
type ToolArgs<Input extends ToolSchema> = Input extends z.ZodType
  ? z.infer<Input>
  : Input extends z.ZodRawShape
    ? z.infer<z.ZodObject<Input>>
    : never;

type OpenSeoToolDefinition<Input extends ToolSchema> = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema: Input;
    outputSchema?: ToolSchema;
    annotations?: ToolAnnotations;
  };
  handler: (
    args: ToolArgs<Input>,
    context: ToolContext,
  ) => CallToolResult | Promise<CallToolResult>;
};

function registerOpenSeoTool<Input extends ToolSchema>(
  server: McpServer,
  tool: OpenSeoToolDefinition<Input>,
  authProps: McpProps,
) {
  // Output objects must allow added fields, including nested objects. The
  // tools/list contract test checks every registered tool for cached-client
  // compatibility; input schemas keep their existing validation rules.
  const outputSchema = objectSchema(tool.config.outputSchema);
  const handler = instrumentMcpToolHandler(
    tool.name,
    outputSchema,
    tool.handler,
  );

  server.registerTool(
    tool.name,
    {
      ...tool.config,
      inputSchema: objectSchema(tool.config.inputSchema),
      outputSchema,
    },
    (args, context) => {
      return handler(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- args were validated against the tool's own inputSchema just above
        args as ToolArgs<Input>,
        createMcpToolContext(context, authProps),
      );
    },
  );
}

export function createOpenSeoMcpServer(authProps: McpProps) {
  const server = new McpServer(
    {
      name: "OpenGeo MCP",
      title: "OpenGeo",
      version: "0.0.12",
      description:
        "SEO research tools for AI agents: keyword research and metrics, SERP and local SERP results, domain and backlink analysis, rank tracking, and Google Search Console performance.",
      websiteUrl: "https://opengeo.so",
      icons: [
        {
          src: "https://opengeo.so/android-chrome-512x512.png",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    },
    {
      // The tool list is fixed per request and no list_changed notification
      // is ever published, so don't advertise the capability — modern clients
      // use it to decide whether to open a subscriptions/listen stream.
      // Without the pre-declaration, registerTool defaults it to true.
      capabilities: { tools: { listChanged: false } },
      instructions:
        "OpenGeo research tools use credits. Proceed with normal focused research, but ask the user for confirmation before planned batches over 2,000 credits.",
    },
  );

  const register = <Input extends ToolSchema>(
    tool: OpenSeoToolDefinition<Input>,
  ) => registerOpenSeoTool(server, tool, authProps);

  register(whoamiTool);
  register(listProjectsTool);
  register(createProjectTool);
  register(getProjectContextTool);
  register(updateProjectContextTool);
  register(listSavedKeywordsTool);
  register(removeSavedKeywordsTool);
  register(researchKeywordsTool);
  register(saveKeywordsTool);
  register(getDomainOverviewTool);
  register(getDomainKeywordSuggestionsTool);
  register(getBacklinksOverviewTool);
  register(getBacklinksProfileTool);
  register(getSerpResultsTool);
  register(listGeoTargetsTool);
  register(getGeoVisibilityTool);
  register(getGeoVisibilityForecastTool);
  register(getGeoCitationGapTool);
  register(getGeoTopCitationsTool);
  register(getGeoAnswerHistoryTool);
  // **Adjacent to the history tool on purpose.** An agent asking "what changed?" should get
  // the diff directly rather than two raw answers and a suggestion to compare them by eye —
  // and the diff is the only one of OpenGeo's outputs that cannot be reproduced by asking a
  // model the same question now.
  register(getGeoAnswerDiffTool);
  register(getGeoRunsTool);
  // The `geo-audit` skill instructs agents to call this by name; without it the
  // audit the skill describes cannot start.
  register(computeShareOfVoiceTool);
  register(geoBrandFramingTool);
  register(geoPromptRunTool);
  register(aiModeQueryTool);
  register(aiKeywordVolumeTool);
  register(forecastTrafficTool);
  // The industry-level read that needs no seed keyword: a whole category's
  // direction, with the medians and the recent slope that keep a spike from
  // answering it.
  register(categoryMomentumTool);
  // The breakouts: a steep approach and a level that lasted, or the spike is
  // reported as the event it is with its persistence number.
  register(breakoutDetectorTool);
  // The build list: gaps ranked with formats, priced by the opportunity
  // scorer — pure ranking over supplied candidates, no vendor call.
  register(whatToBuildTool);
  // The paid-side cross-check, and the guardrail that keeps its two deprecated
  // always-null fields off a chart — the refusal names them instead.
  register(adTrafficCrossCheckTool);
  register(serpAskTool);
  register(reportPublishTool);
  register(compareSentimentTool);
  register(getWebCitationsTool);
  register(searchSerpLocationsTool);
  register(createRankTrackerTool);
  register(getRankTrackerTool);
  register(addRankTrackingKeywordsTool);
  register(removeRankTrackingKeywordsTool);
  register(estimateRankTrackerCostTool);
  register(runRankTrackerTool);
  register(getRankedKeywordsTool);
  register(reconcileKeywordVolumesTool);
  register(startPageSpeedAuditTool);
  register(getPageWaterfallTool);
  register(getDomainCategoriesTool);
  register(getCategoryKeywordsTool);
  register(getCategoryDomainMetricsTool);
  register(getSearchTrendsTool);
  register(getSearchDemographyTool);
  register(getSearchRegionsTool);
  register(getTrendsOverviewTool);
  register(findSerpCompetitorsTool);
  register(searchLocalBusinessesTool);
  register(getLocalSerpResultsTool);
  register(getGoogleBusinessQuestionsTool);
  register(getBusinessProfileTool);
  register(getBusinessReviewsTool);
  register(getBusinessUpdatesTool);
  register(listBusinessCategoriesTool);
  register(getLocalRankGridTool);
  register(getKeywordMetricsTool);
  register(getSearchConsolePerformanceTool);
  register(inspectUrlsTool);
  register(getGoogleAnalyticsOrganicLandingPagesTool);
  register(getGoogleAnalyticsPagePerformanceTool);
  register(getGoogleAnalyticsKeyEventsTool);
  register(getSearchOpportunitiesTool);
  register(getGoogleAnalyticsOrganicOverviewTool);
  register(getGoogleAnalyticsTrafficAcquisitionTool);
  register(getGoogleAnalyticsMeasurementHealthTool);
  register(getGoogleAnalyticsEcommercePerformanceTool);
  register(getGoogleAnalyticsSiteSearchTool);
  register(getGoogleAnalyticsAudienceBreakdownTool);
  register(runSiteAuditTool);
  register(listSiteAuditsTool);
  register(deleteSiteAuditTool);
  register(getAuditStatusTool);
  register(getAuditIssuesTool);
  register(getAuditPagesTool);
  register(saveReportTool);
  register(listReportsTool);
  register(getReportTool);
  register(deleteReportTool);
  register(listReportTemplatesTool);
  register(saveReportTemplateTool);
  register(deleteReportTemplateTool);

  return server;
}
