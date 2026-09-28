import { ToolTable } from "@/lib/free-tools/tool-table";
import { useEffect, useState } from "react";
import { FIELD_CLASS, SubmitButton, ToolForm } from "@/lib/free-tools/form";
import { formatCount, InfoTip, MetricGrid } from "@/lib/free-tools/metric-grid";
import { UpsellCard } from "@/lib/free-tools/upsell-card";
import { useToolRun } from "@/lib/free-tools/use-tool-run";

const TOOL = "backlink-checker";

type BacklinkRow = {
  domainFrom: string | null;
  urlFrom: string | null;
  urlTo: string | null;
  pageTitle: string | null;
  anchor: string | null;
  dofollow: boolean | null;
  domainRank: number | null;
};

type CheckResult = {
  target: string;
  summary: {
    rank: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    brokenBacklinks: number | null;
  };
  topBacklinks: BacklinkRow[];
};

export function BacklinkCheckerTool({
  initialTarget,
}: {
  initialTarget?: string;
}) {
  const [target, setTarget] = useState("");
  const { status, errorMessage, result, run } = useToolRun<CheckResult>(
    TOOL,
    "/api/backlink-check",
  );

  // Applied after hydration so the prerendered HTML and the first client
  // render agree, whatever ?target= the visitor arrived with.
  useEffect(() => {
    if (initialTarget) setTarget(initialTarget);
  }, [initialTarget]);

  return (
    <div>
      <ToolForm
        onSubmit={run}
        input={{ target }}
        status={status}
        errorMessage={errorMessage}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="backlink-target" className="sr-only">
            Domain to check
          </label>
          <input
            id="backlink-target"
            name="target"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="example.com"
            disabled={status === "loading"}
            className={FIELD_CLASS}
          />
          <SubmitButton status={status} idleLabel="Check backlinks" />
        </div>
      </ToolForm>

      {status === "done" && result ? <CheckResults result={result} /> : null}
    </div>
  );
}

function CheckResults({ result }: { result: CheckResult }) {
  const { summary, topBacklinks } = result;
  const total = summary.backlinks;
  const hasMore = typeof total === "number" && total > topBacklinks.length;

  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-950">
        Backlink profile for{" "}
        <span className="text-[var(--color-brand-accent)]">
          {result.target}
        </span>
      </h2>

      <div className="mt-4">
        <MetricGrid
          metrics={[
            {
              label: "Domain rank",
              value: formatCount(summary.rank),
              tip: "DataForSEO's 0-100 strength score for a domain's link profile. Similar idea to Ahrefs DR or Moz DA, but each tool uses its own index and formula, so numbers differ between tools.",
            },
            {
              label: "Backlinks",
              value: formatCount(summary.backlinks),
              tip: "Total individual links pointing at this domain, counting multiple links from the same website.",
            },
            {
              label: "Referring domains",
              value: formatCount(summary.referringDomains),
              tip: "Unique websites that link to this domain at least once.",
            },
            {
              label: "Broken backlinks",
              value: formatCount(summary.brokenBacklinks),
              tip: "Links pointing at pages on this domain that no longer load, such as deleted pages returning 404.",
            },
          ]}
        />
      </div>

      {topBacklinks.length > 0 ? (
        <ToolTable label="Backlink Checker results" className="mt-4">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-xs text-[var(--color-brand-muted)]">
                <th className="px-4 py-3 font-medium">
                  Rank
                  <InfoTip tip="Strength (0-100) of the linking website's own link profile. Links from higher-rank domains generally carry more weight." />
                </th>
                <th className="px-4 py-3 font-medium">Referring page</th>
                <th className="px-4 py-3 font-medium">
                  Anchor and target
                  <InfoTip tip="The clickable text of the link, and the page on this domain the link points to." />
                </th>
                <th className="px-4 py-3 font-medium">
                  Type
                  <InfoTip
                    tip="Follow links can pass ranking value to the target. Nofollow links ask search engines not to count them."
                    align="right"
                  />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {topBacklinks.map((row) => (
                <tr key={row.urlFrom ?? row.domainFrom ?? ""}>
                  <td className="px-4 py-3 align-top tabular-nums text-neutral-950">
                    {formatCount(row.domainRank)}
                  </td>
                  <td className="max-w-[300px] px-4 py-3 align-top">
                    <p className="truncate font-medium text-neutral-950">
                      {row.pageTitle ?? row.domainFrom ?? "—"}
                    </p>
                    {row.urlFrom ? (
                      <a
                        href={row.urlFrom}
                        target="_blank"
                        rel="nofollow noopener noreferrer"
                        className="block truncate text-xs text-[var(--color-brand-muted)] hover:text-neutral-900 hover:underline"
                      >
                        {row.urlFrom}
                      </a>
                    ) : null}
                  </td>
                  <td className="max-w-[260px] px-4 py-3 align-top">
                    <p className="truncate text-neutral-700">
                      {row.anchor ?? "—"}
                    </p>
                    {row.urlTo ? (
                      <p className="truncate text-xs text-[var(--color-brand-muted)]">
                        {row.urlTo}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span
                      className={
                        row.dofollow
                          ? "rounded-full border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs font-medium text-neutral-900"
                          : "rounded-full px-2 py-0.5 text-xs text-neutral-500"
                      }
                    >
                      {row.dofollow ? "Follow" : "Nofollow"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ToolTable>
      ) : (
        <p className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-white p-5 text-sm text-neutral-700">
          No live backlinks found for this domain in the index yet.
        </p>
      )}

      <UpsellCard tool={TOOL} cta="Explore more backlinks">
        {hasMore ? (
          <>
            Showing the top {topBacklinks.length} backlinks, one per referring
            domain, strongest domains first.{" "}
            <span className="font-medium text-neutral-950">
              {formatCount(total)} total backlinks
            </span>{" "}
            are in the index for this domain.
          </>
        ) : (
          <>
            Explore the full picture: referring domains, anchors, new and lost
            links, and spam signals.
          </>
        )}
      </UpsellCard>
    </div>
  );
}
