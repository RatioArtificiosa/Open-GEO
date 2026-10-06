import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { getGeoAnswerDiff } from "@/serverFunctions/geo";
import { GEO_QUERY_STALE_TIME_MS } from "./useGeoPageData";

/**
 * What changed about one answer between two captures.
 *
 * **This is the moat, on a screen.** Everybody can ask a model a question right
 * now; nobody else can show you the seventh answer. `answerDiffReads` assembles the
 * pair from the archive and `diffAnswers` does the comparison — this is the part
 * that makes either of them reachable by a person.
 *
 * ## Why it asks by `answerId` and does not offer a picker
 *
 * **One answer id, and the server decides the pair.** A "compare these two" control
 * sounds more reproducible and is not: the list changes when a capture lands, so the
 * question silently becomes a different one between render and click. The
 * reproducibility that matters is *"the last two captures, as of this render"*, and
 * the server is the only place that can state it honestly.
 *
 * ## Three states, three sentences
 *
 * - a diff, with losses first;
 * - `diff: null` with the server's reason — **"nothing changed" and "no comparison"
 *   are different facts**, and on a project's first night the second is the normal
 *   one;
 * - no answer at all, which says the patrol is what fills this rather than showing
 *   an empty panel.
 *
 * The `caveat` is rendered whenever there is a diff, and it is the server's, not a
 * paraphrase: a citation that disappeared is an observation, and presenting it as
 * something the customer caused is how a reader stops trusting the product.
 */
export function AnswerDiffPanel({
  answerId,
  enabled,
}: {
  answerId: string;
  enabled: boolean;
}) {
  /**
   * `projectId` in the query key, **even though the caller does not send it.**
   *
   * The rule this file exists under is that `projectId` lives only in the query key
   * and never in a request body — and `prepublish-audit.test.ts` enforces it by
   * scanning GEO query keys for the id. The first version wrote
   * `["geoAnswerDiff", answerId]` and the gate failed it with *"has no geo query
   * key without projectId"*, which is correct: two projects can hold the same
   * `answerId` only if one is reading the other's archive, and a key without the
   * project is a cache entry that survives a switch.
   *
   * The alternative — trusting react-query's per-key client isolation — is a claim
   * about a detail nobody here controls, and the gate exists so that claim does not
   * have to be made.
   */
  const { projectId } = useParams({ strict: false });

  const query = useQuery({
    queryKey: ["geoAnswerDiff", projectId, answerId],
    enabled: enabled && answerId !== "",
    staleTime: GEO_QUERY_STALE_TIME_MS,
    queryFn: () => getGeoAnswerDiff({ data: { answerId } }),
  });

  if (query.isLoading) {
    return (
      <p className="mt-2 text-xs text-base-content/60">
        Comparing the last two captures…
      </p>
    );
  }

  if (query.error) {
    return (
      <p className="mt-2 text-xs text-base-content/60">
        We could not compare the captures for this question. The archived
        answers are still on this page, so the numbers themselves are
        unaffected.
      </p>
    );
  }

  const data = query.data;
  if (!data) return null;

  if (!data.diff) {
    return (
      <p className="mt-2 text-xs text-base-content/60">
        {data.noDiffReason ??
          "There is nothing to compare yet. A diff needs two runs of this question, and the archive holds one — the answer appears once a second run lands."}
      </p>
    );
  }

  const lost = data.diff.changes.filter((c) => c.kind === "lost");
  const gained = data.diff.changes.filter((c) => c.kind === "gained");
  const moved = data.diff.changes.filter((c) => c.kind === "moved");

  return (
    <div className="mt-2">
      {/*
       * **The comparison window, stated.** "Based on 2 of 26" reads like the
       * project has two answers, and that is the sentence that makes the moat
       * legible: this is the seventh, and there were five before it.
       */}
      <p className="text-xs text-base-content/60">
        Comparing the two most recent of {data.capturesAvailable} capture
        {data.capturesAvailable === 1 ? "" : "s"} ·{" "}
        {data.diff.before.answeredAt.slice(0, 10)} →{" "}
        {data.diff.after.answeredAt.slice(0, 10)}
      </p>

      {lost.length === 0 && gained.length === 0 && moved.length === 0 ? (
        <p className="mt-1 text-xs text-base-content/70">
          {data.diff.summary ??
            "The answer cited exactly the same sources in both captures."}
        </p>
      ) : (
        <>
          {/*
           * **Losses lead.** A dropped citation is a regression someone can act on;
           * a gained one may be a result the model simply had not seen. Reporting
           * them as equal — or ordering them by URL — puts the regression wherever
           * the alphabet puts it.
           */}
          {lost.length > 0 ? (
            <div className="mt-1">
              <p className="text-xs font-medium text-base-content/80">
                No longer cited ({lost.length})
              </p>
              <ul className="list-disc pl-5 text-xs text-base-content/70">
                {lost.slice(0, 5).map((change) => (
                  <li key={change.url} className="truncate">
                    {change.url}
                  </li>
                ))}
                {lost.length > 5 ? <li>…and {lost.length - 5} more</li> : null}
              </ul>
            </div>
          ) : null}

          {gained.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-base-content/70">
                Newly cited ({gained.length})
              </summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-base-content/70">
                {gained.slice(0, 5).map((change) => (
                  <li key={change.url} className="truncate">
                    {change.url}
                  </li>
                ))}
                {gained.length > 5 ? (
                  <li>…and {gained.length - 5} more</li>
                ) : null}
              </ul>
            </details>
          ) : null}

          {moved.length > 0 ? (
            <p className="mt-1 text-xs text-base-content/60">
              {moved.length} citation{moved.length === 1 ? "" : "s"} changed
              position. That is one finding, not two — the same page moved, so
              reporting it as a loss and a gain would say the model both dropped
              and found something it already had.
            </p>
          ) : null}
        </>
      )}

      {/*
       * **Always rendered, and the server's wording.** This is the sentence that
       * stops a lost citation being read as a verdict on the customer's own
       * content, which is the failure `answerDiff` was written to refuse.
       */}
      <p className="mt-2 border-t border-base-300 pt-2 text-xs text-base-content/50">
        {data.diff.caveat}
      </p>
    </div>
  );
}
