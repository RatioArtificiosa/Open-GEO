import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Gauge, Loader2 } from "lucide-react";
import { sortBy } from "remeda";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getPageWaterfall, startPageSpeedAudit } from "@/serverFunctions/audit";
import { DFS_ONPAGE } from "@/shared/dataforseo-pricing";
import { phaseSegments } from "./pageSpeedModel";

/**
 * "Why is this page slow?"
 *
 * ## The crawl is queued, so this cannot finish in one step
 *
 * The vendor measures page timings by crawling, and a crawl takes minutes. Pretending otherwise
 * would mean a spinner that hangs or a poll inside a request. So the flow is explicit: start the
 * crawl, then check for results. **The check is free** — the vendor charges for the crawl and
 * not for the read — which is what makes "check as often as you like" a truthful thing to say
 * rather than a nice-sounding one.
 *
 * ## The two numbers that explain a page
 *
 * Above, a stacked bar of the *document's* four phases, which genuinely sum to its duration.
 * Below, the resources ranked by time, which deliberately are **not** stacked: they overlap, so
 * their durations add up to nothing meaningful and drawing them as a bar would invent a total.
 */
export function PageSpeedModal({
  projectId,
  pageUrl,
  onClose,
}: {
  projectId: string;
  pageUrl: string;
  onClose: () => void;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () =>
      startPageSpeedAudit({ data: { projectId, url: pageUrl } }),
    onSuccess: (result) => setTaskId(result.taskId),
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Could not start the crawl.")),
  });

  const read = useMutation({
    mutationFn: () =>
      getPageWaterfall({
        data: { projectId, taskId: taskId ?? "", url: pageUrl },
      }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not read the waterfall."),
      ),
  });

  const page = read.data?.pages[0];
  const crawlCostUsd =
    (DFS_ONPAGE.basePage ?? 0) * (DFS_ONPAGE.loadResources ?? 1);

  return (
    <Modal maxWidth="max-w-2xl" labelledBy="page-speed-title" onClose={onClose}>
      <div>
        <h3 id="page-speed-title" className="text-lg font-semibold">
          Page speed
        </h3>
        <p className="text-xs text-base-content/60 break-all">{pageUrl}</p>
      </div>

      {page ? (
        <PageSpeedResult
          page={page}
          crawlProgress={read.data?.crawlProgress ?? null}
        />
      ) : (
        <p className="text-sm text-base-content/70">
          Lighthouse already said this page is slow. A waterfall says what it
          waited for: every file it loaded and how long each one took. That has
          to be measured by crawling the page, so these numbers come from a
          crawl rather than from the audit.
        </p>
      )}

      {page ? null : taskId ? (
        <div className="space-y-3">
          <p className="text-xs text-base-content/60">
            The crawl is queued — a few minutes, usually. Checking costs
            nothing, so come back to this dialog as often as you like.
          </p>
          <button
            type="button"
            className="btn btn-sm gap-2"
            onClick={() => read.mutate()}
            disabled={read.isPending}
          >
            {read.isPending && <Loader2 className="size-3.5 animate-spin" />}
            Check for results
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Gauge className="size-5 text-primary" />
          </div>
          <div className="flex-1">
            <p className="font-medium">Crawl this page for timings</p>
            <p className="text-xs text-base-content/60">
              One page, resources loaded so timings exist
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono font-semibold">
              ~${crawlCostUsd.toFixed(5)}
            </p>
            <p className="text-xs text-base-content/60">reading is free</p>
            {start.isPending && (
              <Loader2 className="size-3 animate-spin ml-auto mt-1" />
            )}
          </div>
        </button>
      )}

      <div className="flex justify-end">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function PageSpeedResult({
  page,
  crawlProgress,
}: {
  page: {
    timeToInteractiveMs: number | null;
    durationTimeMs: number | null;
    connectionTimeMs: number | null;
    timeToSecureConnectionMs: number | null;
    waitingTimeMs: number | null;
    downloadTimeMs: number | null;
    resources: Array<{
      url: string | null;
      durationMs: number | null;
      isRenderBlocking: boolean | null;
    }>;
  };
  crawlProgress: string | null;
}) {
  const segments = phaseSegments(page);
  const total = page.durationTimeMs ?? 0;
  const slowest = sortBy(
    page.resources,
    (resource) => -(resource.durationMs ?? 0),
  ).slice(0, 8);
  const renderBlocking = page.resources.filter(
    (resource) => resource.isRenderBlocking === true,
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-lg">{Math.round(total)}</span>
        <span className="text-xs text-base-content/60">
          ms for the page itself
          {page.timeToInteractiveMs !== null
            ? `, interactive at ${Math.round(page.timeToInteractiveMs)} ms`
            : ""}
        </span>
      </div>

      {/* The document's own phases, which sum to its duration. */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-base-200">
        {segments.map((segment) =>
          segment.share === null || segment.share === 0 ? null : (
            <span
              key={segment.label}
              className={segment.className}
              style={{ width: `${segment.share * 100}%` }}
              title={`${segment.label}: ${segment.ms} ms`}
            />
          ),
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/60">
        {segments.map((segment) => (
          <span key={segment.label} className="inline-flex items-center gap-1">
            <span
              className={`inline-block size-2 rounded-sm ${segment.className}`}
            />
            {segment.label}
            {segment.ms === null ? " —" : ` ${Math.round(segment.ms)} ms`}
          </span>
        ))}
      </div>

      {slowest.length > 0 ? (
        <div className="max-h-64 overflow-auto rounded-lg border border-base-300">
          <table className="table table-sm">
            <thead className="sticky top-0 bg-base-100">
              <tr>
                <th>Slowest requests</th>
                <th className="text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {slowest.map((resource) => (
                <tr key={resource.url ?? Math.random()}>
                  <td
                    className="max-w-[380px] truncate text-xs"
                    title={resource.url ?? ""}
                  >
                    {resource.url ?? "—"}
                    {resource.isRenderBlocking === true ? (
                      <span className="badge badge-xs ml-2 border-0 bg-warning/20 text-warning">
                        blocks rendering
                      </span>
                    ) : null}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {resource.durationMs === null
                      ? "—"
                      : `${Math.round(resource.durationMs)} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-xs text-base-content/50">
        The phases above add up to the page&rsquo;s own load. The requests below
        do not: they overlap, so they are ranked rather than stacked —{" "}
        {renderBlocking} of {page.resources.length} block rendering.
        {crawlProgress === "in_progress"
          ? " This crawl is still running; more pages may arrive, though this one is complete."
          : ""}
      </p>
    </div>
  );
}
