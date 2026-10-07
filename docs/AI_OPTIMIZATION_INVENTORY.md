# AI Optimization — verified endpoint inventory

**Source: Sofia AI (DataForSEO's own assistant), 2026-10-07**, in conversation
`https://chat.dataforseo.com/chat/13caa1e3-3233-444c-93ad-5c67c866267` _(read the full conversation
for sections 3–5, which this file does not yet carry: brand-tracking endpoints, Historical LLM
Mentions detail, and the limits/costs section)._ She grounded the model-list answer by **making a
live API call herself** rather than paraphrasing the docs, which is why this inventory reads as
verified rather than remembered.

**Nothing here was paid for.** No `Request`, no `Copy JSON`; the account balance stayed at $1.00.

## The five families

"Live" means one POST returns the result. "Task-based" means `task_post` then `task_get` /
`tasks_ready` (or a callback). Model/location-list endpoints are `GET`.

### 1. LLM Responses — ChatGPT, Claude, Gemini, Perplexity

| Platform   | Paths                                                                                              | Method        |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------- |
| ChatGPT    | `/v3/ai_optimization/chat_gpt/llm_responses/{models, live, task_post, task_get/{id}, tasks_ready}` | Live + task   |
| Claude     | `/v3/ai_optimization/claude/llm_responses/{…}`                                                     | Live + task   |
| Gemini     | `/v3/ai_optimization/gemini/llm_responses/{…}`                                                     | Live + task   |
| Perplexity | `/v3/ai_optimization/perplexity/llm_responses/{models, live}`                                      | **Live only** |

### 2. LLM Scraper — ChatGPT and Gemini only

`…/{chat_gpt,gemini}/llm_scraper/` with `locations` (and `languages` for Gemini, free GET),
`live/advanced` (structured), `live/html` (raw), `task_post`, `task_get/advanced/{id}`,
`task_get/html/{id}`, `tasks_ready`.

### 3. AI Keyword Data — Live only

`/v3/ai_optimization/ai_keyword_data/locations_and_languages` (free) and
`/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live` — current AI search volume **and**
monthly history.

### 4. LLM Mentions — Live only, and **this is the GEO-tracking family**

Its `platform` values are **`chat_gpt`** and **`google`** — ChatGPT and **Google AI Overviews**,
the two surfaces this product's core is built around:

`/v3/ai_optimization/llm_mentions/` + `locations_and_languages` (free), `filters` (free),
`search_mentions/live`, `target_metrics/live`, `target_metrics_lite/live`,
`multi_target_metrics/live`, `top_mentioned_domains/live` (+`_lite`),
`top_mentioned_pages/live` (+`_lite`), **`historical/live`**, `timeseries_delta/live`,
**`timeseries_new_lost/live`**.

## Three findings worth more than the table

1. **`user_prompt` caps at 500 characters** — a hard limit on the one required field of LLM
   Responses. Any "summarise this page" feature breaks on it in production.
2. **The model list is dynamic — 49 names at the time of asking.** Do not hard-code it. Fetch
   `llm_responses/models` and read each entry's **`web_search_supported`** and
   **`task_post_supported`** before exposing those switches in a UI.
3. **A documentation defect, reported by the vendor's own assistant:** the page currently served
   for `timeseries_new_lost/live` is **mislabeled as a Backlinks page**; she identified the intended
   path from the Help Centre and advised validating the schema against live docs before deploying.

## Free-first plan

Five endpoints are `GET` and cost nothing — they are the right first wiring, because they prove
paths, auth and parsers before any spend: `llm_responses/models`, `llm_scraper/locations`,
`ai_keyword_data/locations_and_languages`, `llm_mentions/locations_and_languages`,
`llm_mentions/filters`. Everything else goes through **`sandbox.dataforseo.com`** first (swap the
hostname; same paths, payloads and auth, `cost: 0`), and the $1 is reserved for what the sandbox
cannot answer: which families the account truly enables, real values, and one real `cost` per
family.

## Also true, from the playground itself

`Message Chain`'s placeholder reveals the request shape —
`[{"role": "user", "message": "Hello"}, …]`. `Function`, `SE` and `Model Name` are **custom
comboboxes, not `<select>`s**, so the model list must come from the free `models` endpoint rather
than scraped from the UI. **Processing time for LLM Responses can reach 120 seconds**, which
exceeds a server function's budget and forces a queued-task shape on any caller.
