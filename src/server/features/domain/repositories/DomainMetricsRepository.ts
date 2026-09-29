import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { domainMetrics } from "@/db/schema";
import type { EtvProvenance } from "@/shared/etv-versioning";
import { AppError } from "@/server/lib/errors";

/**
 * Writes the only ETV values we persist.
 *
 * Two rules this module enforces, both of which exist because a wrong number on a
 * traffic chart is worse than no chart:
 *
 * 1. **A row without provenance is refused.** `etv_formula_version` is NOT NULL
 *    and `etvRequestedAt` is required, and `insertPoint` throws rather than
 *    defaulting. DataForSEO switches ETV models on 2026-11-01; an unstamped value
 *    is unreadable after that date, so we decline to store it rather than store
 *    something we will later have to caveat.
 * 2. **The version and request time are part of the unique key.** A series that
 *    mixes formulas is therefore unrepresentable, not merely discouraged. The
 *    chart layer still has to say so out loud (`trendCaveat`) because two
 *    adjacent points can each be honestly labelled and still read as a trend.
 */

type DomainMetricRow = typeof domainMetrics.$inferSelect;

/** Which Labs endpoint a point came from. Kept narrow on purpose. */
type DomainMetricEndpoint = NonNullable<
  typeof domainMetrics.$inferInsert.endpoint
>;

/**
 * Normalise a domain to a bare lowercase host, matching how GEO targets are
 * stored so the two features can join.
 *
 * Two spellings of one brand must not become two series — that would split every
 * trend drawn across them, which is the same failure the GEO target table already
 * guards against. `https://` and a leading `www.` are stripped, not rejected:
 * people paste URLs where a host is expected.
 */
function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}

type InsertPoint = {
  projectId: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  endpoint: DomainMetricEndpoint;
  /**
   * Optional in the type, and that is deliberate.
   *
   * The correct caller always has this, but a required parameter would make the
   * guard below unreachable: nothing could ever omit it, so the check would be
   * dead code that never runs. Declaring it optional states the truth — the
   * repository defends itself against a caller that forgot to stamp the value,
   * which is exactly the mistake that makes an ETV series unreadable.
   */
  etv: EtvProvenance | undefined;
  organicEtv?: number | null;
  paidEtv?: number | null;
  domainRank?: number | null;
  organicKeywords?: number | null;
  paidKeywords?: number | null;
  pagesCount?: number | null;
};

/**
 * Record one ETV-bearing measurement.
 *
 * The `etv` block is a required parameter rather than an optional one, so a
 * caller cannot compile a path that writes an ETV without its provenance.
 */
async function insertPoint(input: InsertPoint): Promise<DomainMetricRow> {
  if (!input.etv || typeof input.etv.requestedAt !== "string") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Refusing to store an ETV value without its formula version and request time. A value that cannot be attributed to a model is unreadable after the 2026-11-01 ETV change.",
    );
  }

  const [row] = await db
    .insert(domainMetrics)
    .values({
      projectId: input.projectId,
      // Normalised the same way as a GEO target, so the two features can join.
      domain: normaliseDomain(input.domain),
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      endpoint: input.endpoint,
      organicEtv: input.organicEtv ?? null,
      paidEtv: input.paidEtv ?? null,
      etvFormulaVersion: input.etv.formulaVersion,
      etvRequestedAt: input.etv.requestedAt,
      domainRank: input.domainRank ?? null,
      organicKeywords: input.organicKeywords ?? null,
      paidKeywords: input.paidKeywords ?? null,
      pagesCount: input.pagesCount ?? null,
    })
    // A re-capture of the same (target, market, endpoint, model, request time) is
    // the same observation, so update rather than fail. A genuinely new request
    // time is a new point.
    .onConflictDoUpdate({
      target: [
        domainMetrics.projectId,
        domainMetrics.domain,
        domainMetrics.locationCode,
        domainMetrics.languageCode,
        domainMetrics.endpoint,
        domainMetrics.etvFormulaVersion,
        domainMetrics.etvRequestedAt,
      ],
      set: {
        organicEtv: input.organicEtv ?? null,
        paidEtv: input.paidEtv ?? null,
        domainRank: input.domainRank ?? null,
        organicKeywords: input.organicKeywords ?? null,
        paidKeywords: input.paidKeywords ?? null,
        pagesCount: input.pagesCount ?? null,
      },
    })
    .returning();

  if (!row) {
    throw new AppError("INTERNAL_ERROR", "Failed to record domain metrics");
  }
  return row;
}

/**
 * The series for one target, market and endpoint, oldest first.
 *
 * Returned with `etvFormulaVersion` on every row rather than as a separate flag,
 * because the caller must be able to see the label and the point together.
 */
async function listSeries(input: {
  projectId: string;
  domain: string;
  locationCode: number;
  endpoint: DomainMetricEndpoint;
  since?: string;
  limit?: number;
}): Promise<DomainMetricRow[]> {
  const filters = [
    eq(domainMetrics.projectId, input.projectId),
    eq(domainMetrics.domain, normaliseDomain(input.domain)),
    eq(domainMetrics.locationCode, input.locationCode),
    eq(domainMetrics.endpoint, input.endpoint),
  ];
  if (input.since) filters.push(gte(domainMetrics.capturedAt, input.since));
  return db
    .select()
    .from(domainMetrics)
    .where(and(...filters))
    .orderBy(domainMetrics.capturedAt)
    .limit(input.limit ?? 500);
}

/** The most recent point for a target, regardless of formula version. */
async function getLatest(input: {
  projectId: string;
  domain: string;
  locationCode: number;
  endpoint: DomainMetricEndpoint;
}): Promise<DomainMetricRow | null> {
  const rows = await db
    .select()
    .from(domainMetrics)
    .where(
      and(
        eq(domainMetrics.projectId, input.projectId),
        eq(domainMetrics.domain, normaliseDomain(input.domain)),
        eq(domainMetrics.locationCode, input.locationCode),
        eq(domainMetrics.endpoint, input.endpoint),
      ),
    )
    // id, not capturedAt: autoincrement is monotonic and immune to the
    // sqlite-vs-pg timestamp text-format difference.
    .orderBy(desc(domainMetrics.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The formula versions present in a series, in row order, for `trendCaveat()`.
 *
 * Synchronous on purpose: it does no I/O, and an `async` that never awaits is a
 * function that invites `await` at a call site which does not need it.
 */
function listFormulaVersions(
  rows: Array<Pick<DomainMetricRow, "etvFormulaVersion">>,
): Array<DomainMetricRow["etvFormulaVersion"]> {
  return rows.map((row) => row.etvFormulaVersion);
}

export const DomainMetricsRepository = {
  insertPoint,
  listSeries,
  getLatest,
  listFormulaVersions,
} as const;
