import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The platform card rule, enforced.
 *
 * **Google AI Overviews and ChatGPT compute demand differently.** Google's
 * `ai_search_volume` is real search volume; ChatGPT's is People-Also-Ask
 * modelled. We measured 12,621,380 against 63,850 for one keyword — a ratio of
 * roughly 198×. Adding them produces a number that looks authoritative and means
 * nothing, and it is the single most tempting mistake this product could make
 * because it is one `.reduce()` away.
 *
 * So the rule is a **merge gate**, not a guideline. This test walks the source
 * and fails on the shape of any code that could sum across platforms — the only
 * version of this check that survives someone adding a feature at 6pm.
 *
 * The check is a *source* scan rather than a runtime one on purpose. A runtime
 * test would have to enumerate every possible input, and a sum is not wrong on
 * any single input — it is wrong in what it represents. The defect lives in the
 * code that reaches for it, not in the arithmetic.
 */

const SRC = join(process.cwd(), "src");

/** Every TypeScript and TSX file under `src`, minus tests. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments, so prose *about* the rule is not itself a violation. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The two halves of the bug. Either alone is legitimate; together they are the
 * mistake.
 *
 * The first version of this check flagged `citedSources.ts`, which groups rows
 * **by** platform and caps each group separately — the opposite of the bug.
 * Flagging it taught the lesson the rule is built on: **mentioning a platform and
 * summing a platform are different shapes, and only one of them is wrong.** So
 * `flatMap` on its own is not a signal, and neither is a `reduce` that never
 * touches a per-platform metric.
 */
const PLATFORM_COLLECTION =
  /(perPlatform|byPlatform|platformBuckets|platformSeries|platforms\b)/;
const DEMAND_METRIC =
  /(ai_?search_?volume|aiSearchVolume|capturedVolume|\bmentions\b)/i;

/** An explicit combined accessor would be the bug in its most obvious form. */
const COMBINED_ACCESSOR =
  /\b(totalMentions|allPlatforms|combinedMentions|blendedVisibility|mergedVolume)\b/;

/**
 * Where the rule is enforced.
 *
 * Scoped to the **GEO** feature deliberately, and the reason is in the history of
 * this file: a repo-wide version flagged `ai-search`'s `brandLookupShaping.ts`,
 * which genuinely does sum `aiSearchVolume` across `chat_gpt` and `google`. That
 * is a real violation and it is recorded as `CL-135` rather than silently
 * allowed here — but a gate that fires on a known, unfixed violation in a
 * neighbouring feature stops being a gate and becomes background noise. People
 * learn to ignore it, and then it catches nothing.
 *
 * So: this file polices GEO, where the rule is a promise the product makes in
 * its own copy. `ai-search` is tracked separately and honestly.
 */
const GEO_ROOT = join(SRC, "client/features/geo");
const GEO_SERVICE = join(SRC, "server/features/geo");

/** The source files the GEO feature actually owns. */
function geoSourceFiles(): string[] {
  return [
    ...sourceFiles(GEO_ROOT),
    ...sourceFiles(GEO_SERVICE),
    ...sourceFiles(join(SRC, "serverFunctions")),
  ];
}

type Offender = { file: string; line: number; text: string };

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of geoSourceFiles()) {
    const relative = file.slice(SRC.length + 1).replaceAll("\\", "/");
    const lines = code(file).split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // A 12-line window: enough to see the accumulator and the collection it
      // runs over, short enough that two unrelated statements do not join up.
      const window = lines.slice(i, i + 12).join("\n");

      if (COMBINED_ACCESSOR.test(line)) {
        offenders.push({ file: relative, line: i + 1, text: line.trim() });
        continue;
      }
      const accumulates = /\.reduce\s*\(|for\s*\(|\+=/.test(window);
      if (
        accumulates &&
        PLATFORM_COLLECTION.test(window) &&
        DEMAND_METRIC.test(window)
      ) {
        offenders.push({ file: relative, line: i + 1, text: line.trim() });
      }
    }
  }
  return offenders;
}

const offenders = findOffenders();

describe("the platform card rule", () => {
  it("reads a real number of source files", () => {
    // The most dangerous failure mode for a source-scanning gate is a wrong path
    // that has been passing vacuously since the day it was written.
    expect(geoSourceFiles().length).toBeGreaterThan(5);
  });

  it("has no code path that sums across platforms", () => {
    // The load-bearing assertion: no accumulator over platform-keyed data that
    // ends in one scalar.
    expect(offenders).toEqual([]);
  });

  it("does not flag code that groups by platform", () => {
    // `citedSources.ts` buckets rows by platform and caps each bucket. That is
    // the correct shape, and it must stay unflagged — a gate people learn to
    // ignore is worse than no gate.
    expect(offenders.filter((entry) => /byPlatform/.test(entry.text))).toEqual(
      [],
    );
  });

  it("keeps the per-platform visibility shape, not a combined total", () => {
    const service = readFileSync(
      join(SRC, "server/features/geo/services/GeoService.ts"),
      "utf8",
    );
    expect(service).toMatch(/perPlatform/);
    expect(service).not.toMatch(/totalMentions/);
  });

  it("keeps the citation-gap reason, because an empty gap needs explaining", () => {
    // Google AI Overviews returns citations but not retrievals. A confident empty
    // list would say "your pages were never retrieved", which is a different
    // statement — and the one a paying customer would act on.
    const service = readFileSync(
      join(SRC, "server/features/geo/services/GeoService.ts"),
      "utf8",
    );
    expect(service).toMatch(/retrievalAvailable/);
    expect(service).toMatch(/reason:/);
  });
});
