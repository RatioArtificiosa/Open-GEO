/**
 * The two per-run rollups, reduced from a run's archived answers.
 *
 * ## Why this is its own module
 *
 * Both writers — `insertTargetMetrics` and `insertCitationDomains` — were exported,
 * tested, and **called by nothing**. So `geo_target_metrics` and
 * `geo_citation_domains` were empty for the whole life of the feature, and every
 * surface built on them was reading zero rows:
 *
 * - the evidence drawer's "What the vendor reported"
 * - `getGeoRun`, which counted as *unmounted* when the missing thing was a *writer*
 * - **the "Earn the citation" panel, which has been drawing an empty chart on every
 *   project since it shipped**
 *
 * Inlining the reduction in `recordRun` pushed that file past oxlint's `max-lines`
 * and buried it four blocks deep inside a `try`. Both reasons point the same way: it
 * is a self-contained concern with its own reasoning, and it is called from exactly
 * one place.
 *
 * ## Why a mention is not a row count
 *
 * `geo_answers` stores a row whether or not the brand was named in it — that is the
 * archive, and an unmentioned answer is a **finding**. Worse, the judgement can be
 * **null**: `mentionFromAnswer` cannot read an answer it has no text for and returns
 * `null` rather than guessing.
 *
 * So counting rows would report a perfect score for a run that archived ten answers
 * and named the brand in none of them. This module calls `mentionFromAnswer` — the
 * same function `visibilityForecastReads` uses — so the rollup and the forecast
 * cannot disagree about whether a run mentioned the brand.
 */
import type { GeoAnswerInsert } from "@/server/features/geo/repositories/GeoAnswerRepository";
import { GeoRunRepository } from "@/server/features/geo/repositories/GeoRunRepository";
import { runBatch } from "@/db/runBatch";
import { mentionFromAnswer } from "./mentionFromAnswer";
import {
  GEO_PLATFORMS,
  isGeoPlatform,
  type GeoPlatform,
} from "@/server/features/geo/repositories/GeoSetupRepository";
import { AppError } from "@/server/lib/errors";

/**
 * Refuse a platform rather than storing a string the column's enum would reject.
 *
 * **`isGeoPlatform` from `GeoSetupRepository`, not a second copy of the list.** The
 * first version of this file declared its own `GeoPlatform` union and cast through it
 * — which oxlint refuses, and rightly: a second list is a list that will drift, and a
 * platform added to `GEO_PLATFORMS` would be rejected here. `GeoService` and
 * `answerDiffReads` already ask that module, so this is the third caller of one
 * predicate rather than the third copy of one list.
 *
 * `AppError` rather than a bare `Error`, so a bad row surfaces as a validation
 * failure where `recordRun`'s catch already knows how to log one.
 */
function requirePlatform(value: string): GeoPlatform {
  if (!isGeoPlatform(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Unknown platform "${value}". Supported: ${GEO_PLATFORMS.join(", ")}.`,
    );
  }
  return value;
}

/**
 * The bare host of a citation URL, or null when there is nothing usable.
 *
 * **Null rather than ""**, because an empty domain would be a row nobody can earn a
 * citation from — and a row keyed on `""` is a bucket every malformed citation lands
 * in together, which reads as one very popular domain.
 *
 * **Module-private**, and knip is right to object when it was not: nothing outside
 * this file resolves a citation's host. Exported "in case", it would be a claim about
 * the API surface that is not true.
 */
function hostOfCitation(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  return host === "" ? null : host;
}

/**
 * Write both rollups for one run.
 *
 * **Called after `insertAnswers`, not beside it**, because this is a reduction over
 * those rows: a rollup computed before the answers exist counts a set that is not
 * there yet.
 *
 * **Both figures are nullable, and both stay null on purpose.**
 * `llm_mentions/search` returns a mention count and no demand figure, so a `0` would
 * claim we looked for demand and found none — a claim about the world rather than
 * about our archive.
 */
export async function writeRunRollups(input: {
  projectId: string;
  snapshotId: string;
  /** Absent when the run measured no target, in which case there is nothing to key on. */
  targetId?: string;
  domain?: string;
  brandName?: string;
  answers: GeoAnswerInsert[];
}): Promise<void> {
  const mentionsByPlatform = new Map<string, number>();
  const domainsByPlatform = new Map<string, number>();

  for (const entry of input.answers) {
    const platform = entry.answer.platform;

    /**
     * **Seed the platform before the verdict, never after it.**
     *
     * The first version only wrote a row when `mentioned === true`, so a run in
     * which the brand was named in *none* of the answers produced **no metrics row
     * at all** — and a missing row reads as "we never collected for this platform"
     * rather than "we collected and found nothing". That is the same
     * absence-versus-zero confusion this feature has refused four times, and it was
     * in the one module whose whole job is producing those numbers.
     *
     * Caught by a test asserting `mentions === 0` and receiving `undefined` — the
     * number was not wrong, the row was missing.
     */
    mentionsByPlatform.set(platform, mentionsByPlatform.get(platform) ?? 0);

    const verdict = mentionFromAnswer({
      // The insert type marks this optional, so an answer row can legitimately
      // arrive without text — which is the `null` verdict, not an error.
      answerText: entry.answer.answerText ?? null,
      source: entry.answer.source,
      // The **target's** domain, not the answer's: an answer row carries the brand
      // measured in it, and a run can hold answers for prompts about anyone.
      domain: input.domain ?? "",
      aliases: input.brandName ? [input.brandName] : [],
    });

    // `null` is neither a mention nor an absence, so it leaves the seeded zero alone.
    if (verdict.mentioned === true) {
      mentionsByPlatform.set(
        platform,
        (mentionsByPlatform.get(platform) ?? 0) + 1,
      );
    }

    /**
     * A domain is counted **once per platform**, however many of that run's answers
     * cited it — because the finding is "how many domains does the AI cite us
     * *from*", and a domain cited in six answers is still one domain to go earn.
     *
     * The composite key carries the platform rather than the domain alone, which is
     * what keeps ChatGPT's and Google's counts from merging into one row.
     */
    for (const citation of entry.citations ?? []) {
      const domain = citation.domain ?? hostOfCitation(citation.url);
      if (domain === null) continue;
      /**
       * **`|` as the separator, not NUL.** NUL is the conventional join character,
       * which is why I reached for it — and it put two NUL bytes into a source file
       * that the repository's own control-character gate caught. A host cannot contain
       * `|`, so the key is unambiguous and **visible in a diff**, which a NUL is not.
       */
      const key = `${platform}|${domain}`;
      domainsByPlatform.set(key, (domainsByPlatform.get(key) ?? 0) + 1);
    }
  }

  const capturedAt = new Date().toISOString();

  const targetId = input.targetId;
  if (targetId !== undefined && mentionsByPlatform.size > 0) {
    await GeoRunRepository.insertTargetMetrics(
      [...mentionsByPlatform.entries()].map(([platform, mentions]) => ({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        targetId,
        snapshotId: input.snapshotId,
        platform: requirePlatform(platform),
        mentions,
        aiSearchVolume: null,
        capturedAt,
      })),
    );
  }

  if (domainsByPlatform.size > 0) {
    /**
     * Through `runBatch`, because `insertCitationDomains` takes a transaction and
     * **returns builders rather than awaiting** — the repository's convention. Calling
     * it directly with `undefined` would compile and then fail at runtime on
     * `tx.insert`, which is the shape of bug a type signature invites.
     *
     * A transaction for both rollups together, so a run's metrics and its citing
     * domains cannot disagree — a metrics row saying "12 mentions" beside a citation
     * list that knows of fewer is worse than neither.
     */
    await runBatch((tx) => [
      ...GeoRunRepository.insertCitationDomains(
        tx,
        [...domainsByPlatform.entries()].map(([key, mentions]) => {
          const [platform, domain] = key.split("|");
          return {
            id: crypto.randomUUID(),
            projectId: input.projectId,
            snapshotId: input.snapshotId,
            platform: requirePlatform(platform ?? ""),
            domain: domain ?? "",
            mentions,
            aiSearchVolume: null,
          };
        }),
      ),
    ]);
  }
}
