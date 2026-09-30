import {
  forecastVisibility,
  type VisibilityObservation,
} from "./visibilityForecast";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { AiMentionHistoryRepository } from "@/server/features/geo/repositories/AiMentionHistoryRepository";
import { normaliseDomain } from "@/server/features/geo/domain";
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";
import { AppError } from "@/server/lib/errors";

/**
 * Reading the forecast's inputs out of the archive.
 *
 * ## The problem: the archive has a numerator and no denominator
 *
 * `visibilityForecast` is a **proportion**, and a proportion needs two numbers.
 * The archive stores the numerator comfortably — `ai_mention_history.mentions`
 * per month — and the denominator barely at all.
 *
 * There is no table of *how many prompts were asked*. The patrol knows, because it
 * iterates a prompt set, and it writes the answers, but it does not record the
 * count it intended. So for a historical period we can recover the mentions and
 * **cannot recover the sample**.
 *
 * The tempting move is to infer the denominator: count the distinct prompts in
 * the answer archive, or divide mentions by something nearby. Both are wrong in
 * the same direction, and the direction is the dangerous one — they **inflate the
 * sample**, which narrows the band, which makes a weakly-measured month look
 * like a well-measured one. That is the exact inversion this whole feature
 * exists to prevent.
 *
 * So this returns observations with `promptsAsked: null` for every historical
 * period, and the forecast renders a **refusal** rather than a number with a
 * fabricated denominator. The sample size is the headline; inventing it would
 * delete the headline.
 *
 * ## What would fix it
 *
 * One column on the patrol's run row: the number of prompts it asked. That is a
 * small change with a large effect on this feature's honesty, and it is worth
 * more than any amount of modelling on top of a missing denominator.
 */
/**
 * One stored month, with the denominator explicitly absent.
 *
 * A separate type rather than an intersection, because `VisibilityObservation`
 * declares `promptsAsked: number` and intersecting it with `number | null`
 * produced `never`: a type that accepted the value we were about to store and
 * rejected it at the same time. The compiler caught the contradiction; the
 * interesting part is that a type this narrow would have pushed the missing
 * denominator into a cast.
 */
type StoredObservation = Omit<VisibilityObservation, "promptsAsked"> & {
  promptsAsked: number | null;
};

export type ForecastInput = {
  domain: string;
  platform: GeoPlatform;
  /** Oldest first. Every entry's `promptsAsked` is null, and why. */
  observations: StoredObservation[];
  /** The sentence explaining the missing denominator. */
  denominatorNote: string;
};

const MISSING_DENOMINATOR =
  "We record how often a brand was mentioned but not how many prompts we asked " +
  "in that period, so the share of prompts cannot be computed for past runs. " +
  "A number computed from an assumed sample size would look measured and be " +
  "guessed, so we do not show one.";

export async function readForecastInput(input: {
  projectId: string;
  domain: string;
  platform: GeoPlatform;
  limit?: number;
}): Promise<ForecastInput> {
  const domain = normaliseDomain(input.domain);
  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    domain,
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no visibility history.`,
    );
  }

  const rows = await AiMentionHistoryRepository.listSeries({
    projectId: input.projectId,
    targetId: target.id,
    platform: input.platform,
    locationCode: target.locationCode,
    languageCode: target.languageCode,
    limit: input.limit ?? 24,
  });

  return {
    domain: target.domain,
    platform: input.platform,
    observations: rows.map((row) => ({
      platform: input.platform,
      // `YYYY-MM` widened to the month's first day, so the forecast's week
      // bucketing has an ISO date to work with. A month is not a week and is
      // never counted as one.
      date: `${row.month}-01`,
      promptsAsked: null,
      // `mentions` is the numerator and it is real; the denominator is not
      // available, and `promptsAsked: null` is what stops the caller computing
      // a rate from it.
      mentions: row.mentions ?? 0,
    })),
    denominatorNote: MISSING_DENOMINATOR,
  };
}

/**
 * The forecast for a stored series, or the reason there is not one.
 *
 * Returns the refusal **with** the series rather than as an error, because "we
 * have mentions for six months and cannot turn them into a share" is a useful
 * thing for a dashboard to say, and an exception would leave the panel blank with
 * no explanation.
 */
export async function forecastForStoredSeries(input: {
  projectId: string;
  domain: string;
  platform: GeoPlatform;
}) {
  const series = await readForecastInput(input);

  // Every stored observation carries a **null denominator**, so there is nothing
  // here to forecast from, and the forecast is asked about an **empty** list
  // rather than about rows it cannot use.
  //
  // That is deliberate, and it is the only honest option. Passing the rows
  // through would mean either a type cast to satisfy the compiler, or a
  // denominator guessed from a neighbouring column. Both invent the number this
  // feature exists to protect: the *sample size*, which is what makes a share
  // readable at all.
  //
  // So the answer today is the series and the reason. The day the patrol records
  // how many prompts it asked, `promptsAsked` stops being null and this returns
  // numbers with no change here.
  const usable = series.observations.filter(
    (o): o is VisibilityObservation => o.promptsAsked !== null,
  );
  const forecast = forecastVisibility(usable);
  return { series, forecast, note: series.denominatorNote };
}
