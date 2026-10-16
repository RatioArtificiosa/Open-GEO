import { useMutation } from "@tanstack/react-query";
import { History, Network, Swords } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getDomainCompetitors,
  getDomainHistoricalRanks,
  getDomainSubdomains,
} from "@/serverFunctions/domain";
import { DFS_LABS } from "@/shared/dataforseo-pricing";

/**
 * First UI callers for the three CL-401 endpoints (CL-401 closes).
 *
 * Three priced sections below the keywords/pages panel. Nothing is charged
 * until the reader presses the button — the price is on it, read from the
 * price book rather than typed into the markup, the same shape as the Market
 * Map and the page-speed crawl. Each section reads through its metered server
 * function once per click; the 12-hour R2 cache in the service makes a second
 * click free.
 */

const LIST_LIMIT = 50;

type IntelProps = {
  projectId: string;
  domain: string;
  locationCode: number | undefined;
};

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function SectionShell({
  icon,
  title,
  blurb,
  price,
  actionLabel,
  pending,
  loaded,
  onLoad,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  price: string;
  actionLabel: string;
  pending: boolean;
  loaded: boolean;
  onLoad: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-base-content/60">{blurb}</p>
          </div>
        </div>
        {!loaded ? (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              className="btn btn-sm btn-outline"
              disabled={pending}
              onClick={onLoad}
            >
              {pending ? "Loading…" : actionLabel}
            </button>
            <span className="text-xs text-base-content/60">
              About <span className="font-mono">${price}</span> in credits
            </span>
          </div>
        ) : null}
      </div>
      {loaded ? children : null}
    </section>
  );
}

type MonthRow = {
  year: number;
  month: number;
  organicTraffic: number | null;
  organicKeywords: number | null;
};

function HistorySection({ projectId, domain, locationCode }: IntelProps) {
  const history = useMutation({
    mutationFn: () =>
      getDomainHistoricalRanks({
        data: { projectId, domain, locationCode },
      }),
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Could not load history.")),
  });
  // Six months is the vendor's default window — the button quotes the window
  // it actually requests, computed from the book rather than typed.
  const price = (
    DFS_LABS.historicalRank.perRequest +
    DFS_LABS.historicalRank.perUnit * 6
  ).toFixed(3);
  const months = (history.data?.months ?? []) as MonthRow[];
  return (
    <SectionShell
      icon={<History className="size-4 text-base-content/45" />}
      title="Traffic history"
      blurb="Monthly organic traffic and keywords for the last six months."
      price={price}
      actionLabel="Load history"
      pending={history.isPending}
      loaded={history.isSuccess}
      onLoad={() => history.mutate()}
    >
      {months.length === 0 ? (
        <p className="pt-3 text-sm text-base-content/70">
          No monthly history for this domain. That is an answer, not a failure:
          a site with no measured months has no trend to draw.
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-base-300 mt-3">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="text-right">Organic visits</th>
                  <th className="text-right">Ranking keywords</th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr key={`${row.year}-${row.month}`}>
                    <td className="font-mono text-xs">
                      {row.year}-{String(row.month).padStart(2, "0")}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {formatCount(row.organicTraffic)}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {formatCount(row.organicKeywords)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pt-2 text-xs text-base-content/60">
            Traffic uses the legacy ETV formula: historical endpoints are
            excluded from the new ETV model, so this series is not comparable to
            post-cutover figures.
          </p>
        </>
      )}
    </SectionShell>
  );
}

type TrafficRow = {
  name: string;
  organicTraffic: number | null;
  organicKeywords: number | null;
};

function SubdomainsSection({ projectId, domain, locationCode }: IntelProps) {
  const query = useMutation({
    mutationFn: () =>
      getDomainSubdomains({
        data: { projectId, domain, locationCode, limit: LIST_LIMIT },
      }),
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Could not load subdomains.")),
  });
  const price = (
    DFS_LABS.standard.perRequest +
    DFS_LABS.standard.perUnit * LIST_LIMIT
  ).toFixed(3);
  const rows = (query.data?.rows ?? []) as TrafficRow[];
  return (
    <SectionShell
      icon={<Network className="size-4 text-base-content/45" />}
      title="Subdomains"
      blurb="Where the domain's visibility actually lives — blog, docs, app."
      price={price}
      actionLabel="Load subdomains"
      pending={query.isPending}
      loaded={query.isSuccess}
      onLoad={() => query.mutate()}
    >
      {rows.length === 0 ? (
        <p className="pt-3 text-sm text-base-content/70">
          No subdomains with measured traffic. The whole footprint sits on the
          root domain.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-base-300 mt-3">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Subdomain</th>
                <th className="text-right">Organic visits</th>
                <th className="text-right">Ranking keywords</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td className="text-sm">{row.name}</td>
                  <td className="text-right font-mono text-xs">
                    {formatCount(row.organicTraffic)}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {formatCount(row.organicKeywords)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}

function CompetitorsSection({ projectId, domain, locationCode }: IntelProps) {
  const query = useMutation({
    mutationFn: () =>
      getDomainCompetitors({
        data: { projectId, domain, locationCode, limit: LIST_LIMIT },
      }),
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not load competitors."),
      ),
  });
  const price = (
    DFS_LABS.standard.perRequest +
    DFS_LABS.standard.perUnit * LIST_LIMIT
  ).toFixed(3);
  const rows = (query.data?.rows ?? []) as TrafficRow[];
  return (
    <SectionShell
      icon={<Swords className="size-4 text-base-content/45" />}
      title="Competitors"
      blurb="Who competes with this domain in organic search."
      price={price}
      actionLabel="Load competitors"
      pending={query.isPending}
      loaded={query.isSuccess}
      onLoad={() => query.mutate()}
    >
      {rows.length === 0 ? (
        <p className="pt-3 text-sm text-base-content/70">
          No competitors measured in this market. Try a broader market or a
          larger domain.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-base-300 mt-3">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Competitor</th>
                <th className="text-right">Organic visits</th>
                <th className="text-right">Ranking keywords</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td className="text-sm">{row.name}</td>
                  <td className="text-right font-mono text-xs">
                    {formatCount(row.organicTraffic)}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {formatCount(row.organicKeywords)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}

export function DomainIntelSections({
  projectId,
  domain,
  locationCode,
}: IntelProps) {
  return (
    <div className="space-y-3">
      <HistorySection
        projectId={projectId}
        domain={domain}
        locationCode={locationCode}
      />
      <SubdomainsSection
        projectId={projectId}
        domain={domain}
        locationCode={locationCode}
      />
      <CompetitorsSection
        projectId={projectId}
        domain={domain}
        locationCode={locationCode}
      />
    </div>
  );
}
