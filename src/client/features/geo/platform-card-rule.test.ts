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
 * summing a platform are different shapes, and only one of them is wrong.**
 *
 * Three versions later the pattern needs the *whole* violation within a few
 * characters: a platform collection, mapped or reduced, into a **demand** field.
 * A wider window re-flagged `shareOfVoice.ts`, which computes a per-platform
 * share — correct, and never a single number.
 */
const PLATFORM_COLLECTION =
  /(perPlatform|byPlatform|platformBuckets|platformSeries|platforms\b|aggregatablePlatforms|filteredPlatforms)/;

/**
 * A demand metric — and only a demand metric.
 *
 * `mentions` is deliberately absent. Both platforms count the same kind of
 * event, so 10 + 5 is a meaningful 15, and a rule that banned it would flag
 * correct code and teach the gate to be wrong. The rule is about **units**, not
 * about arithmetic.
 */
const DEMAND_METRIC = /(ai_?search_?volume|aiSearchVolume|capturedVolume)/i;

/**
 * An explicit combined accessor would be the bug with no computation to hide
 * behind.
 *
 * `totalAiSearchVolume` is *not* listed: it is a field that now carries one
 * platform's figure under an honest label ("ChatGPT demand"), which is the fix
 * rather than the fault.
 */
const COMBINED_ACCESSOR =
  /\b(allPlatforms|combinedVolume|blendedVisibility|mergedVolume|totalDemand)\b/;

/**
 * Where the rule is enforced: **the whole repo.**
 *
 * It was scoped to GEO when first written, because it had just found a real
 * violation in `ai-search` (`brandLookupShaping.ts` summing `aiSearchVolume`
 * across `chat_gpt` and `google`) and a check that fires on a known, unfixed
 * violation next door stops being a gate and becomes background noise. That
 * violation is now fixed (CL-135) with three behavioural tests pinning it, so
 * the scope is back to everything — which is where it belongs, because the
 * mistake is not feature-specific and the next person to write it will not know
 * this file exists.
 */
type Offender = { file: string; line: number; text: string };

/**
 * Any accumulation. A demand metric alone is not a violation.
 *
 * `.map` is in this list because of what the self-test below caught: the bug
 * that was actually shipped was `sumNullable(perPlatform.map(p => p.volume))` —
 * a `map` into a `sum*` helper, with no `reduce` and no `for` anywhere near it.
 * The first version of this pattern looked for `.reduce` and would have missed
 * it. `.map` is here because a map over a platform collection that ends in a
 * demand field *is* the shape; a map that does neither is not flagged, because
 * `PLATFORM_COLLECTION` and `DEMAND_METRIC` must both match too.
 */
const ACCUMULATES = /(\.reduce|\bfor\s*\(|\.map\s*\()/;

/**
 * Does this window sum a demand metric across platforms?
 *
 * Named so the self-tests below exercise *this* function rather than
 * re-implementing its three conditions — a copy of the logic in a test proves
 * nothing about the logic that runs in the scan.
 */
function sumsDemandAcrossPlatforms(window: string): boolean {
  return (
    ACCUMULATES.test(window) &&
    PLATFORM_COLLECTION.test(window) &&
    DEMAND_METRIC.test(window)
  );
}

function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of sourceFiles()) {
    const relative = file.slice(SRC.length + 1).replaceAll("\\", "/");
    const source = code(file);
    const lines = source.split("\n");
    const hasPlatforms = PLATFORM_COLLECTION.test(source);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      // A 6-line window: enough for a wrapped
      //   sumNullable(
      //     aggregatablePlatforms.map((p) => p.aiSearchVolume),
      // and short enough that two unrelated statements cannot join up.
      const window = lines.slice(i, i + 6).join("\n");

      if (COMBINED_ACCESSOR.test(line)) {
        offenders.push({ file: relative, line: i + 1, text: line.trim() });
        continue;
      }
      if (hasPlatforms && sumsDemandAcrossPlatforms(window)) {
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
    expect(sourceFiles().length).toBeGreaterThan(50);
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

  it("would actually catch the bug it was written for", () => {
    // A gate that cannot fail is not a gate. This is the exact statement the
    // CL-132 scan found live in `brandLookupShaping.ts`:
    //
    //   const totalAiSearchVolume = sumNullable(
    //     aggregatablePlatforms.map((p) => p.aiSearchVolume),
    //   );
    //
    // It caught a second gap in its own patterns on the first run —
    // `aggregatablePlatforms` was not in `PLATFORM_COLLECTION` — which is the
    // argument for having this test at all.
    const theBugThatWasShipped = [
      "const totalAiSearchVolume = sumNullable(",
      "  aggregatablePlatforms.map((p) => p.aiSearchVolume),",
      ");",
    ].join("\n");
    expect(sumsDemandAcrossPlatforms(theBugThatWasShipped)).toBe(true);
  });

  it("does not flag a legitimate per-platform grouping", () => {
    // The false positive that the first version produced. `citedSources.ts`
    // buckets rows by platform and caps each bucket — the opposite of the bug, and
    // a gate that flags it is a gate people learn to ignore.
    const grouping = [
      "const byPlatform = new Map<LlmPlatform, typeof rows>();",
      "for (const row of rows) {",
      "  const list = byPlatform.get(row.platform) ?? [];",
      "  list.push(row);",
      "}",
    ].join("\n");
    expect(sumsDemandAcrossPlatforms(grouping)).toBe(false);
  });

  it("does not flag a mention sum, because a mention is a mention", () => {
    // 10 + 5 is 15 and is meaningful across platforms. A rule that banned it
    // would be wrong, and a gate that is wrong is worse than no gate.
    const mentionSum = [
      "const totalMentions = sumNullable(",
      "  aggregatablePlatforms.map((p) => p.mentions),",
      ");",
    ].join("\n");
    expect(sumsDemandAcrossPlatforms(mentionSum)).toBe(false);
  });
});
