import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { routeAgentRequest } from "agents";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { runScheduledRankChecks } from "@/server/features/rank-tracking/services/scheduledRankChecks";
import { runDueGeoPatrols } from "@/server/features/geo/services/scheduledGeoPatrol";
import { runNightlyBillableCaptures } from "@/server/features/geo/services/nightlyCaptures";
import { runQueueDrain } from "@/server/features/geo/services/queueDrainRunner";
import { runScheduledGeoRetention } from "@/server/features/geo/services/scheduledGeoRetention";
import { reconcileStaleAudits } from "@/server/features/audit/services/auditReconciler";
import { getOrCreateOrganizationCustomer } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import {
  createOpenSeoOAuthProvider,
  type OpenSeoOAuthEnv,
} from "@/server/mcp/oauth-provider";
import { requestWithPublicOrigin } from "@/server/mcp/public-origin";
import { enforceOpenDeploymentGate } from "@/server/auth/previewGate";
import { MCP_ROUTE } from "@/server/mcp/context";
import { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";
import { withPgClient } from "@/db";
import {
  AUTUMN_WEBHOOK_PATH,
  handleAutumnWebhookRequest,
} from "@/server/billing/autumn-webhook";
import { sweepDubReferredOrganizations } from "@/server/referrals/dub";
import { maybeSendSelfHostHeartbeat } from "@/server/lib/self-host-telemetry";
import { handleGdprStorageErasure } from "@/server/gdpr/storage-erasure";
import { GDPR_STORAGE_ERASURE_PATH } from "@/shared/gdpr-erasure";

const startHandler = createStartHandler(defaultStreamHandler);

// The app ships no security response headers of its own, so any third-party
// page can frame an app route and UI-redress a one-click action (delete a
// project, change project settings, buy credits). `frame-ancestors 'self'` on
// the app's own documents is the whole fix, and deliberately all of it: a
// script-src policy would need a nonce for the inline bootstrap script in
// __root.tsx plus allowances for Turnstile and PostHog, which is separate,
// larger work.
//
// Only HTML documents, and only ones that carry no policy of their own, so a
// route that sets its own stricter CSP keeps it (two CSP headers intersect, so
// adding a second could only confuse things). Wrapping the handler rather than
// one call site covers the OAuth-provider path too, which serves app documents
// through this same function.
async function appFetch(request: Request): Promise<Response> {
  const response = await startHandler(request);
  const contentType = response.headers.get("content-type") ?? "";
  if (
    !contentType.startsWith("text/html") ||
    response.headers.has("content-security-policy")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "frame-ancestors 'self'");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const openSeoOAuthProvider = createOpenSeoOAuthProvider(appFetch);

// Authorize a SAM agent connection in the Worker, before it reaches the Durable
// Object. The DO instance name is the sessionId (set client-side); we resolve
// the session here and authorize the caller against the session's project via
// the same canonical project-access check the rest of the app uses, so the DO
// can trust its `name` and derive org/project/user from the session row.
// Returning a Response rejects; void lets it through.
async function authorizeSamChat(
  request: Request,
  sessionId: string,
): Promise<Response | undefined> {
  let context;
  try {
    context = await resolveUserContextFromHeaders(request.headers);
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = await SamSessionRepository.getActiveSession(
    sessionId,
    context.userId,
  );
  const project = session
    ? await ProjectRepository.getProjectForOrganization(
        session.projectId,
        context.organizationId,
      )
    : null;
  if (!session || !project) {
    return new Response("Forbidden", { status: 403 });
  }
  // Make sure the Autumn customer (and its default free-plan credits) exists
  // before the DO's balance gate runs, or a brand-new org's first message hits
  // a false "out of credits". Hosted-only; self-hosted has no Autumn.
  if (await isHostedServerAuthMode()) {
    await getOrCreateOrganizationCustomer(context);
  }
  return undefined;
}

// The chat DO lives behind /agents/*. Dispatch on the DO binding partyserver
// resolved for the request (rather than re-parsing the path), and fail closed
// on anything unrecognized.
function authorizeChatAgent(
  request: Request,
  lobby: { className: string; name: string },
): Promise<Response | undefined> | Response {
  if (lobby.className === "SAM_CHAT") {
    return authorizeSamChat(request, lobby.name);
  }
  return new Response("Forbidden", { status: 403 });
}

// Route /agents/* to the SAM chat DO. Auth happens here (both the WS upgrade
// and any HTTP message-history fetch), keeping it off the OAuth wrapper and
// TanStack route guard below.
async function routeChatAgents(request: Request, env: Env): Promise<Response> {
  const response = await routeAgentRequest(request, env, {
    onBeforeConnect: (req, lobby) => authorizeChatAgent(req, lobby),
    onBeforeRequest: (req, lobby) => authorizeChatAgent(req, lobby),
  });
  return response ?? new Response("Not found", { status: 404 });
}

function fetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Scope a per-request Postgres client (no-op in D1 mode). The client isn't
  // closed here — the Workers↔Hyperdrive socket is reclaimed at invocation end.
  return withPgClient(() => Promise.resolve(handleFetch(request, env, ctx)));
}

function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Response | Promise<Response> {
  const authMode = getAuthMode(env.AUTH_MODE);

  /**
   * **Close the open-deployment window before anything else runs.**
   *
   * `local_noauth` grants a full admin identity, so a stage running it on a
   * public `workers.dev` URL is an unauthenticated application. This gate is the
   * stopgap until Zero Trust is enabled on the account; see
   * `src/server/auth/previewGate.ts` for why neither real auth mode was an
   * option at the time.
   *
   * Checked against the **original** request, before `requestWithPublicOrigin`
   * rewrites it — the rewrite exists to stop a forwarded host from becoming an
   * Open Redirect, and the gate must not depend on which host a caller claimed.
   */
  const gated = enforceOpenDeploymentGate(
    request,
    authMode,
    env.PREVIEW_GATE_SECRET,
  );
  if (gated) return gated;

  const publicRequest = requestWithPublicOrigin(request);
  const pathname = new URL(publicRequest.url).pathname;
  ctx.waitUntil(maybeSendSelfHostHeartbeat(pathname));

  if (pathname === GDPR_STORAGE_ERASURE_PATH) {
    return handleGdprStorageErasure(publicRequest, env);
  }

  if (pathname.startsWith("/agents/")) {
    return routeChatAgents(publicRequest, env);
  }

  if (isHostedAuthMode(authMode)) {
    if (pathname === AUTUMN_WEBHOOK_PATH) {
      return handleAutumnWebhookRequest(publicRequest);
    }

    return openSeoOAuthProvider.fetch(
      publicRequest,
      env as OpenSeoOAuthEnv,
      ctx,
    );
  }

  if (
    (authMode === "cloudflare_access" || authMode === "local_noauth") &&
    pathname === MCP_ROUTE
  ) {
    return handleSelfHostedOpenSeoMcpRequest(publicRequest, authMode, env, ctx);
  }

  return appFetch(request);
}

// Export Workflow classes as named exports. SiteAuditWorkflow and the
// AuditScratchpad DO live in the open-geo-audit aux worker
// (src/audit-worker.ts); this worker reaches them via cross-script bindings.
export { RankCheckWorkflow } from "./server/workflows/RankCheckWorkflow";
// Durable Object class for the SAM in-app agent (Agents SDK).
export { SamChatAgent } from "./server/features/sam/SamChatAgent";

// Daily OAuth KV garbage collection; must match a trigger in wrangler.jsonc.
const MCP_OAUTH_PURGE_CRON = "17 3 * * *";

export default {
  fetch,
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ) {
    // Daily-only work runs on the daily tick **in addition to** the work every
    // tick shares. It used to `return` here, which meant the daily tick did
    // *only* OAuth GC — so on `17 3 * * *` the watchdog, the GEO patrol, GEO
    // retention and the rank checks all silently did not run, and on every other
    // tick they all did. The comments below said "the nightly patrol rides the
    // same daily tick"; the code did the exact inverse.
    //
    // Nothing caught it because the patrol's own 24-hour cadence filter made a
    // 5-minute tick a no-op *for the patrol* — so the symptom (a nightly job
    // running 288×/day) is invisible while the inversion is present, and only
    // becomes real the moment someone removes that filter or changes the
    // cadence. Both directions are now explicit and a test pins the schedule.
    const isDailyTick = controller.cron === MCP_OAUTH_PURGE_CRON;
    // **The same cron expression, named for what it gates.**
    //
    // `isDailyTick` above gates the *free* daily work: the OAuth KV purge and the
    // Dub referral sweep. The three billable captures below read as nightly and
    // are gated on the identical expression, so they share one source of truth
    // and cannot drift the way they did when each carried its own idea of a
    // window. A second name for one expression is deliberate: the two facts are
    // different, and collapsing them into one flag is how "this is also tonight"
    // gets lost the next time the free daily work grows a sibling.
    const isNightlyTick = isDailyTick;
    if (isDailyTick && isHostedAuthMode(getAuthMode(env.AUTH_MODE))) {
      // Only hosted mode runs the OAuth provider (and has OAUTH_KV bound).
      const result = await openSeoOAuthProvider.purgeExpiredData(
        env as OpenSeoOAuthEnv,
      );
      console.log("[mcp-oauth] purged expired OAuth data", result);
      if (!result.done) {
        // The sweep only advances past live records via deletions; a
        // persistent incomplete scan means the keyspace outgrew the batch.
        console.warn("[mcp-oauth] purge did not cover the full keyspace");
      }

      // Daily referral-sale sweep: catches paid Autumn invoices the
      // billing.updated webhook path misses (renewals, one-time top-ups).
      try {
        await sweepDubReferredOrganizations();
      } catch (err) {
        console.error("[cron] Dub referral sale sweep failed:", err);
      }
    }

    // Watchdog first: reconcile audits stuck in "running" whose workflow died
    // without reaching mark-failed (OOM/CPU kills, expired instances). Runs
    // before the rank loop so a slow tick can't delay or starve it. Its
    // failure is held until after the rank checks so it can't suppress them,
    // then rethrown so the invocation still reports as failed.
    let watchdogError: unknown;
    try {
      await withPgClient(() => reconcileStaleAudits());
    } catch (err) {
      watchdogError = err;
      console.error("[cron] Stale-audit reconcile failed:", err);
    }

    // The nightly GEO patrol runs here, on **every** tick. Its own 24-hour
    // cadence filter in `listDueTargets` is what makes a 5-minute tick a no-op,
    // so the work is dispatched often and *admitted* once a day. That is
    // deliberate: the due decision reads a full history and is a duration, not a
    // column, so it belongs in JS — but the *budget* and the fault isolation
    // belong on the shared tick.
    //
    // It is isolated in its own try/catch for the same reason the watchdog is:
    // a DataForSEO outage must not stop rank tracking, and a rank-tracking
    // outage must not stop the archive from filling.
    try {
      await withPgClient(() => runDueGeoPatrols());
    } catch (err) {
      console.error("[cron] GEO patrol failed:", err);
    }

    // The queue drain follows the patrol, and it is a *different clock*.
    //
    // The patrol posts and returns; this collects. The vendor documents **up to
    // 72 hours** for a Standard task and decides for itself when one is ready, so
    // collecting only when a patrol posts would sample a backlog and present the
    // sample as a collection. So this is dispatched on **every** tick and gated
    // internally by the queue's own age — a tick arriving 40 minutes after the
    // last look does nothing and says why.
    //
    // It runs after the patrol for the obvious reason: a task posted a minute ago
    // cannot be ready now, and looking first would only ever find yesterday's
    // work. That is the wrong order for correctness but costs nothing either
    // way, and after is the order that reads as intent.
    //
    // Isolated in its own try/catch like the rest: a vendor queue that is down
    // must not stop the archive from filling.
    try {
      await withPgClient(() => runQueueDrain());
    } catch (err) {
      console.error("[cron] GEO queue drain failed:", err);
    }

    // ── The three billable nightly captures ──────────────────────────────────
    //
    // **These run on the nightly tick and on nothing else**, and that single
    // sentence is the entire fix for the most expensive bug this repo has had.
    //
    // They used to be dispatched on **every** tick, and each one's own code
    // claimed that was safe: the AI Mode runner carried an `alreadyRanInWindow`
    // hook that the cron caller never passed, and the AI-keyword and ETV runners
    // had no run log at all — only a `lastAskedAt` rotation, which reorders who
    // gets measured and never decides *whether* to measure. So on a
    // `*/5 * * * *` tick all three ran, all day, every day.
    //
    // The cost, at the caps these files set for themselves: ETV at $0.012 a call
    // across 25 domains is $0.30 a night — collected 288 times a night it is
    // $86/day, ~$2,590/month per deployment. The code's own comments price a
    // night at "$0.05" and "one point per tracked domain, per night".
    //
    // Nothing caught it because every number the sweeps report is internal to
    // the sweep: `projectsVisited` counted rows the sweep itself had just
    // chosen, so the log line read exactly the same after the first tick and the
    // two-hundred-and-eighty-eighth. **A budget that is checked per tick bounds
    // a tick, not a night**, and that is the shape to remember.
    //
    // The patrol, the queue drain, the watchdog, retention and rank checks stay
    // on every tick below: each of those is either free or carries its own
    // 24-hour cadence filter, and the patrol's filter is what makes a 5-minute
    // tick a no-op for it. Only the three that *bill* are gated.
    if (isNightlyTick) {
      await withPgClient(() => runNightlyBillableCaptures());
    }

    // Retention follows the patrol on the same tick: the sweep only deletes what
    // is already past the window, so running it right after tonight's patrol is
    // the natural order — collect, then age out.
    try {
      await withPgClient(() => runScheduledGeoRetention(env));
    } catch (err) {
      console.error("[cron] GEO retention failed:", err);
    }

    // Scope a per-request Postgres client for the cron run (no-op in D1 mode).
    await withPgClient(() => runScheduledRankChecks(env));
    if (watchdogError) throw watchdogError;
  },
};
