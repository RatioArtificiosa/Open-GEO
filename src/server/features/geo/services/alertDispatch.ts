import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { geoAlertDispatches } from "@/db/schema";
import {
  buildDigest,
  buildMessage,
  fingerprint,
  type AlertMessage,
} from "./alertMessage";
import type { AlertDecision, Change } from "./alertDecision";

/**
 * Dispatching an alert, once.
 *
 * ## At-least-once, and the duplicate is recognisable
 *
 * The one step we cannot make atomic with the record of having done it is the
 * send itself. Write the row first and a crash before the webhook means the row
 * claims a message nobody received; send first and a crash before the write means
 * the next tick sends it again.
 *
 * This module **sends, then records** — at-least-once — and the row carries the
 * **fingerprint** of what was sent. So a repeat is *detectable* rather than
 * merely possible: the log says `duplicate`, and the recipient sees the same
 * message twice and can see it is the same one.
 *
 * A duplicate is embarrassing. A silently dropped regression is expensive, and
 * expensive beats embarrassing every time. That is the whole argument, and it is
 * the same one CL-200b made for queue collection.
 *
 * ## A failed send is not recorded as sent
 *
 * The tempting shortcut is to write the row either way, so the code is simpler.
 * It is wrong in the direction that matters: a row whose `status` is `sent` for
 * a message that never arrived means the next tick's duplicate check suppresses a
 * regression that was never delivered. **The retry would be suppressed by a
 * record of a success that did not happen**, which is worse than no record at
 * all — it converts a transient webhook outage into a permanently lost alert.
 *
 * So: sent-and-confirmed writes `sent`; refused-and-failed writes `failed`, which
 * the duplicate check ignores, so the next tick tries again.
 */

/**
 * The transport. Injected so this module is testable and so the choice of
 * channel is one line rather than a dependency.
 *
 * Exported because a caller writing a transport — and a test asserting on what
 * it was handed — has to be able to name the type. A consumer that cannot is
 * writing an untyped function and loses the one guarantee that matters: that
 * `subject` is a string and not `undefined`.
 */
export type Transport = (message: AlertMessage) => Promise<void>;

type DispatchResult = {
  /** What happened, for the run log. Never null — silence here is the bug. */
  outcome: "sent" | "duplicate" | "nothing_to_send" | "failed";
  /** Why a duplicate, when that is the outcome. */
  detail: string | null;
  /** True when the row was written, so a caller can report a missing record. */
  recorded: boolean;
};

/**
 * Send an alert decision, once.
 *
 * The ordering of the three steps is the design: decide what to say, check
 * whether it was said, send, then record. Checking *before* sending is what makes
 * the duplicate detectable; recording *after* is what makes a failed send
 * retryable.
 */
export async function dispatchAlert(input: {
  projectId: string;
  runId: string;
  projectName: string;
  decision: AlertDecision;
  transport: Transport;
  now?: Date;
}): Promise<DispatchResult> {
  const message = buildMessage({
    decision: input.decision,
    projectName: input.projectName,
  });
  if (message === null) {
    // Not an error and not a record. A run with nothing to say leaves no trace,
    // because a table row per quiet run is a table nobody reads and a cost
    // nobody notices.
    return { outcome: "nothing_to_send", detail: null, recorded: false };
  }

  const now = input.now ?? new Date();
  const print = fingerprint({
    runId: input.runId,
    projectId: input.projectId,
    decision: input.decision,
  });

  // Checked **before** the send. After the send it would be too late to be the
  // reason we did not send.
  const alreadySent = await db
    .select({ fingerprint: geoAlertDispatches.fingerprint })
    .from(geoAlertDispatches)
    .where(
      and(
        eq(geoAlertDispatches.projectId, input.projectId),
        eq(geoAlertDispatches.fingerprint, print),
        eq(geoAlertDispatches.status, "sent"),
      ),
    )
    .limit(1);
  if (alreadySent.length > 0) {
    return {
      outcome: "duplicate",
      detail:
        "This exact alert was already delivered for this run. Suppressed rather than sent twice.",
      recorded: false,
    };
  }

  try {
    await input.transport(message);
  } catch (error) {
    // Recorded as `failed`, and a `failed` row is ignored by the duplicate check
    // above — so the next tick sends it. See the docblock: the alternative
    // converts a transient outage into a permanently lost alert.
    await recordDispatch(
      { ...input, print, message, status: "failed" },
      now,
      error,
    );
    return {
      outcome: "failed",
      detail: `The channel refused the message: ${describeError(error)}. It will be retried, because a failed send is not a sent one.`,
      recorded: true,
    };
  }

  const recorded = await recordDispatch(
    { ...input, print, message, status: "sent" },
    now,
  );
  return { outcome: "sent", detail: null, recorded };
}

/**
 * Dispatch the weekly roll-up of everything that was *not* sent individually.
 *
 * ## Why this exists, and it is the ninth instance of one shape
 *
 * `buildDigest` has existed, has a docstring explaining that a **gained** mention
 * belongs here rather than in an interruption, and has tests. **Nothing called it.**
 * `dispatchAlert` builds its message with `buildMessage` and nothing else, so every
 * `mention_gained` was classified by `decideAlerts`, formatted, tested — and
 * discarded. A customer whose brand started being mentioned was never told, and
 * the design rationale in `buildDigest`'s own docstring was a description of
 * intended behaviour that nothing implemented.
 *
 * That is the same defect as the evidence drawer nobody opened, the cadence gate
 * nobody passed an argument to, and the AI Mode monitor a run-log note claimed
 * existed — a component that is built, tested, and never invoked — and it is the
 * most consequential of them, because it is the only one a customer would have
 * noticed as a **missing good thing** rather than a missing error.
 *
 * ## It reuses the same at-least-once machinery, deliberately
 *
 * Same duplicate check, same `sent`/`failed` semantics, same reason they exist: a
 * failed send must not be recorded as a success, or a transient webhook outage
 * becomes a permanently lost roll-up. The fingerprint is keyed on the **week**
 * rather than the run, because a digest covers a week and must not be re-sent by a
 * second run inside it — which is exactly the `alertDispatch.test.ts` case where
 * a gain is recorded and then a second run re-decides the same prompt.
 */
export async function dispatchDigest(input: {
  projectId: string;
  runId: string;
  projectName: string;
  suppressed: Change[];
  weekOf: string;
  transport: Transport;
  now?: Date;
}): Promise<DispatchResult> {
  const message = buildDigest({
    suppressed: input.suppressed,
    weekOf: input.weekOf,
    projectName: input.projectName,
  });
  // The same rule as `buildMessage`: a digest with no entries is a post with no
  // content, and posting it teaches the reader to scroll past the ones that
  // matter. No row, no send, no trace.
  if (message === null) {
    return {
      outcome: "nothing_to_send",
      detail: null,
      recorded: false,
    };
  }

  const now = input.now ?? new Date();
  // Week-scoped, not run-scoped. The digest is *about* the week, so two runs in
  // the same week must not produce two roll-ups of the same gain.
  const print = `digest:${input.projectId}:${input.weekOf}`;

  const alreadySent = await db
    .select({ fingerprint: geoAlertDispatches.fingerprint })
    .from(geoAlertDispatches)
    .where(
      and(
        eq(geoAlertDispatches.projectId, input.projectId),
        eq(geoAlertDispatches.fingerprint, print),
        eq(geoAlertDispatches.status, "sent"),
      ),
    )
    .limit(1);
  if (alreadySent.length > 0) {
    return {
      outcome: "duplicate",
      detail:
        "This week's roll-up was already delivered. Suppressed rather than sent twice.",
      recorded: false,
    };
  }

  try {
    await input.transport(message);
  } catch (error) {
    await recordDispatch(
      {
        projectId: input.projectId,
        runId: input.runId,
        projectName: input.projectName,
        print,
        message,
        status: "failed",
      },
      now,
      error,
    );
    return {
      outcome: "failed",
      detail: `The channel refused the roll-up: ${describeError(error)}. It will be retried, because a failed send is not a sent one.`,
      recorded: true,
    };
  }

  const recorded = await recordDispatch(
    {
      projectId: input.projectId,
      runId: input.runId,
      projectName: input.projectName,
      print,
      message,
      status: "sent",
    },
    now,
  );
  return { outcome: "sent", detail: null, recorded };
}

/**
 * The transport's own words, never `String(error)`.
 *
 * `String` on an object yields `[object Object]`, which would replace a real
 * error with an unreadable one in the only place a human will ever read it.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "an error that carried no message";
}

/**
 * One object rather than six positional parameters.
 *
 * `max-params` caught a real smell here and not a style one: with six
 * positional arguments, `print`, `message` and `now` were all string-ish at the
 * call site, and swapping two of them would have compiled. A named object makes
 * the call readable and the swap impossible.
 */
async function recordDispatch(
  input: {
    projectId: string;
    runId: string;
    projectName: string;
    print: string;
    message: AlertMessage;
    status: "sent" | "failed";
  },
  now: Date,
  error?: unknown,
): Promise<boolean> {
  try {
    await db.insert(geoAlertDispatches).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      runId: input.runId,
      fingerprint: input.print,
      status: input.status,
      subject: input.message.subject,
      changeCount: input.message.changes.length,
      detail: error === undefined ? null : describeError(error),
      dispatchedAt: now.toISOString(),
    });
    return true;
  } catch {
    // A lost log row is bad but not fatal: the consequence is that the *next*
    // tick's duplicate check does not recognise this message and sends it again
    // — which is the at-least-once behaviour stated above, degraded. Losing the
    // record must not fail the dispatch that already happened, because the
    // customer has already been told.
    return false;
  }
}

/**
 * How many times a run's alerts have actually reached someone.
 *
 * For the run log, and it counts `sent` rows only — a `failed` row is a retry
 * waiting to happen, and reporting it as a delivery would overstate the
 * coverage of our own alerting, which is the exact failure this product exists
 * to avoid everywhere else.
 */
export async function countDeliveredAlerts(
  projectId: string,
  runId: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(geoAlertDispatches)
    .where(
      and(
        eq(geoAlertDispatches.projectId, projectId),
        eq(geoAlertDispatches.runId, runId),
        eq(geoAlertDispatches.status, "sent"),
      ),
    );
  return rows[0]?.n ?? 0;
}
