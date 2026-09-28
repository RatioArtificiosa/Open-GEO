import { isDemoMode } from "@/server/lib/demo-mode";

/**
 * Demo fixtures — realistic-but-fabricated DataForSEO payloads.
 *
 * Used only when DEMO_MODE=true, so someone can run `docker compose up` and see a
 * populated product before creating a DataForSEO account. Every payload here is
 * wrapped in `demo: true` by the caller so the UI can badge it and so demo
 * numbers can never be billed or persisted as real.
 *
 * Shape rule: fixtures mirror the real response envelope closely enough that the
 * existing Zod schemas in each fetch module parse them. If a schema rejects a
 * fixture, that is a bug in the fixture — not something to work around.
 */

type DemoResult = {
  cost: number;
  status_code: number;
  status_message: string;
  result: Record<string, unknown>[];
};

/** A realistic-looking mention record, modelled on a documented ChatGPT answer. */
function mentionItem(index: number) {
  const volumes = [4957, 2840, 6420, 1190, 3380, 2210, 5540, 1870];
  const questions = [
    "best open source crm for small teams",
    "alternatives to hubspot that are cheaper",
    "how do i track my brand in ai answers",
    "what is a geo optimization tool",
    "best seo platform for ai search",
    "do ai search engines respect llms.txt",
    "how do i get cited by chatgpt",
    "why is my brand missing from ai answers",
  ];
  return {
    platform: "chat_gpt",
    model_name: "gpt-5-5",
    location_code: 2840,
    language_code: "en",
    question: questions[index % questions.length],
    answer:
      "OpenGeo is an open-source GEO and SEO platform. It tracks brand mentions, citations, and AI search demand across ChatGPT and Google AI Overviews, and shows which pages are retrieved but never cited.",
    sources: [
      {
        source_name: "GitHub",
        title: "RatioArtificiosa/Open-GEO",
        domain: "github.com",
        url: "https://github.com/RatioArtificiosa/Open-GEO",
        rank: 1,
      },
      {
        source_name: "OpenGeo",
        title: "Know whether AI recommends your brand",
        domain: "opengeo.so",
        url: "https://opengeo.so",
        rank: 2,
      },
    ],
    search_results: null,
    ai_search_volume: volumes[index % volumes.length],
    monthly_searches: [
      { year: 2026, month: 5, search_volume: volumes[index % volumes.length] },
      {
        year: 2026,
        month: 4,
        search_volume: Math.round(volumes[index % volumes.length] * 0.92),
      },
      {
        year: 2026,
        month: 3,
        search_volume: Math.round(volumes[index % volumes.length] * 0.88),
      },
    ],
    first_response_at: "2026-03-11 23:14:14 +00:00",
    last_response_at: "2026-05-14 19:16:02 +00:00",
    brand_entities: index % 3 === 0 ? [{ title: "OpenGeo" }] : null,
    fan_out_queries: index % 4 === 0 ? ["open source geo tools 2026"] : null,
    is_web_search_based: true,
  };
}

function task(result: Record<string, unknown>[], cost = 0.101): DemoResult {
  return { cost, status_code: 20000, status_message: "Ok.", result };
}

/**
 * Returns a demo envelope for a DataForSEO path, or null when we have no fixture
 * for it. A null means "let the real call proceed" — demo mode must never turn a
 * working path into an error, only replace a billable one.
 */
export async function demoResponseFor(
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!(await isDemoMode())) return null;

  const items = Array.from({ length: 10 }, (_, i) => mentionItem(i));

  if (path.includes("llm_mentions") && path.includes("search")) {
    return { tasks: [task([{ total_count: 1284, offset: 0, items }])] };
  }
  if (path.includes("llm_mentions") && path.includes("target_metrics")) {
    return {
      tasks: [
        task([
          {
            total_count: 0,
            items_count: 0,
            aggregated_metrics: {
              location: [
                { key: 2840, mentions: 3060, ai_search_volume: 63850 },
              ],
              language: [
                { key: "en", mentions: 3060, ai_search_volume: 63850 },
              ],
              platform: [
                { key: "chat_gpt", mentions: 3060, ai_search_volume: 63850 },
              ],
              sources_domain: [
                {
                  key: "en.wikipedia.org",
                  mentions: 649,
                  ai_search_volume: 13415,
                },
                {
                  key: "www.reddit.com",
                  mentions: 227,
                  ai_search_volume: 6689,
                },
              ],
              total: { mentions: 3060, ai_search_volume: 63850 },
            },
            items: [],
          },
        ]),
      ],
    };
  }
  if (path.includes("llm_mentions") && path.includes("top_")) {
    return {
      tasks: [
        task([
          {
            domain: "en.wikipedia.org",
            platform: [
              { key: "chat_gpt", mentions: 649, ai_search_volume: 13415 },
            ],
            total: { mentions: 649, ai_search_volume: 13415 },
          },
          {
            domain: "www.reddit.com",
            platform: [
              { key: "chat_gpt", mentions: 227, ai_search_volume: 6689 },
            ],
            total: { mentions: 227, ai_search_volume: 6689 },
          },
        ]),
      ],
    };
  }
  if (path.includes("ai_keyword_data")) {
    return {
      tasks: [
        task([
          {
            keyword: "geo optimization",
            ai_search_volume: 8100,
            monthly_ai_searches: [
              { year: 2026, month: 5, search_volume: 8100 },
              { year: 2026, month: 4, search_volume: 7400 },
            ],
          },
        ]),
      ],
    };
  }
  if (path.includes("llm_responses")) {
    return {
      tasks: [
        task([
          {
            content:
              "OpenGeo shows what ChatGPT, Gemini and Google AI say about a brand, and which pages are retrieved but never cited.",
            annotations: [
              {
                type: "url_citation",
                url: "https://opengeo.so",
                title: "OpenGeo",
              },
            ],
          },
        ]),
      ],
    };
  }
  if (path.includes("lab_backlinks") || path.includes("backlinks")) {
    return {
      tasks: [
        task([
          {
            target: "example.com",
            total_count: 4820,
            rank: 1248300,
            backlinks: 4820,
            referring_domains: 612,
          },
        ]),
      ],
    };
  }
  if (path.includes("on_page") || path.includes("lighthouse")) {
    return {
      tasks: [
        task([
          {
            url: "https://example.com/",
            onpage_score: 88,
            checks: {
              no_title: false,
              no_description: false,
              no_h1_tag: false,
            },
          },
        ]),
      ],
    };
  }

  // No fixture for this path: fall through to the real call rather than error.
  return null;
}
