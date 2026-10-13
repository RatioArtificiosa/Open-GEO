import { AppError } from "@/server/lib/errors";
import { GeoSetupRepository } from "@/server/features/geo/repositories/GeoSetupRepository";
import { normaliseDomain } from "@/server/features/geo/domain";
import {
  LLM_MENTIONS_HISTORY_FLOOR,
  type TopMentionedKind,
} from "@/server/lib/dataforseo/ai-mentions";
import {
  buildLlmTarget,
  type LlmPlatform,
} from "@/server/lib/dataforseo/shared";
import type { createDataforseoClient } from "@/server/lib/dataforseo/client";
import type { GeoPlatform } from "@/server/features/geo/repositories/GeoSetupRepository";

/**
 * The metered client: the one door to the vendor.
 *
 * Both reads here are billed per request, so both go through
 * `createDataforseoClient`'s `aiSearch` entries. The version before this
 * called the section fetchers directly behind a `customerHasPaidPlan` check —
 * the third instance of the CL-202 bug class, where the platform's vendor
 * account paid for a read no org balance was consulted about.
 * `scripts/check-vendor-imports.mjs` refuses the direct import that caused it.
 */
type MeteredClient = ReturnType<typeof createDataforseoClient>;

/**
 * The two panels that **cannot** be answered from the archive.
 *
 * Everything else on the GEO page is a read: the archive already holds it and
 * repeating a vendor call to redraw a stored number would cost money and risk
 * disagreeing with the copy. These two are different, and the distinction is the
 * whole reason this file exists:
 *
 * - **New and lost mentions** cannot be derived from stored levels. 10 → 12 does
 *   not say which prompt appeared or which one disappeared; only the vendor's
 *   `timeseries_new_lost` knows, because it compared two snapshots we never see.
 *   Deriving a "new" list locally would be inventing evidence.
 * - **Top cited pages** is a current ranking, not a history. The archive stores
 *   *our* citations per answer; this is the vendor's view of the whole corpus,
 *   which is the more useful answer to "what do the models cite about us?" and is
 *   not the same question.
 *
 * Both are therefore **metered**, and both take the market from the target rather
 * than from the caller — the same rule as every other read, and the reason is
 * that a US-only figure handed to a London project is a different measurement
 * wearing the same label.
 */

/** The window a "new and lost" panel can honestly describe. */
export type NewLostRow = {
  date: string;
  newMentions: number | null;
  lostMentions: number | null;
  newAiSearchVolume: number | null;
  lostAiSearchVolume: number | null;
};

export type NewLostSeries = {
  platform: GeoPlatform;
  market: { locationCode: number; languageCode: string };
  rows: NewLostRow[];
  /** Null when the window has no data at all — not zero, which would read as "nothing changed". */
  totals: {
    newMentions: number;
    lostMentions: number;
  } | null;
};

/**
 * Our platform vocabulary is not the vendor's.
 *
 * We call it `google_ai_overview` because that is the surface a customer sees;
 * the API parameter is `google`. Translating here — once — is what stops the two
 * vocabularies leaking into each other, and a `platform: "google_ai_overview"` sent
 * to the vendor is a 40501 on a *billable* request rather than a free typo.
 */
const VENDOR_PLATFORM: Record<GeoPlatform, LlmPlatform> = {
  chat_gpt: "chat_gpt",
  google_ai_overview: "google",
  // Present in our vocabulary, absent from the `llm_mentions` family: Gemini and
  // Perplexity are served by `llm_responses` / `llm_scraper` instead, with
  // different shapes and different costs. `assertPlatform` rejects them, so
  // these entries are unreachable and exist only to keep the record total.
  gemini: "chat_gpt",
  perplexity: "chat_gpt",
};

/** The two platforms that actually have a mentions series. */
const MENTIONS_PLATFORMS: readonly string[] = [
  "chat_gpt",
  "google_ai_overview",
];

function assertPlatform(platform: string): asserts platform is GeoPlatform {
  if (MENTIONS_PLATFORMS.includes(platform)) return;
  throw new AppError(
    "VALIDATION_ERROR",
    `${platform} has no mentions time series. The llm_mentions family serves only chat_gpt and google.`,
  );
}

/** `YYYY-MM-DD`, the format both the endpoint and `date_from`/`date_to` want. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getNewLostSeries(input: {
  client: MeteredClient;
  projectId: string;
  domain: string;
  platform: string;
  /** Defaults to the 90 days before today. */
  from?: string;
  to?: string;
  groupRange?: "day" | "week" | "month";
}): Promise<NewLostSeries> {
  assertPlatform(input.platform);

  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError(
      "NOT_FOUND",
      `${input.domain} is not a monitored target in this project, so it has no mentions history.`,
    );
  }

  // Clamped to the vendor's own floor. Asking for 2024 is not an error, it is a
  // request for data that does not exist, and the vendor's answer would be an
  // empty series indistinguishable from "nothing appeared".
  const today = new Date();
  const to = input.to ?? isoDay(today);
  const floor = LLM_MENTIONS_HISTORY_FLOOR;
  const requestedFrom =
    input.from ?? isoDay(new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000));
  const from = requestedFrom < floor ? floor : requestedFrom;

  const vendorRows = await input.client.aiSearch.newLost({
    target: buildLlmTarget({ type: "domain", value: target.domain }),
    platform: VENDOR_PLATFORM[input.platform],
    // ChatGPT data exists for the US only, and so does this panel for it. The
    // target's market is the source of truth; if it is not the supported one,
    // the vendor returns an empty set that looks exactly like "nothing changed".
    locationCode: target.locationCode,
    languageCode: target.languageCode,
    dateFrom: from,
    dateTo: to,
    groupRange: input.groupRange ?? "week",
  });

  // The client unwraps `.data`, so `vendorRows` is the series itself.
  const newLostRows: NewLostRow[] = vendorRows.map((row) => ({
    date: row.date,
    newMentions: row.new_mentions ?? null,
    lostMentions: row.lost_mentions ?? null,
    newAiSearchVolume: row.new_ai_search_volume ?? null,
    lostAiSearchVolume: row.lost_ai_search_volume ?? null,
  }));

  const newMentions = newLostRows.reduce(
    (sum, row) => sum + (row.newMentions ?? 0),
    0,
  );
  const lostMentions = newLostRows.reduce(
    (sum, row) => sum + (row.lostMentions ?? 0),
    0,
  );

  return {
    platform: input.platform,
    market: {
      locationCode: target.locationCode,
      languageCode: target.languageCode,
    },
    rows: newLostRows,
    // Null rather than zeros when the window returned nothing: "no data" and
    // "nothing appeared and nothing disappeared" are different claims, and only
    // the second is a finding.
    totals: newLostRows.length === 0 ? null : { newMentions, lostMentions },
  };
}

export type TopCitedPage = {
  url: string;
  domain: string | null;
  mentions: number | null;
  aiSearchVolume: number | null;
};

/**
 * The pages the models cite most, per platform.
 *
 * `links_scope: "sources"` — the **cited** set, not the retrieved one. Those are
 * different lists (see `docs/DATAFORSEO_GOTCHAS.md` §6.1), and a page the model
 * fetched and then ignored is not something to tell a customer to optimise.
 */
export async function getTopCitedPages(input: {
  client: MeteredClient;
  projectId: string;
  domain: string;
  platform: string;
  limit?: number;
  kind?: TopMentionedKind;
}): Promise<{ platform: GeoPlatform; pages: TopCitedPage[] }> {
  assertPlatform(input.platform);

  const target = await GeoSetupRepository.getTargetByDomain(
    input.projectId,
    normaliseDomain(input.domain),
  );
  if (!target) {
    throw new AppError("NOT_FOUND", `${input.domain} has no citation data.`);
  }

  const vendorRows = await input.client.aiSearch.topMentioned({
    kind: input.kind ?? "pages",
    target: buildLlmTarget({ type: "domain", value: target.domain }),
    platform: VENDOR_PLATFORM[input.platform],
    locationCode: target.locationCode,
    languageCode: target.languageCode,
    // Stated here rather than left to the client's default, for the same reason
    // `internal_list_limit` is stated: this is a semantic choice, not a
    // preference, and a reader of this file should not have to go looking for it.
    linksScope: "sources",
    limit: input.limit ?? 25,
  });

  const key = input.kind === "domains" ? "domain" : "page";
  return {
    platform: input.platform,
    pages: vendorRows.flatMap((row) => {
      const value = key === "domain" ? row.domain : row.page;
      if (!value) return [];
      return [
        {
          // Raw, exactly as the vendor sent it. Page URLs arrive carrying
          // tracking query strings (`?utm_source=chatgpt.com`); stripping them
          // is a display decision, and storing a rewritten URL would lose the
          // evidence of what was actually cited.
          url: value,
          domain: row.domain ?? null,
          mentions: row.total?.mentions ?? null,
          aiSearchVolume: row.total?.ai_search_volume ?? null,
        },
      ];
    }),
  };
}
