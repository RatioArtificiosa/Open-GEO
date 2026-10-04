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
    // A real result now: the checks ran and none found anything worth the time.
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
  const count = readiness.coverage.length + readiness.unavailable.length;
  // **A complete report must look finished.** A permanent "some checks may not
  // have run" line trains readers to ignore the ones that matter.
  if (count === 0) return null;
  return {
    kind: "caveats",
    count,
    lines: [
      ...readiness.coverage,
      ...readiness.unavailable.map((note) => `${note.what} — ${note.because}`),
    ],
  };
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
