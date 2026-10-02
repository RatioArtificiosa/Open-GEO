import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getGeoEvidence, listGeoEvidencedRuns } from "@/serverFunctions/geo";
import { AnswerDiffPanel } from "./AnswerDiffPanel";

/**
 * The Evidence Drawer, as a surface.
 *
 * ## Gaps first. Above the fold. Not negotiable.
 *
 * The drawer's job is to say what is missing *before* the reader has formed an
 * impression of what is there. So the gap list renders **first**, and when there
 * is a gap it renders in the position of the number, not as a footnote beneath a
 * table of clean rows.
 *
 * The layout it avoids is the obvious one: three tidy rows, a "cost: $0.04" line,
 * and a small grey note underneath reading *"some evidence was truncated"*. That
 * reads as three tidy rows. A reader who scrolls past a warning has not been
 * warned, and the whole point of CL-308 was that the honest answer is frequently
 * *"partly"*.
 *
 * ## No score, no grade, no verdict
 *
 * Consistent with `llms.txt` (CL-300a) and the citability score's coverage note
 * (CL-301): this surface names defects and shows what was measured. A drawer
 * labelled "verified" or scored would be a claim about coverage that the `gaps`
 * array exists to contradict.
 *
 * The cost line is the one number, and it is reconciled rather than summarised —
 * the vendor's charge and what the customer paid side by side, with the difference
 * named. One blended figure would hide which of three legible causes applies, and
 * "why does the bill disagree with the receipt" is the question this exists to
 * answer.
 */

export function EvidenceDrawer({
  projectId,
  snapshotId,
}: {
  projectId: string;
  snapshotId: string;
}) {
  const { data, isPending, isError } = useQuery({
    queryKey: ["geoEvidence", projectId, snapshotId],
    queryFn: () => getGeoEvidence({ data: { snapshotId } }),
  });

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  if (isError || data === undefined) {
    // A failed read is not the same as an empty drawer, and saying so is the
    // whole discipline: "we could not check" and "there is nothing" are different
    // sentences and only the first is true here.
    return (
      <div className="alert alert-error" role="alert">
        <span>
          The evidence for this run could not be loaded. Nothing is shown here
          because a partial read would look like a complete one.
        </span>
      </div>
    );
  }

  const reconciliation = data.reconciliation;

  return (
    <div className="space-y-6">
      {/*
        First, and full width. A gap that renders below the evidence is a gap
        that gets scrolled past.
      */}
      {data.gaps.length > 0 ? (
        <div className="alert alert-warning" role="status">
          <div className="space-y-1">
            <p className="font-medium">What you can see here is incomplete.</p>
            <ul className="list-disc pl-5 text-sm">
              {data.gaps.map((gap) => (
                <li key={`${gap.kind}-${gap.detail.slice(0, 24)}`}>
                  {gap.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="evidence-cost">
        <h2 id="evidence-cost" className="text-lg font-semibold">
          What this run cost
        </h2>
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-base-content/70">The vendor charged</dt>
            <dd className="font-mono">{formatUsd(reconciliation.vendorUsd)}</dd>
          </div>
          <div>
            <dt className="text-sm text-base-content/70">The customer paid</dt>
            <dd className="font-mono">
              {formatUsd(reconciliation.chargedUsd)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-base-content/70">The difference</dt>
            <dd className="font-mono">
              {formatUsd(reconciliation.differenceUsd)}
            </dd>
          </div>
        </dl>
        {reconciliation.note ? (
          <p className="mt-2 text-sm text-base-content/70">
            {reconciliation.note}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="evidence-prompts">
        <h2 id="evidence-prompts" className="text-lg font-semibold">
          The prompts behind these numbers
        </h2>
        {data.answers.length === 0 ? (
          <p className="mt-2 text-sm text-base-content/70">
            No stored answers are linked to this run.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {data.answers.map((answer) => (
              <li key={answer.answerId} className="border-l-2 pl-3">
                <p className="text-sm font-medium">{answer.prompt}</p>
                <p className="text-xs text-base-content/70">
                  {answer.platform} &middot; answered {answer.answeredAt}
                </p>
                {answer.answerText ? (
                  <p className="mt-1 text-sm">{answer.answerText}</p>
                ) : (
                  /*
                   * Named rather than blank. This endpoint returns a mention
                   * count, not an answer, so a null body is the *normal* case
                   * for a live mentions row — and a blank space reads as an
                   * answer we lost rather than one we never received.
                   */
                  <p className="mt-1 text-sm text-base-content/70">
                    This source reports whether the brand was mentioned, not the
                    answer text.
                  </p>
                )}

                {/*
                 * The evidence, per answer.
                 *
                 * **This is the part the drawer existed for and did not have.**
                 * It said *that* a model mentioned the brand; the numbers on the
                 * GEO page — the citation gap above all — are per-answer facts,
                 * so a reader following them here found the answer row and no way
                 * to check it. **Every derived number in this product is a model
                 * of something observed, and without this the models were
                 * unfalsifiable**, which is the single state this drawer exists to
                 * prevent.
                 *
                 * Three sets, three different sentences, because they are three
                 * different facts:
                 * - `retrievedNotCited === null` means the vendor never told us
                 *   what was retrieved. That is **not** "nothing was retrieved",
                 *   and rendering an empty list here would be a claim about the
                 *   world made from silence — the error `llm_mentions` invites,
                 *   since that endpoint reports no retrieval list at all.
                 * - citations empty means none were stored, which is a fact about
                 *   the archive rather than about the model.
                 * - fan-out queries are the model's own reasoning, and the closest
                 *   thing here to seeing what it actually asked.
                 */}
                {answer.retrievedNotCited === null ? (
                  <p className="mt-2 text-xs text-base-content/60">
                    This source does not report which pages the model retrieved,
                    so the gap cannot be computed for this answer.
                  </p>
                ) : answer.retrievedNotCited.length === 0 ? (
                  <p className="mt-2 text-xs text-base-content/60">
                    Every page the model retrieved, it cited. Nothing in the
                    gap.
                  </p>
                ) : (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-base-content/80">
                      Read but not cited ({answer.retrievedNotCited.length})
                    </p>
                    <p className="text-xs text-base-content/60">
                      The model opened these pages and then used something else.
                      That is a directness problem, not a volume one.
                    </p>
                    <ul className="mt-1 list-disc pl-5 text-xs text-base-content/70">
                      {answer.retrievedNotCited.slice(0, 10).map((page) => (
                        <li key={page.url} className="truncate">
                          {page.url}
                        </li>
                      ))}
                      {answer.retrievedNotCited.length > 10 ? (
                        <li>
                          …and {answer.retrievedNotCited.length - 10} more
                        </li>
                      ) : null}
                    </ul>
                  </div>
                )}

                {answer.citations.length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-base-content/70">
                      Cited ({answer.citations.length})
                    </summary>
                    <ul className="mt-1 list-disc pl-5 text-xs text-base-content/70">
                      {answer.citations.map((citation) => (
                        <li key={citation.url} className="truncate">
                          {citation.title ?? citation.url}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {answer.fanOutQueries.length > 0 ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-base-content/70">
                      The model's follow-up questions (
                      {answer.fanOutQueries.length})
                    </summary>
                    <ol className="mt-1 list-decimal pl-5 text-xs text-base-content/70">
                      {answer.fanOutQueries.map((fanout) => (
                        <li key={`${answer.answerId}-${fanout.position}`}>
                          {fanout.query}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}

                {/*
                 * **The moat, and the reason it is here rather than elsewhere.**
                 *
                 * The reader who opens a drawer is the reader checking a number —
                 * which is precisely the reader who wants to know whether the
                 * answer *changed*, and nobody else can show them that. Putting it
                 * on the GEO page would put it beside numbers it does not justify;
                 * putting it here puts it beside the citations it compares, so a
                 * reader can check both ends of the claim.
                 *
                 * **It renders its own no-comparison sentence**, so a first-night
                 * reader is told "only one capture exists yet" rather than shown an
                 * empty panel they would read as "nothing changed".
                 */}
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-base-content/80">
                    What changed since the last capture
                  </summary>
                  <AnswerDiffPanel answerId={answer.answerId} enabled />
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="evidence-calls">
        <h2 id="evidence-calls" className="text-lg font-semibold">
          The calls we made
        </h2>
        {data.calls.length === 0 ? (
          <p className="mt-2 text-sm text-base-content/70">
            No vendor call was recorded for this run.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {data.calls.map((call) => (
              <li key={call.id} className="text-sm">
                <span className="font-mono">{call.path}</span>
                <span className="ml-2 text-base-content/70">
                  {call.startedAt} &middot; {call.statusCode ?? "no status"}
                  {call.costUsd === null
                    ? " · no cost recorded"
                    : ` · ${formatUsd(call.costUsd)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The drawer's index — the runs that actually have evidence behind them. */
export function EvidenceDrawerIndex({ projectId }: { projectId: string }) {
  const { data, isPending } = useQuery({
    queryKey: ["geoEvidencedRuns", projectId],
    queryFn: () => listGeoEvidencedRuns({ data: {} }),
  });

  if (isPending) {
    return <span className="loading loading-spinner" />;
  }
  if (data === undefined || data.length === 0) {
    // Said plainly rather than rendered as an empty list, which reads as a page
    // that failed to load its own contents.
    return (
      <p className="text-sm text-base-content/70">
        No run has recorded evidence yet. The recorder is best-effort, so early
        runs may not have one.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {data.map((run) => (
        <li key={run.snapshotId} className="text-sm">
          {/*
            A **link**, because the index's whole job is to be a way in. The
            first version rendered the snapshot id as plain text beside a date,
            so the drill-down route existed and nothing on the page pointed at
            it: an index nobody can open is a list, not a way in. The label is
            the run's date rather than its id, because a uuid is the join key
            and not something a person recognises.
          */}
          <Link
            to="/p/$projectId/geo/evidence/$snapshotId"
            params={{ projectId, snapshotId: run.snapshotId }}
            className="link"
          >
            {formatRunDate(run.capturedAt)}
          </Link>
          <span className="ml-2 text-base-content/70">
            {run.calls} call{run.calls === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The run's date, or the raw value when it is unreadable.
 *
 * An unparseable date is shown **as-is** rather than replaced with
 * `Invalid Date`, because a visibly broken timestamp is a fact an operator can
 * act on and a tidy placeholder is not.
 */
function formatRunDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function formatUsd(value: number): string {
  // Four places, because a rounding difference between the vendor line and the
  // customer line is exactly what a reader compares them to find.
  return `$${value.toFixed(4)}`;
}
