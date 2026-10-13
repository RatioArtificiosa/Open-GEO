/**
 * A component's hooks must all come before its first return.
 *
 * ## Why this is a source scan rather than a render test
 *
 * The failure is real and it is invisible. A hook placed after an early return is
 * conditional: it runs when the return is not taken and does not run when it is, so
 * React sees a different number of hooks between the two renders and corrupts its
 * own order. In a render test that only mounts the non-error state, nothing breaks —
 * and `EarnTheCitationPanel` had exactly that bug, caught by review rather than by
 * any test, because nothing mounted the error state and then cleared it.
 *
 * This repository's environment is `node` and it has no DOM renderer, so the
 * natural control — mount, error, clear — is not available. Rather than add a
 * testing library for one invariant, the shape is asserted statically, which is the
 * practice the platform-card gate already established for a defect that lives in
 * code rather than in a value.
 *
 * ## What the scan checks
 *
 * For the GEO panel: every `useState`/`useEffect` line index is below the first
 * early `return`. A line-index check catches the placement that broke and cannot
 * express the more general rule, which is fine — the more general rule needs a
 * parser, and a check that is 90% right and honest about which 10% it is not beats
 * one that is confidently wrong.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { at, first } from "@/shared/index-reads";

const PANEL = "src/client/features/geo/EarnTheCitationPanel.tsx";
const PAGE = "src/client/features/geo/GeoPage.tsx";

function hookOrder(source: string) {
  const lines = source.split("\n");
  const hookLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) =>
      /\buse(State|Effect|Memo|Callback|Ref|Query)\s*[<(]/.test(line),
    )
    .map(({ i }) => i);
  const returnLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s*return \(/.test(line))
    .map(({ i }) => i);

  // **Refuses a source with no return rather than handing back an empty list.**
  //
  // The first version returned `returnLines[0]` to its callers, where a caller
  // compared `index > undefined` — always false — and every assertion about hook
  // order passed vacuously. CodeRabbit flagged the comparison; the deeper problem
  // was that this function handed back a list whose emptiness it had not noticed.
  //
  // Refusing here means one place enforces it and the control is a call rather
  // than a property of one source file: a component with no return is a file
  // whose hook order cannot be worth checking at all.
  if (lines.length > 1 && returnLines.length === 0) {
    throw new Error(
      `hookOrder found no return in ${lines.length} lines — a scan that cannot see the boundary it is checking reports clean`,
    );
  }
  return { hookLines, returnLines };
}

describe("hook ordering in the GEO panels", () => {
  it("the citation panel's hooks all sit above its early return", () => {
    const source = readFileSync(PANEL, "utf8");
    const { hookLines, returnLines } = hookOrder(source);
    expect(hookLines.length).toBeGreaterThan(0);
    expect(returnLines.length).toBeGreaterThan(1); // the error return, then the real one
    // The first return is the error branch. Every hook must be before it.
    const firstReturn = at(returnLines, 0, "the component returns");
    // `at()` because the detector above refuses a source with no return, so the
    // index is provably present — and `index > undefined` is always false, so a
    // bare index would have passed every hook-order assertion vacuously. That is
    // the exact bug this file exists to catch.
    expect(firstReturn).toBeGreaterThanOrEqual(0);
    const afterIt = hookLines.filter((index) => index > firstReturn);
    expect(
      afterIt,
      `hooks after the first return are conditional hooks — React sees a different count between the error and non-error renders`,
    ).toEqual([]);
  });

  it("the GEO page's hooks all sit above its first return", () => {
    const source = readFileSync(PAGE, "utf8");
    const { hookLines, returnLines } = hookOrder(source);
    // **A return must exist before reading it.** CodeRabbit flagged the original:
    // `returnLines[0]` is `T | undefined`, and `index > undefined` is always
    // false, so a scan that found no return would have reported every assertion
    // passing. That is the vacuity hole this very file warns about elsewhere,
    // reintroduced by trusting an index. With `noUncheckedIndexedAccess` this
    // would be a compile error; without it, it is a runtime coin toss.
    const firstReturn = at(returnLines, 0, "the component returns");
    expect(
      returnLines.length,
      "the GEO page has a return to compare against",
    ).toBeGreaterThan(0);
    expect(firstReturn).toBeGreaterThanOrEqual(0);
    const afterIt = hookLines.filter((index) => index > firstReturn);
    expect(afterIt).toEqual([]);
  });

  it("the scan itself sees the panels' hooks, so a silent match is caught", () => {
    // **The vacuity guard.** An empty `hookLines` would pass every assertion above
    // for the wrong reason — the same shape as the empty-tree refusal the other
    // gates in this repository carry. The panel carries a `useState` and a
    // `useEffect`; the page carries one `useEffect`. Counted per file rather than
    // as a total, because a regex that stopped matching would empty both at once
    // and a total would not notice.
    const panel = hookOrder(readFileSync(PANEL, "utf8"));
    expect(panel.hookLines.length).toBeGreaterThanOrEqual(2);
    const page = hookOrder(readFileSync(PAGE, "utf8"));
    expect(page.hookLines.length).toBeGreaterThanOrEqual(1);
  });

  // **A source with no return is refused, not compared.** This is the control for
  // the refusal CodeRabbit's finding led to: `index > undefined` is always false,
  // so a scan that could not see a return would have reported every assertion
  // passing. Removing the guard makes this fail, which is what makes it a control
  // rather than a description.
  it("refuses a source with no return rather than comparing against undefined", () => {
    const noReturn = [
      "export function Panel({ errorMessage }: { errorMessage: string | null }) {",
      '  const [view, setView] = useState("list");',
      "  useEffect(() => {",
      "    doTrack(view);",
      "  }, [view]);",
      "}",
    ].join("\n");

    expect(() => hookOrder(noReturn)).toThrow(/found no return/);
  });

  // **The negative control.**
  //
  // `scripts/gates-about-gates.test.ts` keeps a list of the gates that have none,
  // and a test absent from that list without a control fails the meta-gate. This
  // one earns its place by feeding the rule the shape that actually shipped: a
  // component with a `useState` and a `useEffect`, and an early return between
  // them. That is the bug CodeRabbit found in `EarnTheCitationPanel`, and it was
  // invisible to every render test for the reason documented above — nothing
  // mounted the error state and then cleared it.
  it("fires on the shape that actually shipped", () => {
    const defect = [
      "export function Panel({ errorMessage }: { errorMessage: string | null }) {",
      '  const [view, setView] = useState("list");',
      "  if (errorMessage !== null) {",
      "    return (",
      "      <section>{errorMessage}</section>",
      "    );",
      "  }",
      "  useEffect(() => {",
      "    doTrack(view);",
      "  }, [view]);",
      "  return (",
      "    <section>{view}</section>",
      "  );",
      "}",
    ].join("\n");

    const { hookLines, returnLines } = hookOrder(defect);
    const firstReturn = at(returnLines, 0, "the component returns");
    const conditional = hookLines.filter((index) => index > firstReturn);

    // One hook sits after the early return — the one that makes the hook count
    // differ between the two renders. Asserting the *count* rather than the shape
    // is what makes this a control: a detector that stopped looking would return
    // an empty list and pass.
    expect(conditional).toHaveLength(1);

    // And the clean shape must not fire, so the detector is not simply flagging
    // everything. A gate that fires on correct code is worse than one that fires
    // on nothing, because the team learns to dismiss it.
    const clean = [
      "export function Panel({ errorMessage }: { errorMessage: string | null }) {",
      '  const [view, setView] = useState("list");',
      "  useEffect(() => {",
      "    doTrack(view);",
      "  }, [view]);",
      "  if (errorMessage !== null) {",
      "    return (",
      "      <section>{errorMessage}</section>",
      "    );",
      "  }",
      "  return (",
      "    <section>{view}</section>",
      "  );",
      "}",
    ].join("\n");
    const cleanOrder = hookOrder(clean);
    const cleanConditional = cleanOrder.hookLines.filter(
      (index) =>
        index >
        first(
          cleanOrder.returnLines,
          "the row under test (cleanOrder.returnLines)",
        ),
    );
    expect(cleanConditional).toEqual([]);
  });
});
