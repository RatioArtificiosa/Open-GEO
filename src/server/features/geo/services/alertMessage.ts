import type { AlertDecision, Change } from "./alertDecision";

/**
 * Turning an alert decision into exactly one message, sent once.
 *
 * ## The decision was easy; the sending is the hard part
 *
 * CL-309 answers *whether* to interrupt someone. This answers *how*, and the
 * constraint that shapes everything below is that **sending is the one step we
 * cannot make atomic with the record of having sent it.** We write "sent" to a
 * database and then call a webhook; if the process dies between those two
 * things, the row says sent and nobody received anything. If we call the webhook
 * first, a crash before the write means the next tick sends it again.
 *
 * There is no third option that is both at-most-once and never-lost without a
 * distributed transaction across a system we do not control. So the choice is
 * explicit rather than accidental:
 *
 * - **At-least-once, with the duplicate detectable.** The row is written *after*
 *   the send, and it carries a **content fingerprint** of the message. A repeat is
 *   therefore *recognisable* — the recipient sees the same alert twice and can see
 *   they are the same, and the dispatch log records the suppression. A duplicate
 *   is embarrassing; a silently dropped regression is expensive.
 *
 * This is the same trade CL-200b made for queue collection, where the docs say a
 * postback *and* a drain can both deliver the same task. It is the shape of every
 * at-least-once system, and the honest move is to say which one this is.
 *
 * ## One channel, chosen rather than configured
 *
 * The ledger's original line was "Discord/email". Two channels for two audiences
 * is the right idea and the wrong implementation, because a customer who
 * configures both will get every regression twice — once in a channel they read
 * and once in one they have muted, which is how the second one becomes a mute.
 *
 * So: **Discord for the reactive alerts**, because a lost citation is a "look
 * now" event, and **the suppressed list is not thrown away** — it is the digest's
 * content, which is the only place a *gain* is worth saying out loud. One
 * channel that sends only the things worth interrupting, and a weekly roll-up of
 * everything that was not.
 */

/** What one alert looks like on the wire. */
export type AlertMessage = {
  /** Stable across retries of the *same* decision. */
  subject: string;
  body: string;
  /** Sorted list of what changed, for a reader who wants the detail. */
  changes: string[];
};

/**
 * A fingerprint of a message, used to recognise a repeat.
 *
 * Deliberately **not** a hash of the timestamp or the run id: a retried dispatch
 * of the same decision must fingerprint identically, while a genuinely new
 * decision must not. So it is the run's identity plus the *content* of the
 * changes, and nothing that moves between attempts.
 *
 * A plain readable string rather than a hash: this value is written to a column a
 * human may read while debugging a duplicate, and a hash would make that
 * impossible. The column is an index, not a secret.
 */
export function fingerprint(input: {
  runId: string;
  projectId: string;
  decision: AlertDecision;
}): string {
  const parts: string[] = [input.projectId, input.runId];
  if (input.decision.shouldAlert) {
    for (const change of input.decision.alerts) parts.push(describe(change));
  }
  for (const change of input.decision.suppressed)
    parts.push(`suppressed:${describe(change)}`);
  return parts.join("|");
}

/** One line per change. Named so two changes cannot read the same by accident. */
function describe(change: Change): string {
  switch (change.kind) {
    case "mention_lost":
      return `lost mention of ${change.domain} on ${change.platform} for "${change.prompt}"`;
    case "mention_gained":
      return `gained mention of ${change.domain} on ${change.platform} for "${change.prompt}"`;
    case "citation_lost":
      return `lost citation ${change.url} on ${change.platform} for "${change.prompt}"`;
    case "sentiment_swing":
      return `sentiment on ${change.platform} for "${change.prompt}" moved from ${change.from} to ${change.to}`;
  }
  // Unreachable while the union is exhaustive, and that is the point: adding a
  // fifth `kind` to CL-309's union makes this function fail to compile rather
  // than render `undefined` for the new case. The alternative — a `default`
  // returning a placeholder — is a template that ships a blank line to a
  // customer and says nothing in review.
  const exhaustive: never = change;
  return exhaustive;
}

/**
 * Build the message, or null when there is nothing to send.
 *
 * Null rather than an empty message: an empty Discord post is visible, and a
 * visible empty post is worse than no post, because it teaches the reader that
 * the channel sometimes has nothing in it — which is a thing they must then
 * check.
 */
export function buildMessage(input: {
  decision: AlertDecision;
  projectName: string;
}): AlertMessage | null {
  if (!input.decision.shouldAlert) return null;

  // Losses first, and the ordering comes from the decision layer's own
  // classification rather than from the sort here. Re-sorting at the transport
  // would be a second ordering rule, and two ordering rules is how a regression
  // ends up below an opportunity.
  const lines = input.decision.alerts.map(describe);
  const subject = alertSubject(input.decision.alerts);

  return {
    subject,
    body: [
      `${input.projectName}: ${lines.length} change${lines.length === 1 ? "" : "s"} in what AI says about you.`,
      "",
      ...lines.map((line) => `• ${line}`),
      "",
      // The caveat travels with every alert. Models change for reasons we cannot
      // observe, and an alert that reads as a verdict — "you lost this because
      // of something" — is a causal claim we cannot support, and the one that
      // loses the customer's trust fastest.
      "This shows what changed between two stored answers. It does not show why: models change for reasons we cannot observe, so a lost citation is not evidence that anything you did caused it.",
    ].join("\n"),
    changes: lines,
  };
}

/**
 * The subject line, which is the only part a phone shows before the body.
 *
 * So it names the **worst** thing in the batch and nothing else. "3 changes" is
 * worse than "you lost a mention", because the reader has to open it to find
 * out whether they care, and the decision to open it is the thing we are asking
 * them to make in three seconds.
 */
function alertSubject(alerts: Change[]): string {
  const lostMention = alerts.filter((c) => c.kind === "mention_lost").length;
  const lostCitation = alerts.filter((c) => c.kind === "citation_lost").length;
  const swing = alerts.filter((c) => c.kind === "sentiment_swing").length;

  const parts: string[] = [];
  if (lostMention > 0) parts.push(`${lostMention} mention lost`);
  if (lostCitation > 0)
    parts.push(`${lostCitation} citation${lostCitation === 1 ? "" : "s"} lost`);
  if (swing > 0)
    parts.push(`${swing} sentiment swing${swing === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/**
 * The weekly roll-up of everything that was *not* sent.
 *
 * This is where a gain belongs. A gained mention is not worth interrupting for,
 * and a channel that carries only losses trains people to dread it — so the
 * good news arrives where it cannot become an interruption.
 *
 * Null when there is nothing in it, for the same reason `buildMessage` returns
 * null: a digest with no entries is a post with no content, and posting it
 * teaches the reader to scroll past the ones that matter.
 */
export function buildDigest(input: {
  suppressed: Change[];
  weekOf: string;
  projectName: string;
}): { subject: string; body: string; changes: string[] } | null {
  if (input.suppressed.length === 0) return null;
  const lines = input.suppressed.map(describe);
  const mentions = input.suppressed.filter(
    (c) => c.kind === "mention_gained",
  ).length;

  return {
    subject:
      mentions > 0
        ? `${mentions} good change${mentions === 1 ? "" : "s"} this week`
        : "What changed this week",
    body: [
      `${input.projectName}, week of ${input.weekOf}.`,
      "",
      "These are changes we did not alert on individually — a gain is not worth interrupting anyone for, and a channel that carries only losses gets muted.",
      "",
      ...lines.map((line) => `• ${line}`),
    ].join("\n"),
    changes: lines,
  };
}
