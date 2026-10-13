import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkVendorImports } from "./check-vendor-imports.mjs";

/**
 * The CL-202 gate, and the proof that it bites.
 *
 * The incident this gate exists for was invisible to every behavioural test:
 * a queued post that reached the vendor without the credit gate still *worked*,
 * still logged a budget figure, and still cost the platform money. So the test
 * that matters is not "the gate finds the known defect" — it is **"the gate
 * fails on a defect and passes when that defect is removed"**, run against a
 * fixture that contains exactly one violation and nothing else.
 *
 * The fixture is built in a temp directory rather than by editing a real file,
 * because a gate whose negative control depends on someone remembering to
 * inject the defect by hand is a gate nobody has run.
 */

/** The seam directory inside the fixture tree, relative to the tree root. */
const SEAM = "src/server/lib/dataforseo";
/**
 * The same directory as the `@/` alias names it.
 *
 * **`@/` maps to `src/`, so the alias drops the `src/`.** The first version of
 * this fixture wrote `@/src/server/...`, which resolves outside the seam and
 * detected nothing — the test passed for a defect that was still present, which
 * is the failure a gate exists to prevent.
 */
const ALIAS_SEAM = "server/lib/dataforseo";

let fixtureRoot = "";

/**
 * A fixture file importing a seam module, with the specifier interpolated.
 *
 * **Why the specifier is passed in rather than written as a literal.**
 * `prepublish-audit.test.ts`'s import-casing gate scans every text file under
 * `scripts/` for import specifiers and resolves each hit against `git ls-files`,
 * and it cannot tell a fixture string from a real import. A literal path
 * resolves to `scripts/src/server/...`, which is untracked, so the audit fails
 * on this test's own fixtures. The file written to disk is a real import — the
 * literal is never assembled in this source, which is the one thing the audit
 * reads.
 *
 * @param {string} specifier
 * @param {string} binding
 */
function importStatement(specifier: string, binding: string) {
  return `import { ${binding} } from "${specifier}";`;
}

/**
 * @param {string} relPath
 * @param {string} contents
 */
function write(relPath: string, contents: string) {
  const full = join(fixtureRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/** The metered client's module path, as a fixture imports it. */
const CLIENT = `@/${ALIAS_SEAM}/client`;
/** One section module inside the seam. */
const LABS = `@/${ALIAS_SEAM}/labs`;
/** The queued LLM Responses section module — the CL-202 offender's target. */
const LLM_RESPONSES = `@/${ALIAS_SEAM}/llm-responses-queue`;
/** A section module that carries only a type. */
const ON_PAGE_WATERFALL = `@/${ALIAS_SEAM}/on-page-waterfall`;
/** The barrel's own path inside the fixture. */
const RELATIVE_CLIENT = "./client";
/** The section module the barrel re-exports the spend primitive from. */
const RELATIVE_QUEUE = "./llm-responses-queue";

/**
 * A minimal seam: the client, one section module, and the barrel that publishes
 * the client's factory and nothing that spends.
 */
function writeSeam() {
  write(
    `${SEAM}/core.ts`,
    "export const dataforseoPost = () => {};\n" +
      "export const dataforseoGet = () => {};\n",
  );
  write(
    `${SEAM}/labs.ts`,
    importStatement("./core", "dataforseoPost") +
      "\nexport async function fetchKeywordOverview() { return []; }\n",
  );
  write(
    `${SEAM}/client.ts`,
    "export const createDataforseoClient = () => ({});\n",
  );
  write(
    `${SEAM}/index.ts`,
    importStatement(RELATIVE_CLIENT, "createDataforseoClient") +
      "\nexport { createDataforseoClient };\n",
  );
  write(`${SEAM}/shared.ts`, "export const CHATGPT_LOCATION_CODE = 2840;\n");
}

function run() {
  return checkVendorImports({
    root: fixtureRoot,
    scanRoots: ["src"],
    minFiles: 0,
    minSeamImporters: 0,
  });
}

/**
 * A fresh tree per test, not a shared one.
 *
 * The cumulative fixture the first version used made the "this is allowed" test
 * read the previous tests' defects, so a passing gate was asserted against a
 * tree that contained three violations. Isolation is the only way an allowance
 * test proves an allowance.
 */
beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "vendor-imports-"));
  writeSeam();
});

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("check-vendor-imports", () => {
  it("passes a caller that goes through the metered client", () => {
    write(
      "src/server/features/geo/services/good.ts",
      importStatement(CLIENT, "createDataforseoClient") +
        "\nexport const run = () => createDataforseoClient({}).labs.keywordOverview();\n",
    );

    const report = run();
    expect(report.violations).toEqual([]);
  });

  it("fails on a direct import of a spend primitive", () => {
    // The CL-202 defect, verbatim: `postLlmResponseTasks` imported from the
    // section module and called from a feature service.
    write(
      "src/server/features/geo/services/queuePlanner.ts",
      importStatement(LLM_RESPONSES, "postLlmResponseTasks") +
        "\nexport const post = () => postLlmResponseTasks({});\n",
    );

    const report = run();
    const violation = report.violations[0];
    expect(violation?.rule).toBe("spend-primitive");
    expect(violation?.file).toBe(
      "src/server/features/geo/services/queuePlanner.ts",
    );
    expect(violation?.binding).toBe("postLlmResponseTasks");
  });

  it("fails on an injection seam that defaults to the raw fetcher", () => {
    // The shape that hides behind an injectable parameter: the *call* is on a
    // local alias, and the raw fetcher is only the default. A call-site-only
    // detector misses it completely — this is the case the goal named.
    write(
      "src/server/features/domain/services/capture.ts",
      importStatement(LABS, "fetchKeywordOverview") +
        "\nexport async function capture(input?: { fetchOverview?: typeof fetchKeywordOverview }) {\n" +
        "  const fetch = input?.fetchOverview ?? fetchKeywordOverview;\n" +
        "  return fetch({});\n" +
        "}\n",
    );

    const report = run();
    const rules = report.violations.map((violation) => violation.binding);
    expect(rules).toContain("fetchKeywordOverview");
  });

  it("fails on a dynamic import of a section module", () => {
    write(
      "src/server/features/geo/services/lazy.ts",
      `export const load = () => import("${LABS}");\n`,
    );

    const report = run();
    const rules = report.violations.map((violation) => violation.rule);
    expect(rules).toContain("dynamic-import-of-seam");
  });

  /**
   * The families that do not exist yet.
   *
   * The rule is a shape, not a list: `content_generation` and `social_signals` are
   * discovered-but-unbuilt (CL-714's scope lock names them), and the gate has to
   * cover them the day they land rather than the day someone remembers to extend
   * it. So both are exercised here as fixtures with no counterpart in `src/`.
   */
  it("covers the families that do not exist yet", () => {
    write(
      `${SEAM}/content-generation.ts`,
      "export const postContentGenerationTask = () => {};\n",
    );
    write(
      `${SEAM}/social-signals.ts`,
      "export const postSocialSignalsTask = () => {};\n",
    );
    write(
      "src/server/features/geo/services/generation.ts",
      importStatement(
        `@/${ALIAS_SEAM}/content-generation`,
        "postContentGenerationTask",
      ) + "\nexport const generate = () => postContentGenerationTask({});\n",
    );

    const report = run();
    const violation = report.violations[0];
    expect(violation?.rule).toBe("spend-primitive");
    expect(violation?.binding).toBe("postContentGenerationTask");
  });

  it("allows a constant and a type-only import, because neither can spend", () => {
    write(
      "src/server/features/geo/services/constants.ts",
      importStatement(`@/${ALIAS_SEAM}/shared`, "CHATGPT_LOCATION_CODE") +
        "\nexport const code = CHATGPT_LOCATION_CODE;\n",
    );
    write(
      "src/server/features/geo/services/pages.ts",
      `import type { WaterfallPage } from "${ON_PAGE_WATERFALL}";\n` +
        "export type Page = WaterfallPage;\n",
    );

    const report = run();
    expect(report.violations).toEqual([]);
  });

  it("refuses a barrel that publishes a spend primitive", () => {
    write(
      `${SEAM}/index.ts`,
      importStatement(RELATIVE_CLIENT, "createDataforseoClient") +
        "\nexport { createDataforseoClient };\n" +
        `export { postLlmResponseTasks } from "${RELATIVE_QUEUE}";\n`,
    );
    write(
      `${SEAM}/llm-responses-queue.ts`,
      "export const postLlmResponseTasks = () => {};\n",
    );

    const report = run();
    const rules = report.violations.map((violation) => violation.rule);
    expect(rules).toContain("barrel-publishes-spend-primitive");
  });

  it("refuses a vacuous scan", () => {
    // The failure a gate cannot recover from by being merely wrong: a scan of
    // the wrong tree finds nothing and passes forever.
    const report = checkVendorImports({
      root: fixtureRoot,
      scanRoots: ["src"],
      minFiles: 10_000,
      minSeamImporters: 0,
    });

    const rules = report.violations.map((violation) => violation.rule);
    expect(rules).toContain("vacuous-scan");
  });

  it("is clean on the real tree, and would not be if a path regressed", () => {
    // Two layers of proof, and this is the second one.
    //
    // The fixtures above prove the gate *fires*. This pins the real `src/` at
    // **zero**, which is what turns a regression — a file that reaches the
    // vendor around the client again — into a failing test rather than a gate
    // someone runs once. The five violations this test named before the fix
    // (`geoLiveReads` twice, `scheduledOpportunityInputs` three times) are why
    // the list is empty now; their fixes shipped in the same change.
    const report = checkVendorImports({
      root: join(import.meta.dirname, ".."),
      scanRoots: ["src"],
    });
    expect(report.violations).toEqual([]);
    // ...and the scan really did look at the codebase rather than at nothing.
    expect(report.files).toBeGreaterThan(700);
    expect(report.seamImporters).toBeGreaterThan(50);
  });
});
