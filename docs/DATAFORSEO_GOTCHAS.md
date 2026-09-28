# DataForSEO Gotchas — the things that silently cost you money

**This is the single most operationally important page in the repo.** It captures the failure modes
DataForSEO's own support AI documented when asked what developers get wrong. Every item here has
either wasted money in production or corrupted a metric for somebody.

Compiled 2026-09-28 from DataForSEO documentation and Help Center guidance.

---

## 1. Ten cross-product rules

### 1.1 Treat every request as billable unless the docs say otherwise

Never infer "free" from: the endpoint being called `/live` · returning no results · the task
failing after submission · using it for testing · the response showing `cost: 0` · receiving a
4xx/5xx _after the request reached DataForSEO_.

**→ In OpenGeo:** never bill-proof on "it returned nothing". Our metering reads the task `cost` field, never the row count.

### 1.2 Live and Standard are not interchangeable

Most Live endpoints accept **exactly one task per request**. Send more and only the first is
processed; the rest error. Conversely Standard `task_post` limits are endpoint-specific.

**Batch limits (verified):**

| Endpoint                                               | Max tasks per POST |
| ------------------------------------------------------ | ------------------ |
| Most `task_post` endpoints                             | **100**            |
| On-Page `task_post`                                    | **100**            |
| Instant Pages · Content Parsing Live · Page Screenshot | **20**             |

### 1.3 Never poll by default for task-based workflows

Submit → **store the task ID immediately** → use `postback_url` / `pingback_url` → make the callback
handler **idempotent**. Poll only for low volume or to recover a missed callback.

### 1.4 Concurrency caps to 30 for database APIs

Applies to **AI Optimization, DataForSEO Labs, On-Page, Backlinks, Content Analysis, DataForSEO
Trends**. The 2,000 requests/minute limit does **not** override the 30-concurrent limit.

**→ In OpenGeo:** `GEO_PATROL_CONCURRENCY=30` is the ceiling. Never raise it.

### 1.5 Validate task status, not just HTTP status

HTTP 200 does not mean the task succeeded. A `task_post` response normally has `result: null`
**because the task was only created — not because it failed.** Check `status_code` per task.

### 1.6 Distinguish `null`, `0`, `[]` and missing

They mean different things and **must never be collapsed into one application value**:

| Value   | Typical meaning                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| `null`  | Not applicable, unavailable, unsupported for this item, or deliberately omitted |
| `0`     | Calculated, and the result is genuinely zero                                    |
| `[]`    | Field exists, no elements                                                       |
| missing | Conditional, version-dependent, or not returned for this result                 |

Examples: `featured_snippet: null` usually means that SERP type was unavailable. `etv: 0` with
`count: 0` means no matching ranking elements. An absent clickstream field means
`include_clickstream_data` was not enabled. **`result: null` on `task_post` means pending.**

**→ In OpenGeo:** our Zod schemas use `.passthrough()` precisely so we can tell these apart, and
we store the raw vendor response alongside derived rows.

### 1.7 Absence of location/language does not always mean "global"

In many Labs endpoints:

- no location + no language → **global**
- location, no language → **all supported languages at that location**
- location + language → one location-language combination

This changes result counts and cost. **Always pass both** for a reproducible market-specific answer.

### 1.8 Resolve canonical identifiers first

Do not trust user-typed spellings, translated names, or a country name where a city is required.
Resolve and store `location_code` / `language_code` from the locations/languages endpoints first.

### 1.9 Preserve the request alongside the response

For every task store: endpoint path · API version · exact request body · task ID · `tag` · post
time · completion time · task cost · status code · raw response · **formula/mode flags**.

This is what makes a metric reproducible after the vendor changes a model. See
[`METHODOLOGY.md`](./METHODOLOGY.md).

### 1.10 Never present estimated metrics as observed business data

`etv` is estimated traffic, not analytics sessions. Search volume is a model, not a count of real
searches. Backlinks come from DataForSEO's own crawled index, not Google. Content Analysis finds
citations in _its_ indexed dataset, not every mention on the web. AI search volume is a modeled
metric, not provider logs. **Label them as estimates in the UI.**

---

## 2. AI Optimization

| Risk                             | What happens                                                                        | Mitigation                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| Multiple tasks on a Live request | Extra tasks rejected or ignored                                                     | Exactly one task per Live call                   |
| 30 concurrent                    | Limit errors                                                                        | Semaphore capped at 30                           |
| LLM Responses latency            | Up to **120 seconds**                                                               | Async job architecture; generous client timeouts |
| Prompt limits                    | `user_prompt` / `system_message` have char caps                                     | Validate before submitting                       |
| Token caps                       | With web search or reasoning, output can **exceed** the nominal `max_output_tokens` | Treat it as a target, not a hard cap             |
| Model drift                      | A basic model name resolves to its latest version                                   | **Store the returned `model_name`**              |
| Web search                       | `annotations` may be absent/null/empty when web search is off or unsupported        | Parse as optional                                |
| Cost layers                      | `money_spent` (provider spend) ≠ task `cost` (what you owe)                         | **Bill on task cost**                            |
| Message chains                   | History has a max item count and per-message limits                                 | Truncate/summarise before sending                |

**Gemini LLM Responses documented limits:** `user_prompt` ≤ **500** chars · `system_message` ≤ **500**
chars · `message_chain` ≤ **10** messages · `max_output_tokens` **1–4096** (with extra rules when
reasoning) · `temperature` 0–2 · `top_p` 0–1.

**`fan_out_queries` is optional.** It appears when the system expands a request into several
searches. **It is not proof that web search happened.**

---

## 3. AI Keyword Data

- ≤ **1,000** keywords per request
- **Requires a location and a language**
- Keywords are lowercased
- A monthly record may legitimately contain `0` — **not automatically an error**

---

## 4. DataForSEO Labs

- **Live only.** 30 concurrent. Mostly one task per request.
- **Database-derived and regularly updated** — repeated identical calls can return different data.
- `count` is a count of ranking elements/keywords/pages. **High count ≠ high traffic.**
- Filtering: filter against the **exact documented path for that endpoint**; prefer **LIKE over regex**
  where both work. Never filter on `etv` when you mean ranking count.
- **Do not assume an undocumented parameter is supported** because another Labs endpoint exposes it.
  (This is exactly our `use_improved_etv` situation — see [`METHODOLOGY.md`](./METHODOLOGY.md).)

---

## 5. On-Page — the most expensive API to misuse

**Expensive switches** (each adds charges and crawl work): `load_resources`, `enable_javascript`,
`enable_browser_rendering`, `calculate_keyword_density`. Use only when needed.

**Core Web Vitals require browser rendering** _and_ the related JS/resource settings. Enabling one and
expecting all browser metrics is a common error.

| Gotcha                  | Detail                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_crawl_pages: 1`    | Disables sitewide checks (canonicalization, HTTPS redirects, 404 behaviour, directory browsing, server signature, WWW redirects). **A one-page crawl is not a site audit.** |
| `start_url`             | The target is treated as the **domain** in the URL, not a page-only audit. Use Instant Pages for one-page data.                                                             |
| Sitemaps                | Crawler follows sitemap order; `click_depth` can be `0` and `max_crawl_depth` is ignored; only sitemap-listed pages are crawled.                                            |
| `enable_xhr`            | Requires `enable_javascript: true`                                                                                                                                          |
| `custom_js`             | ~**700 ms** max execution, **2,000 characters** max                                                                                                                         |
| Browser rendering       | Ignored unless the required rendering/JS settings are also enabled                                                                                                          |
| Anti-bot                | JS-rendered pages can still fail via bot protection, cookies, network, timeouts                                                                                             |
| `accept_language`       | Locale-sensitive sites deny the crawler without it and return broken pages                                                                                                  |
| `allowed_subdomains`    | **Ignored while `allow_subdomains: true`**                                                                                                                                  |
| `robots_txt_merge_mode` | `override` requires supplying `custom_robots_txt`                                                                                                                           |
| `priority_urls`         | Must be from the same domain                                                                                                                                                |
| Task response           | `task_post` returns **task creation, not crawl results** — fetch later or use a callback                                                                                    |

---

## 6. Keywords Data

**Multiple, non-interchangeable search-volume sources:** Google Ads · clickstream · Bing · Trends ·
AI search volume. **Never merge them into one `search_volume` column** without recording the source.

**Keyword normalization** (varies by endpoint): lowercasing · decoding · rejected symbols/emoji ·
minimum length · maximum count. **Clickstream Bulk Search Volume:** max 1,000 keywords, each ≥ **3**
characters, lowercased, some symbols disallowed. Store both the input and returned keyword form —
the returned string is not a safe join key if your input preserved case.

**Historical arrays are not guaranteed to be 12 complete months.** Months may be absent or zero
depending on keyword, location, language and source. **Do not interpolate missing months as zero**
unless that is an explicit business rule.

**Rate limits that differ from the global one:**

- **Google Ads Live: 12 requests/minute.** Use Standard for volume.
- **Google Trends: 250 Live tasks/minute system-wide.** Standard recommended beyond that.

> ⚠️ The legacy **Google AdWords API / Keywords Data v2 is deprecated.** Do not build new
> integrations against it — move to Google Ads.

---

## 7. Backlinks

- **Our index ≠ Google's link graph.** A missing backlink doesn't prove Google doesn't know it; a
  listed one doesn't guarantee Google counts it.
- Never confuse: backlinks vs referring domains vs referring networks · discovered vs followed ·
  link existence vs link equity · page-level vs domain-level targets.
- **Keep target type consistent** across comparisons — page and domain targets are not interchangeable.
- **Live only.** Do not design a `task_post`/`task_get` flow for a Live-only endpoint.
- Filtering is free, but **filter server-side** with documented fields. Pulling thousands of rows
  and filtering locally wastes bandwidth and money.

---

## 8. Content Analysis

- **Coverage is dataset-dependent.** A change in crawl coverage, index freshness, query, filters,
  language, location or date range changes the result even if the real-world count did not.
- **Sentiment is a model classification, not ground truth.** `neutral` ≠ "no opinion"; `positive` ≠
  "a recommendation"; connotations aren't mutually exclusive with other signals. Store the original
  text where possible.
- **Use the right endpoint** — Search (individual citations) · Summary (overview) · Sentiment
  Analysis · Rating Distribution · Phrase Trends · Category Trends. **Do not add across endpoints**
  without confirming they share filters and counting rules.
- `total_count` is the matching dataset count; `items_count` is what this response returned. They
  are not equal.
- **Live only.**

---

## 9. The defensive client

Every OpenGeo DataForSEO call must:

1. Preserve the raw JSON alongside derived rows
2. Use **decimal arithmetic** for money
3. Make webhook handlers **idempotent**
4. Retry **only transient** failures
5. **Never blindly retry** a request that may already have been accepted — log the task ID first
6. Use **endpoint-specific limits**, not one global throttle

---

## See also

- [`METHODOLOGY.md`](./METHODOLOGY.md) — how each OpenGeo metric is computed
- [`DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md) — getting and using your key
- `src/shared/dataforseo-pricing.ts` — the price book, pinned by tests
