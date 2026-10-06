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

**→ In OpenGeo:** the client does **not** read a concurrency env var. `ENDPOINT_LIMITS` in
`src/server/lib/dataforseo/limits.ts` records the vendor ceiling (30) beside a `divisor`, and
`effectiveValue()` divides them — so `/v3/ai_optimization/` runs at **15 permits per isolate**,
deliberately half the vendor ceiling, because running at exactly 30 leaves nothing for the next
request and turns one slow call into a cascade of rejections. **Never raise the `value` above the
vendor's documented number; change the `divisor`, which is where our own headroom lives.**

This line used to read `GEO_PATROL_CONCURRENCY=30` is the ceiling. **Nothing in `src/` ever read
that variable** — it survived the move off a sequential for-loop, and a self-hoster could set it
believing it governed anything. The number a self-hoster needed was in a file that is not an
environment contract, which is exactly why it is recorded here.

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

### 4.1 Bulk traffic estimation — the same key is two different shapes

`bulk_traffic_estimation` and `historical_bulk_traffic_estimation` look like the
same endpoint with a `historical_` prefix. They are not, and the difference is
in the payload.

|                    | `bulk_traffic_estimation`                     | `historical_bulk_traffic_estimation`          |
| ------------------ | --------------------------------------------- | --------------------------------------------- |
| Path               | `.../bulk_traffic_estimation/live`            | `.../historical_bulk_traffic_estimation/live` |
| Targets            | up to 1,000 domains, subdomains, **or pages** | up to 1,000 domains or subdomains             |
| `metrics.organic`  | an **object**: `{ etv, count }`               | an **array** of `{ year, month, etv, count }` |
| `date_from`        | —                                             | `yyyy-mm-dd`, history starts **2020-10-01**   |
| Forward projection | never                                         | never                                         |

```json
// current — organic is an object
{ "organic": { "etv": 217332878.18734226, "count": 11786473 },
  "paid": { "etv": 0, "count": 0 },
  "local_pack": null, "featured_snippet": null }

// historical — organic is an array of months
{ "organic": [ { "year": 2021, "month": 3, "etv": 224412747.905034, "count": 16031288 } ] }
```

A shared parser for the two will type-check and then quietly return garbage.
And `local_pack: null` means _that SERP type was not applicable_ — a different
thing from a metric object whose `etv` and `count` are both zero.

Domains go in **without** `https://` and `www.`; pages must be absolute URLs.
A wrong target here is a silently different domain, not an error.

**Neither endpoint forecasts.** `bulk_traffic_estimation` is a _current_ monthly
estimate; the historical one is history. Forward projection is ours to build.

### 4.2 The ETV formula change — the one that will bite

**Verified 2026-09-28 against the vendor's announcement page, not a summary.**

DataForSEO is replacing the ETV model in Labs. The new one accounts for SERP
features that displace clicks (AI Overviews, featured snippets, paid, local
packs, images, video), varies by search intent, and normalises search volume with
clickstream data. It becomes the **default on 2026-11-01**.

**The parameter is `use_new_etv`.** Not `use_improved_etv` — that name circulates
in support-chat summaries and appears in no documentation page. Sending the wrong
name is a silent no-op, not an error.

| Account registered  | Default before Nov 1    | Default after Nov 1 |
| ------------------- | ----------------------- | ------------------- |
| Before 2026-09-01   | legacy                  | **new**             |
| On/after 2026-09-01 | **new** (no transition) | **new**             |

**Three consequences:**

1. **Historical endpoints are excluded.** The announcement says the new ETV is
   available "in all relevant endpoints where the `etv` field is present, _except
   for the ones returning historical metrics_." So `historical_bulk_traffic_estimation`
   and `historical_rank_overview` keep the legacy formula. **Your historical series
   is legacy and cannot be restated** — the discontinuity is permanent unless the
   vendor backfills.
2. **`estimated_paid_traffic_cost` changes too**, because it derives from organic
   ETV. Code reading it is affected even if it never touches `etv`.
3. **A new account has no legacy baseline at all.** Register after 2026-09-01 and
   every value you ever get is the new formula, so "pre-cutover vs post-cutover"
   is impossible from day one.

**What to do:** store the formula version and request time beside every ETV value
you persist. Never compute a trend across the boundary without labelling it. Do
not send the flag to an endpoint whose schema doesn't list it, and do not assume
it was honoured. See [`METHODOLOGY.md`](./METHODOLOGY.md).

### 4.3 Per-endpoint keyword limits — and the three that are not 1,000 `[V 2026-10-06]`

**Source:** the vendor's own [rules and limitations of `keyword`/`keywords`
fields](https://dataforseo.com/help-center/rules-and-limitations-of-keyword-and-keywords-fields-in-dataforseo-apis),
read in full on 2026-10-06, cross-checked against each endpoint's reference page. The
**count** cap is the one that costs money when missed: the request is rejected **and
billed**. The **character** cap is the one that corrupts a join when it is worked
around by truncation.

| Endpoint                                        | Keywords per call | Per-keyword limit                                |
| ----------------------------------------------- | ----------------- | ------------------------------------------------ |
| Labs `search_intent`                            | **1,000**         | none documented                                  |
| Labs `bulk_keyword_difficulty`                  | **1,000**         | none documented                                  |
| Labs `keyword_ideas`                            | **200**           | none documented                                  |
| Labs `related_keywords` · `keyword_suggestions` | 1 (a `keyword`)   | none documented                                  |
| Labs `historical_search_volume`                 | 700               | **80 chars / 10 words**                          |
| AI Keyword Data `keywords_search_volume`        | 1,000             | **250 chars**                                    |
| Google Ads `search_volume`                      | 1,000             | **80 chars / 10 words**                          |
| Google Ads `keywords_for_keywords`              | **20**            | 80 chars                                         |
| Bing `search_volume`                            | 1,000             | 100 chars                                        |
| Bing `keywords_for_keywords`                    | **200**           | 100 chars                                        |
| Google Trends                                   | **5**             | 100 chars                                        |
| LLM Scraper (ChatGPT · Gemini)                  | 1 (a `keyword`)   | **2,000 chars, and the keyword _is_ the prompt** |

**Four things this table is for:**

1. **`keyword_ideas` is 200, not 1,000.** A batch sized for the _family_ rather than
   for the endpoint is a billed rejection, and the number looks interchangeable.
2. **`search_intent` takes no `location_code` and no `language_code`** — verified
   twice, from the reference and from this article. It is the one Labs endpoint whose
   market is not a parameter, because the classification is multilingual. Sending a
   market "for consistency" is a rejection; _reading_ intent as market-specific is a
   wrong answer about every keyword. In OpenGeo: `search-intent.ts` sends `keywords`
   and `tag` only, and the prompt-set generator caches intent per (project, keyword)
   with no market column.
3. **Keyword length is per-endpoint, and truncating to fit changes the keyword.** Where
   no limit is documented, **refuse and say so** rather than shortening — a shortened
   keyword stops matching the metrics it came from, and the mismatch is silent.
   `ai_keyword_data`'s 250 is the strictest documented length in this family, which is
   why it is the bound `search-intent.ts` refuses at.
4. **The LLM Scraper's `keyword` is the prompt sent to the model**, capped at 2,000
   characters. A different kind of field wearing the same name — and the reason the
   scraper is the endpoint to reach for in a scheduled patrol. Note also that `%##`
   inside a keyword is decoded and `+` becomes a space, so a literal `%` must be sent
   as `%25` and a literal `+` as `%2B`.

---

## 5. On-Page — the most expensive API to misuse

**Expensive switches** (each adds charges and crawl work): `load_resources`, `enable_javascript`,
`enable_browser_rendering`, `calculate_keyword_density`. Use only when needed.

**Core Web Vitals require browser rendering** _and_ the related JS/resource settings. Enabling one and
expecting all browser metrics is a common error.

| Gotcha                  | Detail                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_crawl_pages: 1`    | Disables sitewide checks (canonicalization, HTTPS redirects, 404 behaviour, directory browsing, server signature, WWW redirects). **A one-page crawl is not a site audit** — and it is silently degraded, not an error. See below. |
| `start_url`             | The target is treated as the **domain** in the URL, not a page-only audit. Use Instant Pages for one-page data.                                                                                                                    |
| Sitemaps                | Crawler follows sitemap order; `click_depth` can be `0` and `max_crawl_depth` is ignored; only sitemap-listed pages are crawled.                                                                                                   |
| `enable_xhr`            | Requires `enable_javascript: true`                                                                                                                                                                                                 |
| `custom_js`             | ~**700 ms** max execution, **2,000 characters** max                                                                                                                                                                                |
| Browser rendering       | Ignored unless the required rendering/JS settings are also enabled                                                                                                                                                                 |
| Anti-bot                | JS-rendered pages can still fail via bot protection, cookies, network, timeouts                                                                                                                                                    |
| `accept_language`       | Locale-sensitive sites deny the crawler without it and return broken pages                                                                                                                                                         |
| `allowed_subdomains`    | **Ignored while `allow_subdomains: true`**                                                                                                                                                                                         |
| `robots_txt_merge_mode` | `override` requires supplying `custom_robots_txt`                                                                                                                                                                                  |
| `priority_urls`         | Must be from the same domain                                                                                                                                                                                                       |
| Task response           | `task_post` returns **task creation, not crawl results** — fetch later or use a callback                                                                                                                                           |

### 5.1 `max_crawl_pages: 1` is worse than you think `[V 2026-09-28]`

DataForSEO changed these defaults to cut crawl time, and the rules are **not uniform**:

| You set                                                       | Result                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_crawl_pages: 1`, **no** `start_url`, or a homepage in it | These checks are disabled: `test_canonicalization`, `enable_www_redirect_check`, `test_hidden_server_signature`, `test_page_not_found`, `test_directory_browsing`, `test_https_redirect` |
| `max_crawl_pages: 1` + a **non-homepage** `start_url`         | **All** sitewide checks are disabled                                                                                                                                                     |

**And it can be undone deliberately**: `force_sitewide_checks: true` re-enables
them for a one-page crawl. That matters because both cases above are
indistinguishable in the response — you get a clean result either way, and the
missing checks look like a site with no problems.

**→ In OpenGeo:** if a user asks for a single-page audit we either set
`force_sitewide_checks: true` and say the crawl is heavier, or we return the
result with a note naming the checks that did not run. Silently dropping them is
how a tool reports "no issues" on a site with a www redirect loop.

---

## 6. AI Optimization — LLM Mentions

_Verified 2026-09-28 against the live docs. This is the family that reports what AI systems
actually say about a brand, and it has four traps that each corrupt a headline metric._

### 6.1 `sources` and `search_results` are different sets — and only one is a citation

| Field            | What DataForSEO documents it as                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sources`        | "the sources the model **cited or relied on** in its final answer"                                                        |
| `search_results` | "all web search outputs the model **retrieved** when looking up information, **including duplicates and unused entries**" |

`search_results` is therefore a **superset** of `sources`, and the difference between them is
the retrieved-but-uncited gap.

**The trap:** copying the citation set into your retrieval set. Every retrieved page then matches
a cited page, the gap query returns nothing forever, and the feature looks healthy while
reporting zero findings.

**→ In OpenGeo:** `GeoPatrol` maps `sources → geo_answer_citations` and
`search_results → geo_answer_retrievals`, and never derives one from the other. `search_results`
is **chat_gpt only** (DataForSEO returns `null` for google), which is what `RETRIEVAL_PLATFORMS`
encodes — so for Google the gap is reported as _unavailable_, never as _empty_.

### 6.2 The whole family is Live-only — there is nothing to poll

`llm_mentions` has no `task_get`. The "Live endpoints return `result: null` while the task is
still running" behaviour belongs to the _asynchronous_ DataForSEO products and does **not** apply
here. A `null` or missing result on this family means empty, not pending. If you carry over
pending-task handling from the Labs or SERP clients, you will wait forever for a result that has
already arrived.

### 6.3 `search/live` is Legacy; use `search_mentions/live`

DataForSEO marks the older path **"(Legacy)"** and states the current one "will continue to be
supported for the foreseeable future (no deprecation date is set), but all new integrations must
use the new path." The two are otherwise identical. Because the OpenGeo patrol runs from a
nightly cron, a hard-coded legacy URL is a future 404 that would only surface as "this customer's
archive stopped filling", with no error in the app.

### 6.4 ChatGPT data is US/en only, and the defaults hide it

`location_code` defaults to **2840** and `language_code` to **en** — the _only_ market with ChatGPT
coverage. A request that omits both looks valid and silently returns US data. Any other market
returns an empty set that is **indistinguishable from "not mentioned"**, so substituting 2840
without recording the substitution would quietly measure the wrong region.

**→ In OpenGeo:** the patrol substitutes the supported market and writes the substitution into
the run notes, so a customer asking "why does my Berlin project look identical to my New York
one?" gets a real answer.

---

## 7. Keywords Data

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

## 8. Backlinks

- **Our index ≠ Google's link graph.** A missing backlink doesn't prove Google doesn't know it; a
  listed one doesn't guarantee Google counts it.
- Never confuse: backlinks vs referring domains vs referring networks · discovered vs followed ·
  link existence vs link equity · page-level vs domain-level targets.
- **Keep target type consistent** across comparisons — page and domain targets are not interchangeable.
- **Live only.** Do not design a `task_post`/`task_get` flow for a Live-only endpoint.
- Filtering is free, but **filter server-side** with documented fields. Pulling thousands of rows
  and filtering locally wastes bandwidth and money.

---

## 9. Content Analysis

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

## 10. The defensive client

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
