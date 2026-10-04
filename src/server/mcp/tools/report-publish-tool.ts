import { z } from "zod";
import { ReportService } from "@/server/features/reports/services/ReportService";
import { sharePath } from "@/shared/report-share";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

/**
 * `report_publish` — mint or revoke the public link for a saved report.
 *
 * ## This is a wire, not a build
 *
 * The whole share surface already exists and is tested: `shareToken` and
 * `sharedAt` columns with a unique index, `ReportService.shareReport` /
 * `unshareReport`, a public route, idempotent minting, a hosted-only guard,
 * and telemetry. It was reachable **only from the dashboard**, because
 * `shareReport` had no `source` parameter and hard-coded `source: "app"` —
 * so an agent sharing a report would have been recorded as a user clicking a
 * button. That is the same defect as letting a model set its own
 * `createdBy`, and it is the only change to the service this tool needed.
 *
 * ## The consent boundary is the substance, not the plumbing
 *
 * Publishing a report **puts a customer's SEO audit on the open web at a
 * guessable-ish URL**, readable by anyone who has it, with no login. That is
 * the most consequential thing an agent in this product can do, and a tool
 * description is not a consent record.
 *
 * So this tool is **not** callable on the first ask:
 *
 * - `dry_run` defaults to **true** and explains exactly what becomes public.
 * - `publish: true` must be passed **by the caller**, and it is the *only*
 *   thing that mints a link. There is no path where asking for a report
 *   shares it.
 * - Even then the response says plainly that the link is public and
 *   unauthenticated, because a user who asked an agent to "send me the
 *   report" did not necessarily ask for it to be world-readable.
 *
 * `revoke: true` is the mirror and is safe to call directly — revoking can
 * only reduce exposure.
 *
 * ## Two things the caller must know, so both are in the text
 *
 * - **Sharing is hosted-only.** On a self-hosted deployment a minted token
 *   would be a link that silently does nothing, and the user would have
 *   copied it believing otherwise. The service refuses; this states it up
 *   front.
 * - **The token is in the URL.** It is a bearer credential — anyone holding
 *   the link can read the report, and the same as any other capability URL.
 */

const inputSchema = {
  projectId: projectIdSchema,
  reportId: z
    .string()
    .min(1)
    .describe("The report to publish or unpublish. See list_reports for ids."),
  publish: z
    .boolean()
    .optional()
    .describe(
      "Mint the public link. Requires dry_run: false as well — this is the explicit confirmation that the report becomes world-readable.",
    ),
  revoke: z
    .boolean()
    .optional()
    .describe(
      "Revoke the public link, making the report private again. Safe to call at any time; it only reduces exposure.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Default true: explain what publishing this report would expose, without sharing it. Set dry_run: false together with publish: true to actually create the link.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const reportPublishTool = {
  name: "report_publish",
  config: {
    title: "Publish or unpublish a report",
    description:
      "Mints or revokes a public, unauthenticated link to a saved report. PUBLISHING IS IRREVERSIBLE BY DEFAULT: anyone with the link can read the report without logging in, and the token is in the URL. Never publish a report because a user asked to see or send it — ask them first, then pass publish: true and dry_run: false together. revoking is safe and immediate. Sharing works only on hosted OpenGeo; on a self-hosted deployment a link cannot be created. This spends no DataForSEO credits. dry_run defaults to true and only explains the exposure.",
    inputSchema,
    outputSchema: z
      .object({
        reportId: z.string(),
        shared: z.boolean(),
        /** The public path, relative to the deployment. Null when revoked. */
        shareUrl: z.string().nullable(),
        sharedAt: z.string().nullable(),
        /** True when nothing changed, because the report was already in that state. */
        unchanged: z.boolean(),
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      // It does not delete or overwrite, but it *exposes* — and an annotation
      // that says "safe" for a tool that publishes a customer's audit to the
      // open web is the wrong default. `destructive` here means "irreversible
      // from the outside", which is what minting a bearer link is until it is
      // revoked.
      openWorldHint: true,
      destructiveHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const meta = () =>
      buildProjectMeta(context, args.projectId, `/p/${args.projectId}/reports`);

    if (args.revoke === true) {
      // Read the state first: `unchanged` is a claim about a *transition*, and
      // reading only the result cannot tell one. `unshareReport` returns the
      // report either way — it is a no-op when there was nothing to revoke —
      // so without the before-state this field would report "unchanged: true"
      // for a report that was never shared and "false" for one that was.
      const before = await ReportService.getReport(
        args.projectId,
        args.reportId,
      );
      const wasShared = Boolean(before.shareToken);

      // Safe to do directly: revoking can only reduce who can read the report.
      const report = await ReportService.unshareReport({
        projectId: args.projectId,
        reportId: args.reportId,
        userId: context.auth.userId,
        organizationId: context.auth.organizationId,
        source: "mcp",
      });

      return mcpResponse({
        text: !wasShared
          ? `Report "${report.title}" was already private. Nothing changed.`
          : `Report "${report.title}" is private again. Anyone holding the old link can no longer read it.`,
        meta: meta(),
        structuredContent: {
          reportId: report.id,
          shared: false,
          shareUrl: null,
          sharedAt: null,
          unchanged: !wasShared,
        },
      });
    }

    // **Both halves or neither.** `publish: true` alone is not consent: the
    // agent sets `publish` from its own reading of the conversation, while
    // `dry_run: false` is the caller declining the preview. An earlier version
    // gated on `publish` alone, and a bare `publish: true` published the
    // report — the exact harm this tool exists to prevent, reached by the
    // obvious call. Caught by a test written before the branch existed.
    if (args.publish !== true || args.dry_run !== false) {
      const report = await ReportService.getReport(
        args.projectId,
        args.reportId,
      );
      return mcpResponse({
        text: [
          `Nothing has been shared. Publishing "${report.title}" would create a public link that anyone can read without logging in — the token is in the URL, and there is no login on the other end.`,
          report.shareToken
            ? `It is ALREADY shared (since ${report.sharedAt ?? "an earlier date"}). To make it private again, call this with revoke: true.`
            : `Ask the user whether they want this report public before doing it — a request to see or send a report is not a request to publish it. Then call with publish: true and dry_run: false.`,
          `This spends no DataForSEO credits.`,
        ].join("\n"),
        meta: meta(),
        structuredContent: {
          reportId: report.id,
          shared: Boolean(report.shareToken),
          shareUrl: null,
          sharedAt: report.sharedAt ?? null,
          unchanged: true,
        },
      });
    }

    // Read the state before the mint, for the same reason as the revoke path:
    // `shareReport` is idempotent and returns the existing token rather than a
    // new one, so "already shared" and "just published" are otherwise the same
    // response — and an agent retrying after a dropped connection would be told
    // it had published when it had changed nothing.
    const before = await ReportService.getReport(args.projectId, args.reportId);
    const wasShared = Boolean(before.shareToken);

    const report = await ReportService.shareReport({
      projectId: args.projectId,
      reportId: args.reportId,
      userId: context.auth.userId,
      organizationId: context.auth.organizationId,
      source: "mcp",
    });

    // The shared helper the routes and the app both use — `/s/<token>`. Building the
    // path by hand here would be a dead link the moment the route moved, and a
    // dead link on a *published* report is the worst possible place to discover it.
    const shareUrl = report.shareToken
      ? `${context.baseUrl}${sharePath(report.shareToken)}`
      : null;

    return mcpResponse({
      // Joined, not an array: `mcpResponse` takes a single string. The array form
      // typechecks nowhere — `tsc` rejects it at the call — and it also reaches
      // the caller as an object, not prose, which is what an agent would then try
      // to speak. Both gates exist; this is the one that stopped me.
      text: (wasShared
        ? [
            `"${report.title}" was already shared, so the existing link is unchanged.`,
            `Share: ${shareUrl}`,
            `To make it private again, call this with revoke: true.`,
          ]
        : [
            `Published "${report.title}". Anyone with this link can read it without logging in — the token is part of the URL, so treat it as a secret.`,
            `Share: ${shareUrl}`,
            `To make it private again, call this with revoke: true.`,
          ]
      ).join("\n"),
      meta: meta(),
      structuredContent: {
        reportId: report.id,
        shared: Boolean(report.shareToken),
        shareUrl,
        sharedAt: report.sharedAt ?? null,
        unchanged: wasShared,
      },
    });
  }),
};
