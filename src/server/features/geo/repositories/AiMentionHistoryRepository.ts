import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiMentionHistory } from "@/db/schema";
import type { LlmHistoricalItem } from "@/server/lib/dataforseoLlmSchemas";
import type { GeoPlatform } from "./GeoSetupRepository";

/**
 * The monthly mentions series, per target and platform.
 *
 * One table, one purpose: the trend a customer actually looks at. It is
 * separate from `geo_answers` because it is an *aggregate* — it has no single
 * answer behind it, it survives the retention window that ages answers out, and
 * it exists from the moment the vendor first reports a month rather than from the
 * first time we happened to run.
 *
 * Writes are upserts keyed on `(target, platform, market, month)`. The vendor
 * revises history, so a second capture of the same month must *replace* the row,
 * not append beside it — a duplicate month would make a sparkline double-count
 * the same data point and look like a spike nobody caused.
 */

type AiMentionHistoryRow = typeof aiMentionHistory.$inferSelect;

/**
 * Normalise the vendor's `{ year, month }` pair to `YYYY-MM`.
 *
 * Zero-padded on purpose: an un-padded `2026-1` sorts before `2025-12` as text,
 * which would scramble the series in exactly the way a user would not notice.
 * No `Date` is involved, so no timezone can shift a month across a boundary.
 */
function toMonthKey(item: Pick<LlmHistoricalItem, "year" | "month">): string {
  return `${item.year}-${String(item.month).padStart(2, "0")}`;
}

export const AiMentionHistoryRepository = {
  /**
   * Replace the stored months with what the vendor just reported.
   *
   * Deleting the window first and re-inserting, rather than upserting row by
   * row, is deliberate: if the vendor *drops* a month from its response — which
   * happens when a month's data is withdrawn — an upsert would leave the old row
   * in place and the chart would keep showing a month that no longer exists. A
   * chart that cannot be wrong by omission is worth more here than the saving of
   * a round trip.
   */
  async replaceWindow(input: {
    projectId: string;
    targetId: string;
    platform: GeoPlatform;
    locationCode: number;
    languageCode: string;
    fromMonth: string;
    toMonth: string;
    items: LlmHistoricalItem[];
    capturedAt: string;
  }): Promise<number> {
    await db
      .delete(aiMentionHistory)
      .where(
        and(
          eq(aiMentionHistory.projectId, input.projectId),
          eq(aiMentionHistory.targetId, input.targetId),
          eq(aiMentionHistory.platform, input.platform),
          eq(aiMentionHistory.locationCode, input.locationCode),
          eq(aiMentionHistory.languageCode, input.languageCode),
        ),
      );

    const rows = input.items
      .map((item) => {
        const month = toMonthKey(item);
        // A month outside the requested window is a vendor quirk, not data we
        // asked for; storing it would put an unbounded series in a bounded table.
        if (month < input.fromMonth || month > input.toMonth) return null;
        return {
          projectId: input.projectId,
          targetId: input.targetId,
          platform: input.platform,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          month,
          // Null stays null. The reference example returns one month *before*
          // the documented floor with both metrics at 0, and coercing that to
          // null would erase the only evidence that the vendor disagrees with
          // its own documentation.
          mentions: item.metrics?.mentions ?? null,
          aiSearchVolume: item.metrics?.ai_search_volume ?? null,
          capturedAt: input.capturedAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (rows.length === 0) return 0;
    await db
      .insert(aiMentionHistory)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          aiMentionHistory.projectId,
          aiMentionHistory.targetId,
          aiMentionHistory.platform,
          aiMentionHistory.locationCode,
          aiMentionHistory.languageCode,
          aiMentionHistory.month,
        ],
        set: {
          // `excluded` is the row we tried to insert, so this is a genuine
          // last-write-wins on the same key rather than a no-op.
          //
          // The column names are written literally rather than interpolated from
          // the schema objects: `sql\`excluded.${column}\`` renders as
          // `excluded."ai_mention_history"."mentions"`, which SQLite rejects.
          mentions: sql`excluded.mentions`,
          aiSearchVolume: sql`excluded.ai_search_volume`,
          capturedAt: input.capturedAt,
        },
      });
    return rows.length;
  },

  /**
   * The stored series, oldest first.
   *
   * `platform` **and** the market are required. There is no "all platforms" or
   * "all markets" variant on purpose: the two platforms compute demand
   * differently, and a US-only series handed to a London project is not a rough
   * answer, it is a different measurement wearing the same label.
   */
  async listSeries(input: {
    projectId: string;
    targetId: string;
    platform: GeoPlatform;
    locationCode: number;
    languageCode: string;
    limit?: number;
  }): Promise<AiMentionHistoryRow[]> {
    return db
      .select()
      .from(aiMentionHistory)
      .where(
        and(
          eq(aiMentionHistory.projectId, input.projectId),
          eq(aiMentionHistory.targetId, input.targetId),
          eq(aiMentionHistory.platform, input.platform),
          // Without these two the query would return US rows to a London
          // project — same target, same platform, different measurement.
          eq(aiMentionHistory.locationCode, input.locationCode),
          eq(aiMentionHistory.languageCode, input.languageCode),
        ),
      )
      .orderBy(asc(aiMentionHistory.month))
      .limit(input.limit ?? 60);
  },

  /**
   * Every target's stored months, for the dashboard's summary rows.
   *
   * Market is filtered here too, for the same reason as `listSeries`: a
   * summary row showing US figures on a London dashboard is the same
   * mislabelled measurement, in the place a user is most likely to quote from.
   */
  async listLatestMonths(input: {
    projectId: string;
    platform: GeoPlatform;
    locationCode: number;
    languageCode: string;
  }): Promise<AiMentionHistoryRow[]> {
    return db
      .select()
      .from(aiMentionHistory)
      .where(
        and(
          eq(aiMentionHistory.projectId, input.projectId),
          eq(aiMentionHistory.platform, input.platform),
          eq(aiMentionHistory.locationCode, input.locationCode),
          eq(aiMentionHistory.languageCode, input.languageCode),
        ),
      )
      .orderBy(asc(aiMentionHistory.month));
  },
} as const;
