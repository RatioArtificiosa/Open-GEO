import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  geoAnswers,
  geoSnapshotAnswers,
  geoSnapshots,
  geoVendorTasks,
} from "@/db/schema";

/**
 * The Evidence Drawer: from any number on screen back to the call that made it.
 *
 * ## What this is for
 *
 * Every derived GEO number in this product is a *model* of something we
 * observed. Share of voice, sentiment, citation authority, the inclusion gap —
 * each is arithmetic over vendor answers, and each would be unfalsifiable if it
 * could not be traced to the answers it came from. So the drawer's contract is
 * one sentence: **given a figure, name the prompt, the answer, the source and
 * the cost that produced it.**
 *
 * ## The honest answer is frequently "partly"
 *
 * And that is the design, not a limitation being papered over. The evidence
 * recorder is best-effort by design (a monitoring feature that takes down the
 * product it monitors is not monitoring), the response body is truncated with an
 * explicit marker, and a Live call may carry no vendor task id at all. A drawer
 * that rendered all of that as a clean list would be lying about the coverage,
 * and a coverage claim that overstates itself is the one failure this product
 * exists to prevent.
 *
 * So the result type carries a `gaps` array alongside the evidence, and every
 * entry names what is missing rather than being silently absent. "We have the
 * request but the response was truncated" and "we have nothing at all" are
 * different sentences, and only the first is a recoverable record.
 *
 * ## It reads, it never re-queries
 *
 * Nothing here calls DataForSEO. A drawer that re-fetched the vendor to
 * "confirm" would cost money, would not return the bytes we were billed for,
 * and would be a second source of truth for a number the archive already
 * holds. The archive is the record; this is the way to read it.
 */

/** One stored vendor call, as the drawer shows it. */
type EvidenceEntry = {
  id: string;
  startedAt: string;
  completedAt: string | null;
  path: string;
  statusCode: number | null;
  vendorTaskId: string | null;
  tag: string | null;
  requestBody: string | null;
  responseBody: string | null;
  costUsd: number | null;
  chargedUsd: number | null;
};

type EvidenceGap = {
  kind:
    | "no_evidence"
    | "truncated_response"
    | "missing_response"
    | "missing_request"
    | "never_completed";
  detail: string;
};

type EvidenceDrawer = {
  /** The archive rows the number was computed from. Empty when none survive. */
  answers: Array<{
    answerId: string;
    platform: string;
    /** The prompt as asked, verbatim — the input a re-run has to match exactly. */
    prompt: string;
    /**
     * The model's text, or null.
     *
     * Null is the *normal* case for a `mentions_search` row, because that
     * endpoint returns a mention count and never the answer itself. So null here
     * means "we asked a question and recorded what the model said about us",
     * not "the call failed" — and the drawer says which, because the two invite
     * opposite conclusions.
     */
    answerText: string | null;
    source: string;
    answeredAt: string;
    vendorTaskId: string | null;
  }>;
  /** The vendor calls behind those answers, oldest first. */
  calls: EvidenceEntry[];
  /**
   * What is missing, in words. Never empty-but-silent: an entry with no gaps is
   * a claim that the record is complete, and this function will only make that
   * claim when it is true.
   */
  gaps: EvidenceGap[];
};

/** Matches `serialiseForEvidence`'s truncation marker, so a partial body is known. */
const TRUNCATION_MARKER = /…\[truncated at \d+ of \d+ chars\]$/;

/**
 * Everything behind one snapshot — the drawer for a single archive row.
 *
 * Scoped to a snapshot rather than a project on purpose. "Show me the evidence"
 * with no scope returns the project's entire call history, which is a data dump
 * rather than evidence for anything, and a drawer that is cheap to open is a
 * drawer nobody opens.
 */
export async function getEvidenceForSnapshot(
  snapshotId: string,
): Promise<EvidenceDrawer> {
  const gaps: EvidenceGap[] = [];

  const snapshot = await db
    .select()
    .from(geoSnapshots)
    .where(eq(geoSnapshots.id, snapshotId))
    .limit(1);
  if (snapshot.length === 0) {
    return {
      answers: [],
      calls: [],
      gaps: [
        {
          kind: "no_evidence",
          detail:
            "That snapshot is not in the archive. It may have been created by a run whose evidence failed to store, or the id may be wrong.",
        },
      ],
    };
  }

  // `geoAnswers` has no `snapshotId` — membership runs through
  // `geo_snapshot_answers`, so the join is explicit. Going through the relation
  // instead would be a plausible-looking shortcut that silently returns nothing.
  const answers = await db
    .select({
      answerId: geoAnswers.id,
      platform: geoAnswers.platform,
      prompt: geoAnswers.prompt,
      answerText: geoAnswers.answerText,
      source: geoAnswers.source,
      answeredAt: geoAnswers.answeredAt,
      vendorTaskId: geoAnswers.vendorTaskId,
    })
    .from(geoSnapshotAnswers)
    .innerJoin(geoAnswers, eq(geoAnswers.id, geoSnapshotAnswers.answerId))
    .where(eq(geoSnapshotAnswers.snapshotId, snapshotId));

  const calls = await db
    .select()
    .from(geoVendorTasks)
    .where(eq(geoVendorTasks.snapshotId, snapshotId))
    .orderBy(geoVendorTasks.startedAt);

  // A snapshot with no recorded call is the case worth naming loudly. It is not
  // a rendering edge: it means the patrol wrote derived rows without leaving a
  // trace of what it asked, which is precisely the gap the evidence table exists
  // to close, so the drawer has to report it rather than render an empty list.
  if (calls.length === 0) {
    gaps.push({
      kind: "no_evidence",
      detail:
        "No vendor call was recorded for this snapshot. The numbers above were derived from a response we cannot show, so nothing here can be re-derived or independently checked.",
    });
  }

  for (const call of calls) {
    if (call.requestBody === null) {
      gaps.push({
        kind: "missing_request",
        detail: `The call to ${call.path} was recorded without the request body, so it cannot be re-sent as it was.`,
      });
    }
    if (call.responseBody === null) {
      gaps.push({
        kind: "missing_response",
        detail: `The call to ${call.path} was recorded without a response body.`,
      });
    } else if (TRUNCATION_MARKER.test(call.responseBody)) {
      gaps.push({
        kind: "truncated_response",
        detail: `The response to ${call.path} was too large to store whole and is truncated. The figures derived from it are not fully reproducible from this row.`,
      });
    }
    if (call.completedAt === null) {
      gaps.push({
        kind: "never_completed",
        detail: `The call to ${call.path} was recorded but never marked complete, so its cost is provisional.`,
      });
    }
  }

  // A missing answer body is only a gap for sources that are *supposed* to
  // carry one. A `mentions_search` row never has answer text — the endpoint
  // returns a mention count, not the response — so flagging it would put a
  // "gap" on every healthy snapshot and train the reader to ignore the list.
  const expectText = answers.filter((a) => a.source !== "mentions_search");
  const unanswered = expectText.filter((a) => a.answerText === null);
  if (unanswered.length > 0) {
    gaps.push({
      kind: "missing_response",
      detail: `${unanswered.length} of ${expectText.length} answers from a source that should carry the model's text have none. These are vendor tasks that had not finished when the snapshot was written, not prompts the model declined to answer.`,
    });
  }

  return {
    answers,
    calls: calls.map((c) => ({
      id: c.id,
      startedAt: c.startedAt,
      completedAt: c.completedAt,
      path: c.path,
      statusCode: c.statusCode,
      vendorTaskId: c.vendorTaskId,
      tag: c.tag,
      requestBody: c.requestBody,
      responseBody: c.responseBody,
      costUsd: c.costUsd,
      chargedUsd: c.chargedUsd,
    })),
    gaps,
  };
}

/**
 * What a project was actually charged, and what it cost, for one snapshot.
 *
 * Two numbers, and the gap between them is the point. They are equal in the
 * healthy case and differ for legible reasons: a call the meter did not wrap, a
 * markup that changed between the call and the settlement, or the archive
 * predating the evidence table. Rendering a single "cost" would hide which of
 * those happened, and the reason a bill disagrees with a receipt is exactly what
 * a customer asks about.
 */
export async function getSpendReconciliation(snapshotId: string): Promise<{
  vendorUsd: number;
  chargedUsd: number;
  differenceUsd: number;
  unpricedCalls: number;
  note: string | null;
}> {
  const calls = await db
    .select({
      costUsd: geoVendorTasks.costUsd,
      chargedUsd: geoVendorTasks.chargedUsd,
    })
    .from(geoVendorTasks)
    .where(eq(geoVendorTasks.snapshotId, snapshotId));

  let vendorUsd = 0;
  let chargedUsd = 0;
  let unpricedCalls = 0;
  for (const call of calls) {
    if (call.costUsd === null) unpricedCalls += 1;
    else vendorUsd += call.costUsd;
    if (call.chargedUsd === null) unpricedCalls += 1;
    else chargedUsd += call.chargedUsd;
  }

  // Money is summed in integer micro-dollars and converted once at the end. The
  // column is an integer precisely so a reconciliation can be re-run and produce
  // the same number; summing floats accumulates the error that makes an argument
  // about a bill unfalsifiable.
  const MICRO = 1_000_000;
  const vendorMicros = Math.round(vendorUsd * MICRO);
  const chargedMicros = Math.round(chargedUsd * MICRO);
  const differenceMicros = chargedMicros - vendorMicros;

  const note =
    unpricedCalls > 0
      ? `${unpricedCalls} recorded ${unpricedCalls === 1 ? "call has" : "calls have"} no cost recorded, so this total is a lower bound rather than a figure.`
      : differenceMicros === 0
        ? null
        : "The amount charged the customer does not equal what the vendor billed. The difference is real and is not being absorbed.";

  return {
    vendorUsd: vendorMicros / MICRO,
    chargedUsd: chargedMicros / MICRO,
    differenceUsd: differenceMicros / MICRO,
    unpricedCalls,
    note,
  };
}

/** Every snapshot that has at least one recorded vendor call, newest first. */
export async function listEvidencedSnapshots(
  projectId: string,
  limit = 50,
): Promise<Array<{ snapshotId: string; capturedAt: string; calls: number }>> {
  const rows = await db
    .select({
      snapshotId: geoVendorTasks.snapshotId,
      capturedAt: sql<string>`max(${geoVendorTasks.startedAt})`,
      calls: sql<number>`count(*)`,
    })
    .from(geoVendorTasks)
    .where(
      and(
        eq(geoVendorTasks.projectId, projectId),
        isNotNull(geoVendorTasks.snapshotId),
      ),
    )
    .groupBy(geoVendorTasks.snapshotId)
    .orderBy(desc(sql`max(${geoVendorTasks.startedAt})`))
    .limit(limit);

  // The `isNotNull` filter is in the query, but SQL nullability does not narrow
  // a `GROUP BY` result, so the guarantee is re-established here. Dropping a row
  // whose id is somehow null is right: it would produce a link to a drawer that
  // reports nothing found, which reads as "no evidence" rather than "bad link".
  return rows.flatMap((row) =>
    typeof row.snapshotId === "string" && row.snapshotId.length > 0
      ? [
          {
            snapshotId: row.snapshotId,
            capturedAt: row.capturedAt,
            calls: row.calls,
          },
        ]
      : [],
  );
}
