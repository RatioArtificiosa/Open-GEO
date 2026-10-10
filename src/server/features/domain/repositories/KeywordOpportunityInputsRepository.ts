import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { keywordOpportunityInputs } from "@/db/schema";
import { AppError } from "@/server/lib/errors";

/**
 * Reads and writes for `keyword_opportunity_inputs`. The writer the Opportunity Score never had —
 * `CL-503`'s job is described as *"backed by nightly jobs over stored history"*, and three of the
 * model's five inputs are stored nowhere until this exists.
 *
 * Two rules from the table definition are enforced **here**, because a constraint the writer does not
 * honour is a comment rather than a guarantee:
 *
 * 1. **The keyword is lowercased and trimmed.** The table promises a series cannot fork on casing,
 *    and the only place that can be true is the write.
 * 2. **An unstamped measurement is refused.** `score_model_version` is NOT NULL in the schema; this
 *    refuses it *before* the insert so the failure names the reason rather than surfacing as a
 *    constraint violation. An unstamped score is unreadable the moment the weights change, which is
 *    the whole reason the version is in the unique key.
 */

export type OpportunityInputPoint = {
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode?: string;
  /** Null means unmeasured, never "not difficult". The model's `competitorEase(0)` relies on it. */
  keywordDifficulty: number | null;
  serpCompetitors: number | null;
  intent: string | null;
  aiNativeRatioBp: number | null;
  rankElasticityBp: number | null;
  scoreModelVersion: string;
  /** When *we* asked, not when the vendor answered. They differ on a cache re-read. */
  requestedAt: string;
};

export const KeywordOpportunityInputsRepository = {
  /**
   * Write one measurement.
   *
   * A repeat of the same point is **ignored rather than overwritten**: the unique key includes the
   * request time, so a second run on the same night produces the same key, and the honest handling of
   * an identical measurement is to keep the one already stored — not to rewrite history with a value
   * that may have arrived later.
   */
  async insertPoint(input: OpportunityInputPoint): Promise<void> {
    const scoreModelVersion = input.scoreModelVersion.trim();
    if (scoreModelVersion.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "KeywordOpportunityInputsRepository refuses to store a measurement with no model version: " +
          "an unstamped row is unreadable once the weights change",
      );
    }

    const keyword = input.keyword.trim().toLowerCase();
    if (keyword.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "KeywordOpportunityInputsRepository needs a keyword",
      );
    }

    await db
      .insert(keywordOpportunityInputs)
      .values({
        projectId: input.projectId,
        keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode ?? "en",
        keywordDifficulty: input.keywordDifficulty,
        serpCompetitors: input.serpCompetitors,
        intent: input.intent,
        aiNativeRatioBp: input.aiNativeRatioBp,
        rankElasticityBp: input.rankElasticityBp,
        scoreModelVersion,
        requestedAt: input.requestedAt,
      })
      .onConflictDoNothing();
  },

  /**
   * One keyword's measurement history, newest first.
   *
   * Ordered by `captured_at` descending so the caller takes the *most recent* measurement rather than
   * whichever the database happened to return — a forecast built on a stale point is worse than one
   * that says it has nothing.
   */
  async seriesFor(input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    limit?: number;
  }) {
    return db
      .select()
      .from(keywordOpportunityInputs)
      .where(
        and(
          eq(keywordOpportunityInputs.projectId, input.projectId),
          eq(
            keywordOpportunityInputs.keyword,
            input.keyword.trim().toLowerCase(),
          ),
          eq(keywordOpportunityInputs.locationCode, input.locationCode),
        ),
      )
      .orderBy(desc(keywordOpportunityInputs.capturedAt))
      .limit(input.limit ?? 30);
  },
};
