import { AppError } from "@/server/lib/errors";
import { DomainMetricsRepository } from "@/server/features/domain/repositories/DomainMetricsRepository";
import { AiMentionHistoryRepository } from "@/server/features/geo/repositories/AiMentionHistoryRepository";
import {
  GeoSetupRepository,
  type GeoPlatform,
} from "@/server/features/geo/repositories/GeoSetupRepository";
import { normaliseDomain } from "@/server/features/geo/domain";

/**
 * The two time-series reads behind the dashboard's charts.
 *
 * Split out of `GeoService` because both exist for one reason — a chart needs a
 * series, and a series has to be honest about what it is measuring — and because
 * they are the only reads in the service that are not about a single run or a
 * single answer. `GeoService` stayed under the 400-line limit because these left
 * it.
 *
 * Both derive the market from the target rather than accepting it, which is the
 * rule that stops a US-only archive being read as though it described another
 * region. Both take `platform` explicitly and neither has a combined variant.
 */

/**
 * The stored monthly mentions series for a target, on one platform.
 *
 * The market comes from the **target**, not from the caller. A target's market
 * is decided when it is created and is what every capture was measured in, so
 * asking for a series in any other market is asking for one that does not exist.
 */
export async function getMentionHistory(input: {
  projectId: string;
  domain: string;
  platform: GeoPlatform;
  limit?: number;
}) {
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no mentions history.`,
    );
  }

  const rows = await AiMentionHistoryRepository.listSeries({
    projectId: input.projectId,
    targetId: target.id,
    platform: input.platform,
    locationCode: target.locationCode,
    languageCode: target.languageCode,
    limit: input.limit ?? 24,
  });

  return {
    domain: target.domain,
    platform: input.platform,
    market: {
      locationCode: target.locationCode,
      languageCode: target.languageCode,
    },
    months: rows.map((row) => ({
      /** `YYYY-MM`, zero-padded in storage so this already sorts correctly. */
      month: row.month,
      // Null stays null all the way to the client. "No mentions recorded" and
      // "zero mentions recorded" are different facts, and a chart cannot tell
      // them apart once the gap has been filled with a zero.
      mentions: row.mentions,
      aiSearchVolume: row.aiSearchVolume,
      capturedAt: row.capturedAt,
    })),
  };
}

/**
 * The stored ETV series for a target, oldest first, with each point's formula
 * version attached.
 *
 * The endpoint is part of the series identity, so a series is never mixed across
 * Labs endpoints: `ranked_keywords` and `domain_rank_overview` compute ETV over
 * different populations and comparing them means nothing.
 */
export async function getEtvSeries(input: {
  projectId: string;
  domain: string;
  endpoint?: "domain_rank_overview" | "ranked_keywords" | "relevant_pages";
  limit?: number;
}) {
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no stored traffic series.`,
    );
  }

  const endpoint = input.endpoint ?? "domain_rank_overview";
  const rows = await DomainMetricsRepository.listSeries({
    projectId: input.projectId,
    domain: target.domain,
    locationCode: target.locationCode,
    endpoint,
    limit: input.limit ?? 200,
  });

  return {
    domain: target.domain,
    endpoint,
    points: rows.map((row) => ({
      // ISO date, because the chart's x-axis is days.
      date: row.capturedAt.slice(0, 10),
      etv: row.organicEtv ?? null,
      formulaVersion: row.etvFormulaVersion,
    })),
    // The models present, so the UI can explain the series without
    // re-deriving it from the points.
    formulaVersions: DomainMetricsRepository.listFormulaVersions(rows),
  };
}
