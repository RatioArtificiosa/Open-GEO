import { CircleCheck, CircleHelp, Lock, Wrench } from "lucide-react";
import type { AuditResultsData } from "@/client/features/audit/results/types";
import {
  coverageNote,
  fixBorderRule,
  readinessHeadline,
} from "@/client/features/audit/results/readinessPanelModel";

/**
 * The readiness report: what to fix first, and why.
 *
 * ## Why it sits above the tabs rather than inside one
 *
 * **Because it is the answer, and the tabs are the evidence.** A reader opening
 * an audit wants to know what to do; `pages`, `issues` and `performance` are how
 * they check the work. Putting the prioritised list behind a tab would make the
 * answer the hardest thing on the page to find — **and it would invert the
 * product's whole argument**, which is that a blocked crawler outranks everything
 * because it is a precondition. A precondition buried in a tab is not a
 * precondition.
 *
 * ## The decisions live in `readinessPanelModel.ts`
 *
 * **Every claim this component makes is a decision about what to say**, and a
 * decision inside a `.tsx` file needs a DOM to test — which is why the project's
 * suite is `*.test.ts` and why `ScoreRing` extracts `arcFor` for the same reason.
 * The two empty states in particular are load-bearing and are tested there.
 */
type ReadinessReport = NonNullable<AuditResultsData["readiness"]>;
type ReadinessFix = ReadinessReport["fixes"][number];

export function ReadinessPanel({
  readiness,
}: {
  readiness: AuditResultsData["readiness"];
}) {
  const headline = readinessHeadline(readiness);

  return (
    <section className="card border border-base-300 bg-base-100">
      <div className="card-body gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="card-title text-base">
              {headline.kind === "fixes"
                ? "What to fix first"
                : headline.kind === "clean"
                  ? "Nothing to change"
                  : "Readiness report unavailable"}
            </h2>
            <p className="text-sm text-base-content/70">{headline.message}</p>
          </div>
          {headline.kind === "fixes" && (
            <span className="badge badge-neutral badge-sm shrink-0">
              {headline.count} {headline.label}
            </span>
          )}
        </header>

        {headline.kind === "clean" && (
          <p className="flex items-center gap-2 text-sm text-base-content/80">
            <CircleCheck className="size-4 shrink-0 text-success" />
            Every check below ran, and none found anything worth your time.
          </p>
        )}

        {readiness !== null && <WhyNoScore whyNoScore={readiness.whyNoScore} />}

        {headline.kind === "fixes" && (
          <ol className="space-y-2">
            {(readiness?.fixes ?? []).map((fix) => (
              <FixRow key={fix.id} fix={fix} />
            ))}
          </ol>
        )}

        {readiness !== null && <CoverageNote readiness={readiness} />}
      </div>
    </section>
  );
}

/**
 * The reason there is no overall number, always shown.
 *
 * **Never collapsed away.** A reader who cannot see it is left to invent one, and
 * inventing one usually means "the score must be fine" — which is the one
 * conclusion this report must not support.
 */
function WhyNoScore({ whyNoScore }: { whyNoScore: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-base-200/60 px-3 py-2 text-xs text-base-content/70">
      <CircleHelp className="mt-0.5 size-3.5 shrink-0" />
      <span>{whyNoScore}</span>
    </p>
  );
}

/**
 * One fix, with the reason it sits where it does.
 *
 * **`because` is rendered above `fix`, not after it.** A row that says only
 * "Allow GPTBot" is a task; a row that says "nothing else works until agents can
 * read the site" is a decision. The reason is the part that stops someone
 * re-sorting the list by how easy each item looks.
 */
function FixRow({ fix }: { fix: ReadinessFix }) {
  return (
    <li
      className={`rounded-lg border border-base-300 border-l-4 px-3 py-2.5 ${fixBorderRule(fix.kind)}`}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-base-content/50">
          {fix.kind === "switch" ? (
            <Lock className="size-4" />
          ) : (
            <Wrench className="size-4" />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-base-content/60">{fix.because}</p>
          <p className="text-sm font-medium">{fix.fix}</p>
          {fix.example !== null && (
            <pre className="mt-1.5 overflow-x-auto rounded bg-base-200 px-2 py-1.5 text-xs">
              <code>{fix.example}</code>
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * What the run could not check.
 *
 * **Rendered only when there is something to say** — see `coverageNote`, where
 * that decision is tested.
 */
function CoverageNote({ readiness }: { readiness: ReadinessReport }) {
  const note = coverageNote(readiness);

  if (note === null) return null;

  if (note.kind === "unknown") {
    return (
      <p className="text-xs text-base-content/60">
        We could not read back what this run checked, so treat the list above as
        partial.
      </p>
    );
  }

  return (
    <details className="text-xs text-base-content/60">
      <summary className="cursor-pointer select-none">
        What this report could not check ({note.count})
      </summary>
      <ul className="mt-1.5 space-y-1 pl-4">
        {note.lines.map((line) => (
          <li key={line} className="list-disc">
            {line}
          </li>
        ))}
      </ul>
    </details>
  );
}
