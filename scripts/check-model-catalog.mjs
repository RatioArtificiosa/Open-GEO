#!/usr/bin/env node
/**
 * Model-catalog drift (CL-709): the hardcoded model names must match the snapshot,
 * and the snapshot must not quietly age into fiction.
 *
 * ## The risk this is for
 *
 * DataForSEO *bills a task that fails with `Invalid Field: 'model_name'`*. A model
 * name that has left the vendor's catalog is therefore not a validation error that
 * surfaces at build time; it is a nightly job that charges for every failure. The
 * live catalog is read at runtime (`llm-models.ts`), so the ordinary path is safe.
 * What is not covered is the last-resort snapshot and the constants that name a
 * model directly.
 *
 * ## Why a static check rather than a live one
 *
 * A gate that calls the vendor needs the network, the $1 balance, and a provider
 * that is up at the moment the suite runs. All three fail for reasons that have
 * nothing to do with the code, and the standard remedy — skip when offline —
 * converts the gate into one that passes exactly when it matters least.
 *
 * So what is checkable statically is checked statically, and the checkable set
 * turns out to be the pair that can actually drift:
 *
 *   1. **A constant naming a model** must be in the snapshot. If someone renames a
 *      default to a model the snapshot does not carry, the two disagree about what
 *      exists, and nothing in the build would notice.
 *   2. **The snapshot must mention its date and not be too old.** The comment says
 *      "Documented as a snapshot (2026-06-30) precisely so nobody treats it as
 *      current", which only works if something notices when that date becomes long
 *      past.
 *
 * ## What this cannot do, and why it says so
 *
 * It cannot tell you that a model still exists. That needs a live call, and the
 * gate that needs one is CL-712a's live verification, not this. **A gate that
 * claimed the second thing would be a gate nobody should trust.**
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

/**
 * Declared in JSDoc rather than TypeScript, because this file has to be
 * executable as plain ESM — `check-model-catalog.mjs` is run by `node` from
 * `ci:check`, so a `type` alias in it is a syntax error the moment node parses it.
 *
 * The detectors are consumed by `check-model-catalog.test.ts`, which `tsc
 * --noEmit` runs over, so the shape they return has to be declared rather than
 * inferred as `{}` — otherwise the test cannot index the snapshot by a platform
 * slug and typecheck fails on the test file rather than on the gate.
 *
 * **The declaration lives here rather than in the test** because this module is
 * the source of that shape. A copy in the test would be a second declaration that
 * could drift from the one that is actually true.
 *
 * @typedef {Record<string, string[]>} ModelSnapshot
 * @typedef {{ where: string; name: string }} HardcodedModel
 */

const ROOT = process.cwd();
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const MODELS_SRC = "src/server/lib/dataforseo/llm-models.ts";
const PATROL_SRC = "src/server/features/geo/services/GeoPatrol.ts";
const EXPLORER_SRC = "src/server/features/ai-search/services/promptExplorer.ts";

/**
 * The platforms, read from the module rather than written out.
 *
 * A list written here would be a second source for the same fact, and the day a
 * fifth platform ships the gate would keep checking four. The slug literal in
 * `export const LLM_MODEL_SLUGS = [...] as const` is parsed straight out.
 */
/**
 * @returns {string[]}
 */
export function platforms() {
  const text = read(MODELS_SRC);
  const match = /LLM_MODEL_SLUGS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(text);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The snapshot, per platform, parsed out of the documented fallback object. */
/**
 * @returns {ModelSnapshot}
 */
export function snapshot() {
  const text = read(MODELS_SRC);
  const start = text.indexOf("FALLBACK_MODELS");
  if (start === -1) return {};
  const objectStart = text.indexOf("{", start);
  const objectEnd = text.indexOf("\n};", objectStart);
  if (objectEnd === -1) return {};
  const body = text.slice(objectStart, objectEnd);

  const perPlatform = {};
  const blockRe = /(\w+):\s*\[([^\]]*)\]/g;
  let block;
  while ((block = blockRe.exec(body)) !== null) {
    perPlatform[block[1]] = [...block[2].matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
  }
  return perPlatform;
}

/** The snapshot's documented date, parsed out of the comment above it. */
/**
 * @returns {string | null}
 */
export function snapshotDate() {
  const text = read(MODELS_SRC);
  const match = /snapshot\s*\((\d{4}-\d{2}-\d{2})\)/.exec(text);
  return match?.[1] ?? null;
}

/** Every model name a constant in the codebase names directly. */
/**
 * @returns {HardcodedModel[]}
 */
export function hardcodedModels() {
  const found = [];

  const patrol = read(PATROL_SRC);
  const patrolMatch = /QUEUE_DEFAULT_MODEL\s*=\s*"([^"]+)"/.exec(patrol);
  if (patrolMatch)
    found.push({
      where: `${PATROL_SRC} QUEUE_DEFAULT_MODEL`,
      name: patrolMatch[1],
    });

  const explorer = read(EXPLORER_SRC);
  const mapMatch =
    /MODEL_NAMES:\s*Record<\w+,\s*string>\s*=\s*\{([\s\S]*?)\n\}/.exec(
      explorer,
    );
  if (mapMatch) {
    for (const m of mapMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
      found.push({ where: `${EXPLORER_SRC} MODEL_NAMES.${m[1]}`, name: m[2] });
    }
  }
  return found;
}

function fail(headline, detail) {
  console.error(`${headline}\n  ${detail}`);
  process.exit(1);
}

/** Every check, collected so a caller can either report or import them. */
export function collectProblems() {
  const problems = [];
  const slugs = platforms();
  const snap = snapshot();
  const constants = hardcodedModels();

  // --- 1. the snapshot covers every platform, and none is empty --------------
  for (const slug of slugs) {
    const list = snap[slug];
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`${slug} has no models in the FALLBACK snapshot`);
    }
  }

  // --- 2. every hardcoded name is in the snapshot ----------------------------
  const allSnapshotted = new Set(Object.values(snap).flat());
  for (const entry of constants) {
    if (!allSnapshotted.has(entry.name)) {
      problems.push(
        `${entry.where} names "${entry.name}", which is not in the snapshot`,
      );
    }
  }

  // --- 3. the snapshot has a documented date, and it is not ancient ----------
  const date = snapshotDate();
  if (!date) {
    problems.push(
      "the snapshot has no documented date, so nobody can tell how old it is",
    );
  } else {
    const ageDays = (Date.now() - Date.parse(date)) / 86_400_000;
    // 180 days. A snapshot the vendor's catalog has outlived is a snapshot that
    // will hand back a model name that no longer exists, and the whole point of
    // the documented date is that it is checkable.
    if (ageDays > 180) {
      problems.push(
        `the snapshot is dated ${date}, which is ${Math.floor(ageDays)} days old — ` +
          "refresh it against the live catalog before trusting a fallback",
      );
    }
  }

  // --- 4. the dangling reference in the explorer -----------------------------
  const explorer = read(EXPLORER_SRC);
  if (/ACCEPTED_LLM_MODEL_NAMES/.test(explorer)) {
    const aiSource = read("src/server/lib/dataforseo/ai.ts");
    if (!/ACCEPTED_LLM_MODEL_NAMES/.test(aiSource)) {
      problems.push(
        `${EXPLORER_SRC} cites an allow-list symbol in dataforseo/ai.ts, which does not exist`,
      );
    }
  }

  // --- 5. the vacuity guard ---------------------------------------------------
  if (slugs.length === 0 || constants.length === 0) {
    fail(
      "this gate found nothing to check",
      `platforms=${slugs.length} constants=${constants.length} — a parser that matches nothing reports clean forever, which is the failure this gate is named after`,
    );
  }

  return problems;
}

function main() {
  const problems = collectProblems();
  if (problems.length > 0) {
    console.error(`model-catalog drift (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `model catalog — ${platforms().length} platforms, ${hardcodedModels().length} hardcoded name(s) all in the snapshot, snapshot dated ${snapshotDate()}`,
  );
}

/**
 * True when this file is the process entry point.
 *
 * Without this the detectors could not be imported at all: the gate's own exit
 * would run on import and kill whatever imported it, which is how the suite would
 * end up with a check nobody can test.
 */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(import.meta.url.replace("file:///", ""));
})();

if (isMain) main();
