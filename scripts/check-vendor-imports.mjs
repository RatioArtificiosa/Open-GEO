#!/usr/bin/env node
/**
 * CL-202's standing rule: no vendor call outside the metered client.
 *
 * ## The bug class, and why a per-call-site fix does not close it
 *
 * `queuePlanner.postBatch` imported `postLlmResponseTasks` from the section
 * module and called it directly. The queued path therefore ran no
 * `assertUsageCreditsAvailable`, deducted no credits and recorded no vendor
 * figure: the platform's vendor account paid for queued captures of orgs whose
 * balance was never read — zero-credit orgs included — while the run log read
 * as metered, because the vendor's own `costUsd` was still being folded into
 * the run's budget figure.
 *
 * `observations-and-memories.md:11958` records the **same class** fixed once
 * before on the live path, with the note that the fix was applied per call
 * site and a later path through the same vendor call reopened the hole. So the
 * rule here is about the *surface*, not the call site: a file that reaches the
 * vendor around the client is refused whether the reach is a direct import, a
 * direct fetch, a helper that wraps the fetch, or a scheduled job that forgets
 * the client. The detector is the same shape as `billed-tasks-gate`,
 * `paid-tool-dry-run.test.ts` and the platform card rule, because the defect
 * lives in the code that *reaches for* a spend, not in any single input.
 *
 * ## What is checked, in order of how much money each one protects
 *
 * 1. **No spend primitive is imported outside the seam.** `dataforseoPost`,
 *    `dataforseoGet` and every `post*Task(s)` function move the vendor's money;
 *    importing one outside `src/server/lib/dataforseo/` is the defect above.
 * 2. **No seam binding is used outside the seam** — called, property-accessed,
 *    or passed as a default — unless the module is pure or the (file, binding)
 *    pair is named as an exemption with its reason. An alias-injection seam
 *    (`input.fetchX ?? fetchX`) is caught by the default pattern, because the
 *    call site it hides is the spend.
 * 3. **The barrel publishes no spend primitive.** `index.ts` is the seam's
 *    public surface and is imported freely; it must not become the hole.
 * 4. **The scan is not vacuous.** A scan of the wrong directory passes forever
 *    by finding nothing, which is the one failure a gate cannot recover from
 *    by being merely wrong: it refuses a file count or a caller count below a
 *    floor.
 *
 * ## The exemptions are named, never inferred
 *
 * An exemption that *infers* "this binding cannot spend" would also exempt a
 * spend whose shape changed. Every entry below names a file and a binding and
 * carries the reason it is safe, exactly as `paid-tool-dry-run.test.ts` names
 * `list_business_categories` and `get_page_waterfall`. A reader who disagrees
 * with a reason edits one line; a hole that widens without anyone noticing is
 * the failure this gate exists to prevent.
 *
 * ## What this gate cannot check
 *
 * It cannot tell whether an exempted read is really free — the vendor's own
 * billing envelope is the only evidence for that, and it does not exist for a
 * reference read. `resolveLlmModel`'s catalog read is the live example: it
 * carries no billing statement in-module, so its exemption names that gap and
 * the identifier is registered as unverified for CL-713's audit to settle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Declared in JSDoc rather than TypeScript, because this file has to be
 * executable as plain ESM — `node scripts/check-vendor-imports.mjs` runs it from
 * `ci:check`, so a `type` alias in it is a syntax error the moment node parses
 * it. The shapes are declared because the companion test imports the detector
 * and `tsc --noEmit` runs over that test.
 *
 * @typedef {{ file: string; line: number; binding: string; rule: string; detail: string }} Violation
 * @typedef {{ files: number; seamImporters: number; violations: Violation[] }} Report
 */

const ROOT = process.cwd();

/** The seam: the one directory allowed to talk to the vendor directly. */
const SEAM_DIR = "src/server/lib/dataforseo";
/** The metered client — the door everything else goes through. */
const CLIENT_MODULE = `${SEAM_DIR}/client`;
/** The seam's published surface. Importing it is allowed; see rule 3. */
const BARREL_MODULE = `${SEAM_DIR}/index`;
/** Where production sources live. */
const SCAN_ROOTS = ["src"];

/**
 * The calls that move the vendor's money.
 *
 * `dataforseoPost` / `dataforseoGet` are the raw transport; every
 * `post*Task(s)` function is a `task_post`, which is where DataForSEO charges.
 * Collection reads (`task_get`, `tasks_ready`) are deliberately **not** in this
 * set — the task was charged at post time — but they are still vendor calls, so
 * rule 2 covers them with named exemptions rather than by pattern.
 */
const SPEND_PRIMITIVE =
  /^(?:dataforseoPost|dataforseoGet|post[A-Za-z0-9]*Tasks?)$/;

/**
 * A SCREAMING_SNAKE_CASE binding is a constant, and a constant cannot spend.
 *
 * A structural rule rather than a per-name list, because the alternatives are
 * worse: inferring "cannot spend" from a module's contents would exempt a spend
 * whose shape changed, and a per-name list would grow one line per constant
 * forever. `LLM_MENTIONS_HISTORY_FLOOR`, `MAX_KEYWORD_CHARS` and
 * `AI_SUMMARY_PROMPT_MAX` are the three this rule covers today — all of them
 * values read from the price book's neighbourhood, none of them a call.
 */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Seam modules with no vendor I/O at all, verified by reading them on
 * 2026-10-13: constants, filter builders, response types and error classes.
 *
 * Listed as modules rather than bindings because a reader can check the claim
 * by opening one file; a per-binding list would be the same claim split across
 * dozens of lines for no gain.
 *
 * @type {Map<string, string>}
 */
const PURE_MODULES = new Map([
  ["shared", "constants and helpers; the module imports nothing at all"],
  [
    "filters",
    "SQL filter builders; imports only AppError and a schema constant",
  ],
  ["researchScopeFilters", "provider-side filter builders over filters.ts"],
  ["envelope", "response types and error classes; no I/O"],
]);

/**
 * The named exemptions: `file|binding` → why it is safe.
 *
 * @type {Map<string, string>}
 */
const EXEMPT_BINDINGS = new Map([
  [
    "src/server/features/geo/services/queueDrainRunner.ts|getLlmResponseTask",
    "the task_get collector: documented uncharged (cost 0), because the task was charged at task_post",
  ],
  [
    "src/server/features/geo/services/queueDrainRunner.ts|LLM_MODEL_SLUGS",
    "a constant list of platform slugs — data, not a call",
  ],
  [
    "src/server/mcp/tools/search-serp-locations.ts|fetchSerpLocationsForCountry",
    "the vendor's geotarget reference list; the module's own docblock records it as free (cost 0)",
  ],
  [
    "src/serverFunctions/serp-locations.ts|fetchSerpLocationsForCountry",
    "the vendor's geotarget reference list; the module's own docblock records it as free (cost 0)",
  ],
  [
    "src/server/features/keywords/services/reconcile-volumes.ts|fetchKeywordMetricsForList",
    "takes the metered client as its first argument, so every call it makes goes through the client — metered by construction",
  ],
  [
    "src/server/features/geo/services/scheduledAiKeywordCapture.ts|fetchAiKeywordVolume",
    "the test-injection seam; the runtime default is the metered aiSearch.keywordVolumeEnvelope",
  ],
  [
    "src/server/mcp/tools/geo-prompt-run-tool.ts|resolveLlmModel",
    "the model-catalog read: cached per process for a TTL with a documented fallback snapshot, and the response carries no billing envelope. Its cost is UNVERIFIED — registered as such for CL-713 rather than assumed",
  ],
  [
    "src/server/features/rank-tracking/services/RankTrackingService.ts|assertSerpLocationNameAccepted",
    "probes the vendor's sandbox, which the module's own docblock documents as validating request fields exactly like production at no cost",
  ],
]);

/**
 * Block and line comments, stripped before use-detection.
 *
 * Without this a docblock naming a fetcher — and this codebase's docblocks name
 * fetchers constantly — reads as a call, which is a gate that fails on prose.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Every static import and re-export in a file, as the module it names and the
 * bindings it brings in.
 *
 * `import type` is skipped whole: a type-only import is erased at compile and
 * cannot spend money. Inside a value import, a `type` specifier is skipped the
 * same way — `import { type WaterfallPage }` is a type.
 *
 * @param {string} source
 * @returns {{ module: string; bindings: string[]; isType: boolean; start: number }[]}
 */
export function importsOf(source) {
  const found = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const isType = match[2] !== undefined;
    const clause = match[3] ?? "";
    const bindings = [];
    // Named specifiers: `{ a, type b, c as d }`.
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) {
      for (const part of (named[1] ?? "").split(",")) {
        const spec = part.trim();
        if (spec === "" || spec.startsWith("type ")) continue;
        const asMatch = /\bas\s+([A-Za-z0-9_$]+)$/.exec(spec);
        bindings.push(asMatch ? (asMatch[1] ?? "") : spec);
      }
    }
    // Default and namespace specifiers: `X from` / `* as X from`.
    const bare = clause.replace(/\{[\s\S]*?\}/g, "").trim();
    const namespace = /\*\s*as\s+([A-Za-z0-9_$]+)$/.exec(bare);
    const defaultName = /^([A-Za-z0-9_$]+)$/.exec(bare);
    if (namespace) bindings.push(namespace[1] ?? "");
    else if (defaultName) bindings.push(defaultName[1] ?? "");
    found.push({
      module: match[4] ?? "",
      bindings,
      isType,
      start: match.index ?? 0,
    });
  }
  return found;
}

/**
 * Dynamic `await import("...")` specifiers — the other way to reach a module
 * around a static import rule.
 *
 * @param {string} source
 * @returns {{ module: string; start: number }[]}
 */
export function dynamicImportsOf(source) {
  const found = [];
  const pattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    found.push({ module: match[1] ?? "", start: match.index ?? 0 });
  }
  return found;
}

/**
 * Resolve an import specifier to a seam module name, or null when it does not
 * name one.
 *
 * Handles the `@/` alias and relative paths, so a reach-around through
 * `../../lib/dataforseo/labs` is the same violation as the aliased one.
 *
 * @param {string} specifier
 * @param {string} fromFile path of the importing file, relative to ROOT
 * @returns {string | null}
 */
export function seamModuleOf(specifier, fromFile) {
  let rel = null;
  if (specifier.startsWith("@/")) {
    // The `@/` alias is `src/` — see tsconfig paths. A reach-around through a
    // relative path resolves to the same module, so both spellings are handled.
    rel = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const dir = fromFile.includes("/")
      ? fromFile.slice(0, fromFile.lastIndexOf("/"))
      : "";
    const parts = `${dir}/${specifier}`.split("/");
    const stack = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    rel = stack.join("/");
  }
  if (rel === null) return null;
  // `.../dataforseo`, `.../dataforseo.ts` and `.../dataforseo/index` are the
  // barrel; anything under `.../dataforseo/` is a section module. The sibling
  // `dataforseoBillingClassification` is outside the seam and is not caught,
  // because the boundary is the directory, not the prefix.
  const bare = rel.replace(/\.(ts|tsx)$/, "").replace(/\/index$/, "");
  if (bare === SEAM_DIR) return BARREL_MODULE;
  if (bare.startsWith(`${SEAM_DIR}/`)) return bare;
  return null;
}

/**
 * Is this binding *used* — called, property-accessed, or passed as a value —
 * anywhere outside its own import statement?
 *
 * The patterns are deliberately narrow, and each one is a way a spending call
 * hides: `name(` is the call; `name.` is the call through a namespace or a
 * constant's method (`LLM_MODEL_SLUGS.find`); `?? name` and `= name` are the
 * injection seams that make a raw fetcher the runtime default.
 *
 * @param {string} source comment-stripped
 * @param {string} binding
 * @param {number} importStart
 * @returns {boolean}
 */
export function usesBinding(source, binding, importStart) {
  const escaped = binding.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b${escaped}\\s*\\(`),
    new RegExp(`\\b${escaped}\\.`),
    new RegExp(`\\?\\?\\s*${escaped}\\b`),
    new RegExp(`[=,(:]\\s*${escaped}\\b`),
  ];
  // Everything after the import statement that brought the binding in.
  const after = source.slice(importStart);
  return patterns.some((pattern) => pattern.test(after));
}

/**
 * Production sources: every `.ts` / `.tsx` under the scan roots, minus tests
 * and declarations. Tests are excluded because a test that imports a section
 * module to mock it is testing that module, not reaching the vendor.
 *
 * @param {string[]} [scanRoots]
 * @param {string} [root]
 * @returns {string[]}
 */
export function sourceFiles(scanRoots = SCAN_ROOTS, root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
        continue;
      found.push(relative(root, full).replaceAll("\\", "/"));
    }
  };
  for (const dir of scanRoots) walk(join(root, dir));
  return found;
}

/**
 * The barrel's exports, as binding names.
 *
 * @param {string} source
 * @returns {string[]}
 */
function barrelExports(source) {
  const found = [];
  const pattern = /export\s*(?:type\s*)?\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(pattern)) {
    for (const part of (match[1] ?? "").split(",")) {
      const spec = part.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      const asMatch = /\bas\s+([A-Za-z0-9_$]+)$/.exec(spec);
      found.push(asMatch ? (asMatch[1] ?? "") : spec);
    }
  }
  return found;
}

/**
 * Run the gate. Exported so the companion test can point it at a fixture tree
 * instead of the real `src/`.
 *
 * `minFiles` / `minSeamImporters` are the vacuity floors; the test lowers them
 * for the synthetic tree and raises them back for the real one, so the vacuity
 * rule is itself exercised rather than assumed.
 *
 * @param {{ root?: string; scanRoots?: string[]; minFiles?: number; minSeamImporters?: number }} [options]
 * @returns {Report}
 */
export function checkVendorImports(options = {}) {
  const root = options.root ?? ROOT;
  const scanRoots = options.scanRoots ?? SCAN_ROOTS;
  const minFiles = options.minFiles ?? 700;
  const minSeamImporters = options.minSeamImporters ?? 50;
  /** @type {Violation[]} */
  const violations = [];
  let seamImporters = 0;

  const files = sourceFiles(scanRoots, root);
  for (const file of files) {
    const absolute = join(root, file);
    const source = stripComments(readFileSync(absolute, "utf8"));
    const inSeam = file.startsWith(`${SEAM_DIR}/`);
    const imports = importsOf(source).filter((entry) => !entry.isType);

    for (const entry of imports) {
      const module = seamModuleOf(entry.module, file);
      if (module === null) continue;
      seamImporters += 1;
      if (inSeam) continue; // the seam's own wiring
      if (module === CLIENT_MODULE) continue; // the door
      if (module === BARREL_MODULE) continue; // the published surface (rule 3)

      for (const binding of entry.bindings) {
        if (binding === "") continue;
        if (SPEND_PRIMITIVE.test(binding)) {
          violations.push({
            file,
            line: lineOf(source, entry.start),
            binding,
            rule: "spend-primitive",
            detail:
              "imports a spend primitive from the vendor seam. DataForSEO charges at task_post, so this call moves the platform's money with no credit gate and no deduction — CL-202. Route it through createDataforseoClient.",
          });
          continue;
        }
        if (CONSTANT_NAME.test(binding)) continue; // a value, never a call
        if (PURE_MODULES.has(module.replace(`${SEAM_DIR}/`, ""))) continue;
        if (EXEMPT_BINDINGS.has(`${file}|${binding}`)) continue;
        if (usesBinding(source, binding, entry.start)) {
          violations.push({
            file,
            line: lineOf(source, entry.start),
            binding,
            rule: "vendor-call-outside-client",
            detail: `uses the seam binding ${binding} from ${module} outside the metered client. Either route it through createDataforseoClient or name it in EXEMPT_BINDINGS with the reason it is safe.`,
          });
        }
      }
    }

    for (const entry of dynamicImportsOf(source)) {
      const module = seamModuleOf(entry.module, file);
      if (module === null || inSeam) continue;
      if (module === CLIENT_MODULE || module === BARREL_MODULE) continue;
      violations.push({
        file,
        line: lineOf(source, entry.start),
        binding: entry.module,
        rule: "dynamic-import-of-seam",
        detail:
          "dynamically imports a vendor section module. A dynamic import is still a vendor call, and it does not go through the metered client.",
      });
    }
  }

  // Rule 3: the barrel must not publish a spend primitive. It is imported
  // freely, so a primitive there would reopen the hole this gate closes.
  const barrelFile = `${BARREL_MODULE}.ts`;
  const barrel = sourceFiles(scanRoots, root).includes(barrelFile)
    ? stripComments(readFileSync(join(root, barrelFile), "utf8"))
    : null;
  if (barrel !== null) {
    for (const binding of barrelExports(barrel)) {
      if (SPEND_PRIMITIVE.test(binding)) {
        violations.push({
          file: BARREL_MODULE,
          line: lineOf(barrel, barrel.indexOf(binding)),
          binding,
          rule: "barrel-publishes-spend-primitive",
          detail:
            "the seam's public surface publishes a spend primitive, so any importer can reach the vendor around the client.",
        });
      }
    }
  }

  // Rule 4: the vacuity guard. A scan of the wrong tree passes forever by
  // finding nothing, and that is the one failure mode a gate cannot recover
  // from by being merely wrong.
  if (files.length < minFiles) {
    violations.push({
      file: SEAM_DIR,
      line: 0,
      binding: "—",
      rule: "vacuous-scan",
      detail: `read ${files.length} source files; expected at least ${minFiles}. The scan is looking at the wrong tree.`,
    });
  }
  if (seamImporters < minSeamImporters) {
    violations.push({
      file: SEAM_DIR,
      line: 0,
      binding: "—",
      rule: "vacuous-scan",
      detail: `found ${seamImporters} seam imports; expected at least ${minSeamImporters}. A scan that finds no callers passes forever.`,
    });
  }

  return { files: files.length, seamImporters, violations };
}

/** 1-based line of an offset, for a report a reader can act on. */
function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

/**
 * CLI entry: `node scripts/check-vendor-imports.mjs [--dir <path>]`.
 *
 * `--dir` is the fixture override the companion test uses — a synthetic tree
 * with one deliberate violation, so the negative control runs in CI rather
 * than depending on someone remembering to inject the defect by hand.
 */
function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf("--dir");
  const report =
    dirFlag === -1
      ? checkVendorImports()
      : checkVendorImports({
          root: ROOT,
          scanRoots: [args[dirFlag + 1] ?? "src"],
        });

  if (report.violations.length === 0) {
    console.log(
      `check-vendor-imports: ${report.files} files scanned, ${report.seamImporters} seam imports, no vendor call outside the metered client.`,
    );
    return;
  }
  console.error(
    `check-vendor-imports: ${report.violations.length} violation(s) across ${report.files} files scanned:\n`,
  );
  for (const violation of report.violations) {
    console.error(
      `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.binding}\n    ${violation.detail}\n`,
    );
  }
  process.exitCode = 1;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
})();

if (isMain) main();
