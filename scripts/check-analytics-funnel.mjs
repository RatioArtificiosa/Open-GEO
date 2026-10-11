#!/usr/bin/env node
/**
 * The conversion funnel must actually be wired (CL-617).
 *
 * ## What goes wrong without this
 *
 * A funnel's four stages live in four files. Rename an event at one call site and
 * the funnel loses a stage — the page reports zero for it, and nobody can tell
 * that from a stage nobody ever triggered. That is the same failure as the
 * checklist drifting from the tree: a claim about the system that is checked
 * nowhere.
 *
 * So the scan asserts every stage in `FUNNEL_EVENTS` is referenced by some
 * non-declaration file, and the report names where each fires.
 *
 * ## Why a source scan rather than an integration test
 *
 * The events are client-side analytics. An integration test could assert a click
 * fires a capture, but it cannot know that the capture is the one the funnel is
 * built on — the name is what matters, and the name is a string. The scan owns
 * exactly that.
 *
 * ## The honest limitation
 *
 * This asserts a stage is *referenced*, not that it *fires on the right path*. A
 * stage referenced inside an `if (false)` would pass. That is checked by the unit
 * tests that assert the call site's behaviour, not here — and it is stated rather
 * than hidden, because a gate that claimed more than it checked would be the
 * exact failure this file exists to prevent.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const DECLARATION_SRC = "src/shared/analytics-events.ts";
const EVENT_KEY = "FUNNEL_EVENTS";

/**
 * Every source file under `src/`, excluding the declaration itself.
 *
 * **Paths are normalised to forward slashes.** The literal comparison against
 * `DECLARATION_SRC` is the whole point of the filter: a stage declared and not
 * wired must not count its own declaration as a call site. On Windows `join`
 * produces backslashes, so the first version of this comparison silently failed,
 * the declaration file was included in the scan, and `signup` was reported as
 * wired — by its own declaration. **The gate passed on the exact defect it exists
 * to catch**, and the only reason it surfaced is that the count read wrong.
 */
function sourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name).split(sep).join("/");
    if (entry.isDirectory()) {
      out.push(...sourceFiles(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

function fail(headline, detail) {
  console.error(`${headline}\n  ${detail}`);
  process.exit(1);
}

/** The declared stages, parsed out of the declaration. */
export function declaredStages() {
  const text = read(DECLARATION_SRC);
  const start = text.indexOf(`${EVENT_KEY} = {`);
  if (start === -1) return [];
  const end = text.indexOf("} as const", start);
  if (end === -1) return [];
  const body = text.slice(start, end);
  return [...body.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => ({
    key: m[1],
    value: m[2],
  }));
}

/**
 * Every stage, with the files that reference it outside the declaration.
 *
 * ## What counts as a reference
 *
 * A call site writes `captureClientEvent(FUNNEL_EVENTS.signup, ...)`, so what to
 * look for is `FUNNEL_EVENTS.<key>`. A file that hardcodes the *value* string
 * instead is a second source for the same name, which is exactly the drift this
 * file exists for — so both are matched, and the literal case is recorded
 * distinctly so the report can name it.
 *
 * **A file that merely defines the key is not a call site** — see the note on
 * `sourceFiles` for what happened when that got wrong.
 */
export function funnelCoverage() {
  const stages = declaredStages();
  // **Test files are excluded, and not excluding them was a real failure.**
  //
  // A test that references `FUNNEL_EVENTS.signup` is a test of the recorder, not
  // a call site. The first version of this scan counted `analytics-events.test.ts`
  // as where the signup stage fires, so a production path that lost the event
  // would have reported it as wired — by the test asserting it was wired. The
  // declaration is excluded for the same reason: a declaration is not a call.
  const files = sourceFiles("src").filter(
    (f) =>
      f !== DECLARATION_SRC &&
      !f.includes(".test.ts") &&
      !f.includes(".test.tsx"),
  );

  const coverage = {};
  for (const { value } of stages) coverage[value] = [];

  for (const file of files) {
    const fileText = read(file);
    for (const { key, value } of stages) {
      // A `FUNNEL_EVENTS.<key>` reference anywhere in the file. The import is
      // not required separately: a file referencing the object has to import it
      // to compile, so one pattern covers both the import and the call.
      const viaKey = new RegExp(`${EVENT_KEY}\\.${key}\\b`);
      if (viaKey.test(fileText)) {
        coverage[value].push({ file, via: "declaration" });
        continue;
      }
      const viaValue = new RegExp(`["']${value}["']`);
      if (viaValue.test(fileText))
        coverage[value].push({ file, via: "literal" });
    }
  }
  return coverage;
}

function main() {
  const coverage = funnelCoverage();
  const events = Object.keys(coverage);
  const unwired = events.filter((event) => coverage[event].length === 0);
  const viaLiteral = events.filter((event) =>
    coverage[event].some((entry) => entry.via === "literal"),
  );

  if (events.length < 4) {
    fail(
      "this gate found nothing to check",
      `${events.length} stages found — a parser that matches nothing reports clean forever, which is the failure this gate is named after`,
    );
  }

  if (unwired.length > 0) {
    console.error(`unwired funnel stages (${unwired.length}):`);
    for (const event of unwired) console.error(`  - ${event}`);
    console.error(
      "\nA stage that fires nowhere is a funnel with a hole in it. Wire it, or\n" +
        "record why it has no seam yet — an unwired stage that is honest about\n" +
        "being unwired is worth more than one that silently reports zero.",
    );
    process.exit(1);
  }

  console.log(`conversion funnel — ${events.length} stages, all wired`);
  for (const event of events) {
    const where = coverage[event]
      .map(
        (entry) =>
          `${entry.file}${entry.via === "literal" ? " (literal)" : ""}`,
      )
      .join(", ");
    console.log(`  ${event.padEnd(32)} ${where}`);
  }

  // A literal is not a failure — it is a stage that fired without going through
  // the declaration, so it is where a typo would hide. Reported, not gated,
  // because a gate on it would either be ignored or would fail on a deliberate
  // choice whose reason the gate cannot see.
  if (viaLiteral.length > 0) {
    console.log(
      `\nnote: ${viaLiteral.length} stage(s) fired from a hardcoded string rather than the declaration:`,
    );
    for (const event of viaLiteral) console.log(`  - ${event}`);
  }
}

/**
 * True when this file is the process entry point.
 *
 * Without this the detectors could not be imported at all: the gate's own exit
 * would run on import and kill whatever imported it, which is how the suite would
 * end up with a check nobody can test.
 *
 * **Compared as basenames, on purpose.** A previous version compared full paths
 * and silently never matched, so `main()` never ran and the gate exited 0 with no
 * output — a clean-looking pass from a gate that had not checked anything. The
 * basename is enough to answer the question and has no separator ordering to get
 * wrong.
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return (
    entry.split(sep).join("/").split("/").pop() === "check-analytics-funnel.mjs"
  );
})();

if (isMain) main();
