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
import { getIsoCountryCode } from "@/shared/keyword-locations";

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
   * The market the reference figures describe, as ISO-3166 alpha-2. **Optional**, because the
   * project's own market resolves to one: `getIsoCountryCode` maps a location code to ISO and
   * carries the single divergence in the supported list (the United Kingdom's label is `UK`,
   * its ISO code is `GB`). Pass it to check a different market deliberately.
   */
  countryIsoCode?: string;
}): Promise<VolumeReconciliation> {
  const client = createDataforseoClient(input.billing);
  // Uppercased for the summary and the prose; the comparison itself is case-insensitive.
  const countryIsoCode = (
    input.countryIsoCode ?? getIsoCountryCode(input.locationCode)
  ).toUpperCase();

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
      countryIsoCode,
    });
  });

  return {
    countryIsoCode,
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
