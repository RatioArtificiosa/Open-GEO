import { z } from "zod";
import { createDataforseoBillingClassifier } from "@/server/lib/dataforseoBillingClassification";
import { AppError } from "@/server/lib/errors";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";

/**
 * Google AI Mode SERP — the answer-change monitor (G6).
 *
 * The valuable output is not a ranking, it is the **diff between runs**: "Google
 * changed its mind about you" is a sentence no dashboard produces on its own.
 * Store the answer text and its references verbatim; a paraphrase destroys the
 * only thing this endpoint exists to show.
 *
 * Cost: $0.004 per live/advanced call (verified against the vendor example
 * response, 2026-02-24). The research table's $0.0012 figure is the plain `live`
 * variant, not this one.
 *
 * SCOPE LIMIT, and the reason this is a SERP endpoint rather than an AI
 * Optimization one: for Google AI Overviews we get **citations only**. DataForSEO
 * does not return what Google *retrieved*, so the "retrieved but not cited" gap
 * is available for ChatGPT records only. Never imply otherwise.
 */

const PATH = "/v3/serp/google/ai_mode/live/advanced";

const classifyAiModeError = createDataforseoBillingClassifier({
  pathPrefix: "/serp/",
  billingIssueCode: "AI_SEARCH_BILLING_ISSUE",
  billingIssueMessage:
    "The connected DataForSEO account has a billing or balance issue",
});

/** A source Google used to compose the answer. */
const referenceSchema = z
  .object({
    type: z.string().nullish(),
    source: z.string().nullish(),
    domain: z.string().nullish(),
    url: z.string().nullish(),
    title: z.string().nullish(),
    text: z.string().nullish(),
  })
  .passthrough();

/**
 * AI Mode wraps several element types: prose answers, comparison tables,
 * shopping carousels and follow-up "expanded" sections. We keep the type and
 * the markdown, and treat references as optional everywhere — the vendor
 * returns `null` for links/images/references on most element types.
 */
const elementSchema = z
  .object({
    type: z.string(),
    position: z.string().nullish(),
    title: z.string().nullish(),
    text: z.string().nullish(),
    markdown: z.string().nullish(),
    references: z.array(referenceSchema).nullish(),
  })
  .passthrough();

const resultSchema = z
  .object({
    keyword: z.string().nullish(),
    type: z.string().nullish(),
    se_domain: z.string().nullish(),
    location_code: z.number().nullish(),
    language_code: z.string().nullish(),
    check_url: z.string().nullish(),
    datetime: z.string().nullish(),
    item_types: z.array(z.string()).nullish(),
    items_count: z.number().nullish(),
    items: z.array(elementSchema).nullish(),
  })
  .passthrough();

// Module-private: nothing outside this file names these yet. Export when a
// caller needs the shape (the diff/monitor layer will) — knip enforces that an
// unused export is not a lie about the API surface.
type AiModeReference = z.infer<typeof referenceSchema>;
type AiModeElement = z.infer<typeof elementSchema>;

type AiModeAnswer = {
  keyword: string | null;
  locationCode: number | null;
  languageCode: string | null;
  /** When Google rendered the answer, UTC. Store it: the diff is time-ordered. */
  datetime: string | null;
  /** Reproducible link to the exact SERP we were shown. */
  checkUrl: string | null;
  elementTypes: string[];
  elements: AiModeElement[];
  /**
   * Every reference across all elements, de-duplicated by URL, in first-seen
   * order. This is the citation set — the thing a brand actually cares about.
   */
  references: AiModeReference[];
};

type AiModeQueryInput = {
  keyword: string;
  /**
   * Optional in the type because AI Mode is not available in every country, so
   * an unset market is a real caller state that the guard below turns into a
   * clear message instead of a billed rejection.
   */
  locationCode?: number;
  languageCode?: string;
  device?: "desktop" | "mobile";
  tag?: string;
};

/** Documented limit; longer keywords are a billed rejection. */
const MAX_KEYWORD_CHARS = 700;

function collectReferences(elements: AiModeElement[]): AiModeReference[] {
  const seen = new Set<string>();
  const out: AiModeReference[] = [];
  for (const element of elements) {
    for (const ref of element.references ?? []) {
      // A reference with no URL cannot be de-duplicated or cited back to the
      // user, but it is still evidence, so keep it once.
      const key = ref.url ?? `title:${ref.title ?? ref.domain ?? "unknown"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

export async function fetchAiModeAnswer(
  input: AiModeQueryInput,
): Promise<DataforseoApiResponse<AiModeAnswer>> {
  const keyword = input.keyword.trim();
  if (keyword.length === 0) {
    throw new AppError("VALIDATION_ERROR", "keyword is required");
  }
  if (keyword.length > MAX_KEYWORD_CHARS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `AI Mode keyword is limited to ${MAX_KEYWORD_CHARS} characters; received ${keyword.length}.`,
    );
  }
  if (!input.locationCode || !input.languageCode) {
    throw new AppError(
      "VALIDATION_ERROR",
      "AI Mode requires both a location and a language. AI Mode is not available in every country — check Google's AI Mode availability list before setting a market.",
    );
  }

  // Live SERP accepts exactly ONE task per request.
  const response = await dataforseoPost(
    PATH,
    [
      {
        keyword,
        location_code: input.locationCode,
        language_code: input.languageCode,
        ...(input.device ? { device: input.device } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
      },
    ],
    { classify: classifyAiModeError },
  );

  const task = assertOk(response, {
    classify: classifyAiModeError,
    classifyPath: PATH,
  });

  const raw = resultSchema.safeParse(task.result?.[0]);
  if (!raw.success) {
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "DataForSEO returned an unexpected AI Mode payload",
    );
  }

  const data = raw.data;
  const elements = data.items ?? [];
  return {
    data: {
      keyword: data.keyword ?? keyword,
      locationCode: data.location_code ?? input.locationCode,
      languageCode: data.language_code ?? input.languageCode,
      datetime: data.datetime ?? null,
      checkUrl: data.check_url ?? null,
      elementTypes: data.item_types ?? [],
      elements,
      references: collectReferences(elements),
    },
    billing: buildTaskBilling(task),
  };
}
