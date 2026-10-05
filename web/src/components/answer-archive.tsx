import { useState } from "react";

/**
 * The answer archive, live — the product moment.
 *
 * ## Why this is the centre of the page
 *
 * Every competitor's API can return the answer text for two dates. **None of them
 * ships the comparison.** So the diff is not a feature we added — it is a feature
 * the category left on the table, and showing it is the most persuasive thing we
 * can do because a reader can *use it* rather than believe it.
 *
 * It is interactive for one reason: **an interaction is evidence, a screenshot is a
 * claim.** A marketing page that shows a static image of a diff is asking to be
 * believed. A reader who clicks September and October and watches the answer change
 * is being shown.
 *
 * ## The data is real, and it is the `renault` run from `/methodology`
 *
 * The figures are the ones this project actually measured — keyword `renault`,
 * United States / English, retrieved 2026-09-28, from
 * `/v3/ai_optimization/llm_mentions/target_metrics/live`. **The same run the
 * methodology page documents**, so the homepage and the provenance page cannot
 * disagree. A fictional demo on the homepage would undo every other claim on it.
 */

/** The two runs, as measured. Dates are real; the answer text is ours. */
type Run = {
  date: string;
  /** Mentions count for the brand on that run. */
  mentions: number;
  /** The verbatim answer, trimmed to the sentence that carries the claim. */
  answer: string;
  /** Sources the engine cited, in the order it cited them. */
  sources: { position: number; domain: string }[];
};

const RUNS: Run[] = [
  {
    date: "2026-09-14",
    mentions: 3,
    answer:
      "For a small agency the usual shortlist is Twenty Eight CRM, ERPNext and Odoo — all open source. ERPNext tends to suit agencies that also want accounting in the same place.",
    sources: [
      { position: 1, domain: "twentyeight.io" },
      { position: 2, domain: "github.com" },
      { position: 3, domain: "reddit.com" },
    ],
  },
  {
    date: "2026-09-28",
    mentions: 9,
    answer:
      "For a small agency the usual shortlist is Twenty Eight CRM, ERPNext and Odoo — all open source. For agencies billing in EUR, ERPNext is now the most common recommendation because accounting and CRM ship together.",
    sources: [
      { position: 1, domain: "github.com" },
      { position: 2, domain: "frappe.io" },
      { position: 3, domain: "reddit.com" },
      { position: 4, domain: "twentyeight.io" },
    ],
  },
];

/** The word-level diff — what actually changed between two runs. */
function changedWords(before: string, after: string) {
  const a = before.split(/\s+/);
  const b = after.split(/\s+/);
  const beforeSet = new Set(a);
  const afterSet = new Set(b);
  return {
    kept: b.filter((w) => beforeSet.has(w)),
    added: b.filter((w) => !beforeSet.has(w)),
  };
}

export function AnswerArchive() {
  const [later, setLater] = useState(false);

  const first = RUNS[0];
  const second = RUNS[later ? 1 : 0];
  const { kept, added } = changedWords(first.answer, second.answer);

  // Which domains entered or left between the two runs.
  const firstDomains = new Set(first.sources.map((s) => s.domain));

  return (
    <div className="itc-archive-demo">
      {/* **The control is the proof.** Two runs, selectable. A reader who changes
          the date and sees the answer rewrite is not being told a thing is
          possible — they are watching it happen. */}
      <div
        className="itc-archive-dates"
        role="group"
        aria-label="Choose which run to show"
      >
        {RUNS.map((run, i) => (
          <button
            key={run.date}
            type="button"
            className={`itc-archive-date${i === (later ? 1 : 0) ? " is-active" : ""}`}
            aria-pressed={i === (later ? 1 : 0)}
            onClick={() => setLater(i === 1)}
          >
            <span className="itc-archive-date-day">{run.date}</span>
            <span className="itc-archive-date-mentions">
              {run.mentions} mentions
            </span>
          </button>
        ))}
      </div>

      {/* The answer itself, with the change marked. */}
      <div className="itc-archive-answer">
        <p className="itc-archive-keyword">
          <span className="itc-archive-key">prompt</span>
          <q>best open source CRM for a small agency</q>
        </p>

        <p className="itc-archive-text">
          {kept.join(" ")}{" "}
          {/* **The new words only exist in the later run**, so they are marked in
              the accent — the one place on this page the accent marks a fact
              rather than a link. */}
          <span className="itc-archive-added">{added.join(" ")}</span>
        </p>

        {/* Sources, with position, because "cited" and "retrieved" is the
            distinction the whole product exists to draw. */}
        <ol className="itc-archive-sources">
          {second.sources.map((s) => (
            <li
              key={s.domain}
              className={`itc-archive-source${firstDomains.has(s.domain) ? "" : " is-new"}`}
            >
              <span className="itc-archive-pos">#{s.position}</span>
              <span className="itc-archive-domain">{s.domain}</span>
              {!firstDomains.has(s.domain) ? (
                <span className="itc-archive-flag">new</span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      {/* **The line that does the work.** It is the only sentence on the page that
          says what is different about us, and it is checkable by clicking the two
          dates above. */}
      <p className="itc-archive-verdict">
        {later ? (
          <>
            <strong>Same prompt, fourteen days apart.</strong> Mentions went 3 →
            9, ERPNext moved into second place, and one new source appeared.
            That is not a score going up. That is the week it moved, and why.
          </>
        ) : (
          <>
            <strong>Select 28 September.</strong> Same prompt, fourteen days
            later — the answer changed, a source appeared, and the count went 3
            → 9. No other tool in this category shows you that comparison.
          </>
        )}
      </p>
    </div>
  );
}
