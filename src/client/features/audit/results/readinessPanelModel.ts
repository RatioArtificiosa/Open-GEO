/**
 * The readiness panel's decisions, as pure functions.
 *
 * ## Why this is a separate module
 *
 * **Because every testable claim in the panel is a decision about what to say,
 * and a decision inside a `.tsx` file needs a DOM to reach.** The project's own
 * convention — `ScoreRing.test.ts` testing `arcFor`, `LivePanels.test.ts`
 * testing the panel's logic — is to extract the decision and test that directly.
 *
 * The rule it encodes is worth stating because it is the whole point of the
 * report: **"we could not check" and "we checked and found nothing" are different
 * answers, and a reader who cannot tell them apart concludes their site is fine.**
 */

/** The report as the server sends it. `null` when the phase did not complete. */
type Report = {
  summary: string;
  whyNoScore: string;
  fixes: Array<{
    id: string;
    kind: string;
    fix: string;
    because: string;
    example: string | null;
    order: number;
  }>;
  /** `null` when the stored value was unreadable, which is not the same as `[]`. */
  coverage: string[] | null;
  unavailable: Array<{ what: string; because: string }>;
};

/**
 * What the panel should lead with.
 *
 * Module-private: the panel reads `.kind` and narrows, so it never names this
 * type, and an exported type nobody names is a lie about the API surface.
 */
type ReadinessHeadline =
  | { kind: "unavailable"; message: string }
  | {
      /**
       * The run finished what it could and found nothing — but not everything
       * finished. **Distinct from `clean`,** because a reader who hears "nothing
       * to change" stops reading, and a reader who hears this will open the
       * caveats and check.
       */
      kind: "incomplete";
      message: string;
    }
  | { kind: "clean"; message: string }
  | { kind: "fixes"; count: number; label: string; message: string };

export function readinessHeadline(readiness: Report | null): ReadinessHeadline {
  if (readiness === null) {
    // **Never the clean phrasing.** A missing report is an absence of evidence,
    // and evidence we do not have is not evidence that nothing is wrong.
    return {
      kind: "unavailable",
      message:
        "We could not finish this check, so we are not going to imply your site is fine. The crawl below is unaffected.",
    };
  }
  if (readiness.fixes.length === 0) {
    // **Only a clean bill when the checks actually completed.** CodeRabbit's
    // major, and the most important finding of this milestone: this branch used
    // to say "Nothing to change" on a report whose coverage was unknown or whose
    // checks were unavailable — **which is the exact false all-clear this whole
    // design exists to prevent**, reached through the one branch nobody
    // cross-examined.
    //
    // Three conditions, not one. A partial run is a different sentence, and the
    // reader's next question — *what did you not look at?* — is answered by the
    // caveats below rather than here.
    const incomplete =
      readiness.coverage === null || readiness.unavailable.length > 0;
    if (incomplete) {
      return {
        kind: "incomplete",
        message:
          "Nothing came back from the checks that finished, but we could not finish all of them. Open the list below to see what was not checked.",
      };
    }
    return {
      kind: "clean",
      message:
        "Nothing to change. The checks below all ran and none found anything worth your time.",
    };
  }
  return {
    kind: "fixes",
    count: readiness.fixes.length,
    // **The plural axis follows the count**, because "1 fixes" is the kind of
    // small wrongness that costs a reader their confidence in the whole report.
    label: readiness.fixes.length === 1 ? "fix" : "fixes",
    message: readiness.summary,
  };
}

/** Module-private for the same reason as `ReadinessHeadline`. */
type CoverageNoteState =
  | { kind: "unknown" }
  | { kind: "caveats"; count: number; lines: string[] };

export function coverageNote(readiness: Report): CoverageNoteState | null {
  if (readiness.coverage === null) {
    // **A corrupt column is not an empty one.** Null says "we cannot tell you
    // what we checked", which is the truth, and it is its own message rather than
    // a caveat list that reads like a short one.
    return { kind: "unknown" };
  }
  // **Gaps only, not completed work.** The disclosure is headed "what this
  // report could not check", so mixing in lines about checks that *did* run makes
  // the count wrong in the reader's favour — a report with one gap and two
  // successful checks announced "could not check (3)". `coverage` is a positive
  // statement about what was verified; it belongs in the report's own account of
  // itself, not in a list of failures.
  const lines = [
    ...(readiness.coverage ?? []).map((line) => `Not verified: ${line}`),
    ...readiness.unavailable.map((note) => `${note.what} — ${note.because}`),
  ];
  const count = lines.length;
  // **A complete report must look finished.** A permanent "some checks may not
  // have run" line trains readers to ignore the ones that matter.
  if (count === 0) return null;
  return { kind: "caveats", count, lines };
}

/**
 * The border rule for one fix.
 *
 * **A `switch` is a precondition** — the thing that makes the other fixes
 * possible — so it gets the loudest edge, and a reader can find it without
 * reading. `convention` and `quality` share a quieter rule on purpose: the
 * distinction between them is a matter of taste about *how* to fix something, and
 * giving it a third colour would imply a severity the report does not claim.
 */
export function fixBorderRule(kind: string): string {
  switch (kind) {
    case "switch":
      return "border-l-error";
    case "convention":
      return "border-l-warning";
    default:
      return "border-l-base-content/20";
  }
}
