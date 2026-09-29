import { AlertTriangle, Info } from "lucide-react";
import type {
  NewLostSeries,
  TopCitedPage,
} from "@/server/features/geo/services/geoLiveReads";
import { footnoteFor, type MetricId } from "./metric-copy";

/**
 * A footnote for one metric.
 *
 * Every number on this page carries one, and the copy comes from the shared
 * registry rather than being written here — see `metric-copy.ts` for why that
 * matters. `MetricId` rather than `string`, so a renamed metric is a compile
 * error rather than a card that quietly lost its explanation.
 */
export function MetricFootnote({ id }: { id: MetricId }) {
  return (
    <span
      className="tooltip inline-flex align-text-bottom"
      data-tip={footnoteFor(id)}
    >
      <Info className="text-base-content/40 size-3" />
      <span className="sr-only">{footnoteFor(id)}</span>
    </span>
  );
}

/**
 * The two live panels: new/lost mentions, and the pages models cite most.
 *
 * Both are **metered** — unlike everything else on this page they hit the vendor
 * on open — so both render a clear cost boundary rather than pretending to be
 * free. A reader who cannot tell a paid call from a stored read is the exact
 * person who does not trust the number.
 *
 * The honesty rules that matter here:
 *
 * 1. **New and lost are never netted.** A brand that lost 10 and gained 10 shows
 *    "10 new, 10 lost", not "no change" — the net hides the churn, and the
 *    churn is the thing worth acting on.
 * 2. **An empty window reads as "no data", not "nothing changed".**
 * 3. **A cited page is shown with its tracking parameters stripped for display**
 *    but never rewritten in the payload — the archive keeps what the vendor
 *    actually returned.
 *
 * The row and series types are imported from the service rather than restated
 * here: a client type that drifts from the server's is how a panel ends up
 * rendering `undefined` for a field the API renamed.
 */

export function NewLostPanel({
  platformLabel,
  series,
  isLoading,
  errorMessage,
  isLocked,
}: {
  platformLabel: string;
  series: NewLostSeries | null;
  isLoading: boolean;
  errorMessage: string | null;
  isLocked: boolean;
}) {
  if (isLocked) return <LockedPanel feature="New and lost mentions" />;
  if (isLoading)
    return <PanelShell title={`${platformLabel} — new and lost`} />;
  if (errorMessage) {
    return (
      <PanelShell title={`${platformLabel} — new and lost`}>
        <p className="flex items-start gap-2 text-sm text-base-content/70">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          {errorMessage}
        </p>
      </PanelShell>
    );
  }
  if (!series) return null;

  if (series.totals === null) {
    return (
      <PanelShell title={`${platformLabel} — new and lost`}>
        {/* Not "0 new, 0 lost". The vendor returned nothing for this window,
            which is a different claim from "nothing appeared". */}
        <p className="text-sm text-base-content/60">
          No data for this window. The vendor holds mentions history from August
          2025 and compares two snapshots, so a window it cannot compare comes
          back empty rather than zero.
        </p>
      </PanelShell>
    );
  }

  const { newMentions, lostMentions } = series.totals;

  return (
    <PanelShell title={`${platformLabel} — new and lost`}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-base-content/60 text-xs">New mentions</p>
          <p
            className="text-2xl font-semibold"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            +{newMentions.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-base-content/60 text-xs">Lost mentions</p>
          <p
            className="text-2xl font-semibold"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            &minus;{lostMentions.toLocaleString()}
          </p>
        </div>
      </div>
      <p className="text-base-content/60 mt-2 text-xs">
        Counted separately on purpose. A net figure would read &ldquo;no
        change&rdquo; for a month in which ten prompts appeared and ten
        disappeared, and the churn is the finding.
      </p>
      {series.rows.length > 0 ? (
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-base-content/60 text-left">
              <th className="font-normal">Week</th>
              <th className="font-normal">New</th>
              <th className="font-normal">Lost</th>
            </tr>
          </thead>
          <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
            {series.rows.slice(0, 8).map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>{row.newMentions ?? "—"}</td>
                <td>{row.lostMentions ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </PanelShell>
  );
}

export function TopCitedPanel({
  platformLabel,
  pages,
  isLoading,
  errorMessage,
  isLocked,
}: {
  platformLabel: string;
  pages: TopCitedPage[] | null;
  isLoading: boolean;
  errorMessage: string | null;
  isLocked: boolean;
}) {
  if (isLocked) return <LockedPanel feature="Top cited pages" />;
  if (isLoading) return <PanelShell title={`${platformLabel} — top cited`} />;
  if (errorMessage) {
    return (
      <PanelShell title={`${platformLabel} — top cited`}>
        <p className="flex items-start gap-2 text-sm text-base-content/70">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          {errorMessage}
        </p>
      </PanelShell>
    );
  }
  if (!pages) return null;

  if (pages.length === 0) {
    return (
      <PanelShell title={`${platformLabel} — top cited`}>
        <p className="text-sm text-base-content/60">
          The models have not cited any page for this brand in the current
          ranking. That is a real finding, not missing data — it is the state
          this product exists to report.
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell title={`${platformLabel} — top cited`}>
      <ol className="space-y-1 text-sm">
        {pages.map((page, index) => (
          <li key={page.url} className="flex items-baseline gap-2">
            <span className="text-base-content/50 w-5 shrink-0 tabular-nums">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate" title={page.url}>
              {/* Display strips the tracking parameters the vendor attaches;
                  the payload keeps the original URL. */}
              {stripTracking(page.url)}
            </span>
            <span
              className="text-base-content/70 shrink-0 tabular-nums"
              title="Estimated mentions"
            >
              {page.mentions ?? "—"}
            </span>
          </li>
        ))}
      </ol>
    </PanelShell>
  );
}

/**
 * Remove the vendor's tracking parameters for display.
 *
 * DataForSEO returns page URLs carrying query strings such as
 * `?utm_source=chatgpt.com`, which are noise to a reader and useful evidence to
 * us. So the stored value is untouched and only the rendered string is cleaned.
 */
export function stripTracking(url: string): string {
  const trimmed = url.trim();
  // A relative or malformed value is left exactly as it came.
  if (!trimmed.includes("://")) return trimmed;
  const [before, after] = trimmed.split("?", 2);
  if (after === undefined) return trimmed;
  const [path] = before.split("#", 2);
  return path ?? before;
}

function PanelShell({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-base-300 bg-base-100 p-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function LockedPanel({ feature }: { feature: string }) {
  return (
    <section className="rounded-xl border border-dashed border-base-300 p-4">
      <h3 className="text-base font-semibold">{feature}</h3>
      <p className="text-sm text-base-content/70">
        This panel queries the vendor live each time it opens, so it is part of
        the paid plan. Everything else on this page — the trend, the citation
        gap, the traffic series — is included and reads from your archive.
      </p>
    </section>
  );
}
