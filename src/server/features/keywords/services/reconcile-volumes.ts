/**
 * Reconcile the volumes this product shows against clickstream measurement.
 *
 * ## Why this is a service and not part of the tool that first needed it
 *
 * The MCP tool `reconcile_keyword_volumes` was the first caller, and it grew the whole use
 * case inside itself: two data requests, a join on the keyword, and the verdicts. The next
 * caller (an app entry point, a scheduled check, a report) would have copied that, and the
 * two copies would drift on the things that matter here: which side is the reference, and
 * what happens when a country figure is missing. So the use case lives here and callers
 * shape only their own presentation.
 *
 * ## Two requests, and the reference side is the product's own path
 *
 * The reference volume comes from `fetchKeywordMetricsForList` — the same function that
 * populates the product — rather than from stored rows or a second derivation. That is what
 * makes the comparison a statement about *what a reader was shown* rather than about a
 * number this service computed for itself.
 *
 * The measurement comes from the clickstream client, which is billed **per call** rather
 * than per keyword, so the whole batch travels in one request. It is arbitration: it
 * settles a question, and it never replaces the volume on screen.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo/client";
import { fetchKeywordMetricsForList } from "@/server/lib/dataforseo/keyword-metrics";
import {
  reconcileVolume,
  summariseReconciliation,
} from "@/shared/volume-reconciliation";

type VolumeReconciliationRow = {
  keyword: string;
  referenceVolume: number | null;
  countryVolume: number | null;
  globalVolume: number | null;
  verdict:
    | "corroborated"
    | "measured-higher"
    | "measured-lower"
    | "uncomparable";
  note: string;
};

type VolumeReconciliation = {
  countryIsoCode: string;
  summary: ReturnType<typeof summariseReconciliation>;
  rows: VolumeReconciliationRow[];
};

export async function reconcileVolumes(input: {
  billing: BillingCustomerContext;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  /**
   * The market the reference figures describe. Required rather than inferred: the
   * clickstream breakdown is keyed by ISO-3166 alpha-2 and the endpoint takes no
   * `location_code`, so there is nothing here to map a DataForSEO market onto, and a
   * default would silently compare one market's figures against another's measurement.
   */
  countryIsoCode: string;
}): Promise<VolumeReconciliation> {
  const client = createDataforseoClient(input.billing);

  const metrics = await fetchKeywordMetricsForList(client, {
    keywords: input.keywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    creditFeature: "keyword_research",
  });
  const measured = await client.keywords.clickstreamVolumes({
    keywords: input.keywords,
  });

  const referenceByKeyword = new Map(
    metrics.map((row) => [row.keyword.toLowerCase(), row.searchVolume]),
  );
  const measuredByKeyword = new Map(
    measured.map((row) => [row.keyword.toLowerCase(), row]),
  );

  const rows = input.keywords.map((keyword) => {
    const key = keyword.trim().toLowerCase();
    const measurement = measuredByKeyword.get(key);
    return reconcileVolume({
      keyword: key,
      referenceVolume: referenceByKeyword.get(key) ?? null,
      globalVolume: measurement?.globalVolume ?? null,
      countryDistribution: measurement?.countryDistribution ?? [],
      countryIsoCode: input.countryIsoCode,
    });
  });

  return {
    countryIsoCode: input.countryIsoCode,
    summary: summariseReconciliation(rows),
    rows: rows.map((row) => ({
      keyword: row.keyword,
      referenceVolume: row.referenceVolume,
      countryVolume: row.countryVolume,
      globalVolume: row.globalVolume,
      verdict: row.verdict,
      note: row.note,
    })),
  };
}
