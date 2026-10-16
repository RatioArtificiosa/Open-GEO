import { useMutation } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { findTechLeads } from "@/serverFunctions/domain";
import { DFS_DOMAIN } from "@/shared/dataforseo-pricing";
import { estimateTechLeadListUsd } from "@/shared/tech-lead-cost";

/**
 * Lead Lists: the tech-slicing surface (CL-408 closes).
 *
 * A WHOIS domain pattern plus the stack gap under it becomes a prospect
 * list with contacts. Nothing is charged until the button is pressed, and
 * the price is on it — read from the shared cost helper (the same number
 * the credit gate and the MCP dry run quote), never typed into the markup.
 * WHOIS is 10x technologies, so the button carries the WHOIS-heavy figure
 * out loud rather than in a footnote.
 */

const DEFAULT_CANDIDATES = 10;

function splitTech(input: string): string[] {
  return input
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function LeadsPage({ projectId }: { projectId: string }) {
  const [pattern, setPattern] = useState("");
  const [required, setRequired] = useState("shopify");
  const [excluded, setExcluded] = useState("klaviyo");
  const [maxCandidates, setMaxCandidates] = useState(DEFAULT_CANDIDATES);

  const search = useMutation({
    mutationFn: () =>
      findTechLeads({
        data: {
          projectId,
          domainPattern: pattern,
          requiredTech: splitTech(required),
          excludedTech: splitTech(excluded),
          maxCandidates,
        },
      }),
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Could not find leads.")),
  });

  // The list price for the current candidate count, from the book.
  const listUsd = estimateTechLeadListUsd(maxCandidates);
  const prospects = search.data?.prospects ?? [];
  const examined = search.data?.examined ?? 0;
  const failed = search.data?.failed ?? [];
  const perProspect =
    search.isSuccess && prospects.length > 0
      ? estimateTechLeadListUsd(maxCandidates) / prospects.length
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Lead Lists</h1>
        <p className="text-sm text-base-content/70">
          Domains matching a pattern whose stack runs what you sell into — with
          contacts where the vendor has them.
        </p>
      </header>

      <form
        className="flex flex-col gap-3 rounded-xl border border-base-300 bg-base-100 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (pattern.trim().length === 0 || splitTech(required).length === 0)
            return;
          search.mutate();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-base-content/70">
              Domain pattern
            </span>
            <input
              className="input input-bordered w-full"
              placeholder="plumb"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-base-content/70">
              Candidates to examine (max 25)
            </span>
            <input
              type="number"
              min={1}
              max={25}
              className="input input-bordered w-full"
              value={maxCandidates}
              onChange={(event) =>
                setMaxCandidates(
                  Math.max(
                    1,
                    Math.min(25, Math.floor(Number(event.target.value) || 1)),
                  ),
                )
              }
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-base-content/70">
              Must run (comma-separated)
            </span>
            <input
              className="input input-bordered w-full"
              placeholder="shopify"
              value={required}
              onChange={(event) => setRequired(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-base-content/70">
              Must not run (comma-separated)
            </span>
            <input
              className="input input-bordered w-full"
              placeholder="klaviyo"
              value={excluded}
              onChange={(event) => setExcluded(event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-primary gap-2"
            disabled={
              search.isPending ||
              pattern.trim().length === 0 ||
              splitTech(required).length === 0
            }
          >
            {search.isPending && <Loader2 className="size-4 animate-spin" />}
            <Users className="size-4" />
            Find leads
          </button>
          <p className="text-xs text-base-content/60">
            One list — about{" "}
            <span className="font-mono">${listUsd.toFixed(3)}</span>: $
            {DFS_DOMAIN.whois.perRequest.toFixed(2)} WHOIS plus $
            {DFS_DOMAIN.technologies.perRequest.toFixed(3)} per candidate.
          </p>
        </div>
      </form>

      {search.isSuccess ? (
        prospects.length === 0 ? (
          <p className="rounded-xl border border-base-300 p-6 text-sm text-base-content/70">
            No prospects running {splitTech(required).join(", ")} under &lsquo;
            {pattern}&rsquo; ({examined} candidates examined). That is an
            answer, not a failure: the gap may not exist in this slice.
          </p>
        ) : (
          <>
            <p className="text-sm text-base-content/80">
              <span className="font-semibold">{prospects.length}</span> prospect
              {prospects.length === 1 ? "" : "s"} of {examined} candidates
              {perProspect !== null
                ? ` — about $${perProspect.toFixed(3)} estimated per prospect`
                : ""}
              .
            </p>
            <div className="overflow-hidden rounded-xl border border-base-300">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Stack</th>
                    <th>Contacts</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((row) => (
                    <tr key={row.domain}>
                      <td className="text-sm">{row.domain}</td>
                      <td className="text-xs text-base-content/70">
                        {row.technologies.join(", ")}
                      </td>
                      <td className="text-xs">
                        {row.emails.length > 0 ? (
                          row.emails.join(", ")
                        ) : (
                          <span className="text-base-content/50">
                            no contacts on file
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {failed.length > 0 ? (
              <p className="text-xs text-base-content/60">
                {failed.length} candidate{failed.length === 1 ? "" : "s"} could
                not be read ({failed.map((f) => f.domain).join(", ")}); they are
                reported, not silently dropped.
              </p>
            ) : null}
          </>
        )
      ) : (
        <p className="rounded-xl border border-dashed border-base-300 p-6 text-sm text-base-content/60">
          Nothing is charged until you run the list.
        </p>
      )}
    </div>
  );
}
