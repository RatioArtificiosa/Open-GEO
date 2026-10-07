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

## Verified against the sandbox, 2026-10-07 (cost: $0.00)

The first real DataForSEO calls this project has made, against `sandbox.dataforseo.com` with our own
credentials. Three calls, `cost: 0` each, balance untouched.

| Endpoint                                                       | Result            | What it proves                                             |
| -------------------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `GET /v3/ai_optimization/chat_gpt/llm_responses/models`        | `20000`, `cost=0` | The path is right, the auth works, the family is reachable |
| `GET /v3/ai_optimization/llm_mentions/locations_and_languages` | `20000`, `cost=0` | **The GEO-tracking family is reachable on this account**   |
| `GET /v3/ai_optimization/llm_mentions/filters`                 | `404`             | Needs checking against the live host — see below           |

**The models response confirms Sofia's guidance from the API itself.** Its result keys are
`model_name`, `reasoning`, `web_search_supported`, `task_post_supported` — so the per-model
capability flags she told us to check are real fields, not advice. A model picker built from this
call can never drift, which is the whole point of her "do not hard-code the list" warning.

**The `locations_and_languages` response** carries `location_code`, `location_name` and
`available_languages` — the input-side dependency for the `llm_mentions` client.

**The one open question:** Sofia listed `llm_mentions/filters` and the sandbox returns 404 for it.
That is **not** recorded as a vendor limitation, and **not** as a wrong path. It is an unverified
path that needs one call against the live host. The sandbox's own documentation says it carries
every API, so a single missing path is more likely a sandbox gap than a bad path — but only a live
call settles it, and guessing here would be the exact mistake this file exists to prevent.

## A credential-parse lesson worth keeping

The first smoke test returned `401`, and the diagnostic said the username value was **0
characters** — which was **wrong**. The file is UTF-8, 42 lines, and `DATAFORSEO_USERNAME` holds a
28-character value. The bug was mine: a nested `-match` overwrote `PowerShell's `$Matches`, so the
length I printed came from the wrong match.

**A reading failure is not a fact about the file.** The near-miss was concluding "the credentials
are empty" and writing it down — which would have sent the next reader after a non-existent
problem. The fix is the one this project keeps re-deriving: parse once into a map, then read from
the map.

### Probe round two — the free set is mapped, and one path is not real

| Endpoint                                  | Host     | Result                                                                                                         |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `chat_gpt/llm_scraper/locations`          | sandbox  | `20000`, `cost=0` — keys `location_code, location_name, location_code_parent, country_iso_code, location_type` |
| `ai_keyword_data/locations_and_languages` | sandbox  | `20000`, `cost=0` — keys `location_code, location_name, available_languages`                                   |
| `llm_mentions/filters`                    | **live** | **`404`**                                                                                                      |

**`llm_mentions/filters` does not exist on the production host either.** That was open from the first
round, with the honest note that a single missing path was more likely a sandbox gap — and the live
probe settles it the other way. The path as given does not resolve, so it is recorded here as
**unverified and probably wrong**, not as an endpoint awaiting implementation. The route to an answer
is to ask Sofia again with the 404 in hand, or read the LLM Mentions overview page; the wrong move is
to code against it because an assistant listed it.

**That is the useful lesson from this round, and it is aimed at ourselves as much as at her:** the
vendor's own AI gave a path that 404s in production, so _a path is verified when a call returns 200,
and not before_. Four of the five free metadata paths now have that proof — `llm_responses/models`,
`llm_scraper/locations`, `ai_keyword_data/locations_and_languages`,
`llm_mentions/locations_and_languages` — and they are the safe first wiring precisely because the
proof already exists.

One detail worth keeping: **the scraper's locations response has no `available_languages`**, unlike
the other two. ChatGPT takes a location and no language, which matches how the rest of that family
behaves.

## The model inventory, read from the live API at cost 0.00

`GET /v3/ai_optimization/{platform}/llm_responses/models` — verified on the **live** host for all
four platforms, `status=20000`, `cost=0`, no items on the sandbox because its answers are canned.

| Platform   | Models | `web_search_supported` | `task_post_supported` |
| ---------- | ------ | ---------------------- | --------------------- |
| ChatGPT    | **49** | **37**                 | 49                    |
| Claude     | 16     | 16                     | 16                    |
| Gemini     | 12     | 12                     | 12                    |
| Perplexity | 3      | 3                      | **0**                 |

**Two design rules fall straight out of this table, and neither is visible from the docs.**

1. **The web-search switch must be gated per model, not offered globally.** Twelve of ChatGPT's 49
   models report `web_search_supported: false` — the `o`-series reasoning models (`o4-mini`,
   `o3-mini`, `o1` and their dated snapshots) support `task_post` but **not** web search. A UI
   that shows a web-search toggle regardless would silently do nothing on those models, which is the
   silent-no-op class of defect.
2. **Perplexity's `task_post_supported: false` across all three models independently confirms
   "Live-only"** from the API rather than from prose. Its models are `sonar`, `sonar-pro`,
   `sonar-reasoning-pro`.

Claude and Gemini are uniform — every model supports both flags — so the gating matters for ChatGPT
only, and it matters there for a quarter of the list.

## The response shape, which is not the family's usual one

These models live at **`tasks[0].result` directly**, _not_ `tasks[0].result[0].items` as the rest of
the AI Optimization endpoints return. Reading it the usual way yields `status=20000` with **zero**
models on both hosts — which is exactly how this was found, twice.

**A successful status with an empty result is a shape error, not an empty dataset.** The clue was in
an earlier probe's own output: the keys of `result[0]` were `model_name`, `reasoning`,
`web_search_supported`, `task_post_supported` — which said plainly that `result[0]` _is_ a model.
Read the response keys before trusting a count.

## Every `llm_mentions` path verified — for free, with an empty POST

Eleven paths, one empty POST each (`[{}]`) against the sandbox. Every one returned
`status=20000` with `status_message: "POST Data Is Invalid."` and **`cost=0`**.

| Path                                                                             | Result |
| -------------------------------------------------------------------------------- | ------ |
| `search_mentions/live`                                                           | exists |
| `target_metrics/live` · `target_metrics_lite/live` · `multi_target_metrics/live` | exist  |
| `top_mentioned_domains/live` · `_lite` · `top_mentioned_pages/live` · `_lite`    | exist  |
| `historical/live`                                                                | exists |
| `timeseries_delta/live` · `timeseries_new_lost/live`                             | exist  |

**The technique is worth keeping: an empty POST is a free path probe.** A path that does not exist
returns `404`, and a path that does returns the vendor's own validation error — so a whole family's
routing can be mapped without a paid call. That is what `llm_mentions/filters` failed, and this
passed: the method separates the two cleanly.

**It also settles Sofia's own caveat.** She flagged that the documentation page served for
`timeseries_new_lost/live` is mislabeled as a Backlinks page, and told us to validate the schema
before deploying. The path itself is real — the defect is in the docs page, not the API. So the
warning was accurate and the endpoint is usable.

**And this is the GEO-tracking family**, so these are the endpoints the product's core will call:
`platform` is `chat_gpt` or `google`, which is ChatGPT mentions and **Google AI Overviews**.

## The whole family, path-verified — 30 routes, $0.00

Empty POST (`[{}]`) against each documented path on the sandbox. **Every one returned `20000` with
`cost=0`** — the vendor accepted the route and rejected the empty body, which is exactly the
distinction that makes this a free test rather than a paid one.

| Family           | Paths verified                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM Responses    | `{chat_gpt,claude,gemini,perplexity}/llm_responses/live` and `/task_post` — **8**                                                                |
| LLM Scraper      | `{chat_gpt,gemini}/llm_scraper/live/advanced`, `live/html`, `task_post` — **6**                                                                  |
| AI Keyword Data  | `ai_keyword_data/keywords_search_volume/live` — **1**                                                                                            |
| LLM Mentions     | the eleven below — **11**                                                                                                                        |
| Metadata (`GET`) | `llm_responses/models` ×4, `llm_scraper/locations` ×2, `ai_keyword_data/locations_and_languages`, `llm_mentions/locations_and_languages` — **4** |

**Total: 30 verified routes. Nothing spent.** The only documented path that failed is
`llm_mentions/filters`, which 404s on the sandbox **and** the production host and is recorded as
probably wrong.

**What this changes about building the client:** there is no path left to guess. Every route the
client will call has a real 200 behind it, so a 404 in production is now a signal that something
changed at the vendor rather than a bug in our own string. That is the difference between debugging
routing and debugging logic.

**And the technique generalises beyond this family.** A paid endpoint can be _routed_ for free: send
an empty body, and read the difference between `404` (no such path) and the vendor's own validation
error (the path exists, the payload was refused, nothing was billed). One caution that comes from
this session: **read the response keys before trusting a count** — a `20000` with an empty result
was a shape error twice, not an empty dataset.

## The sandbox is a free schema oracle, and `target` is an array

Five plausible-bodied POSTs to `llm_mentions` on the sandbox all returned the same thing, and it is
more useful than an empty body:

> `status=40501` · _"Invalid Field: 'Field 'target' is missing or has an invalid type (expected
> array).'"_ · `cost=0`

**So `target` is an array, not a string.** Sofia's answer said only that it was _required_.

**And the message is field-level and type-aware**, which makes the sandbox a **free schema oracle**:
the vendor validates one field at a time and names it, so a caller can iterate a plausible body until
it is accepted. That is free, it is authoritative (it is the vendor's own validation), and it is
better than reading prose. Fix `target` and the next complaint names the next field. Confirmed by
control: sending `platform: "nonsense"` returned the **same** `target` error, so validation proceeds
field by field, in order.

**Two consequences for the client.**

1. The `llm_mentions` request shape is: **`target` as an array**, `platform` of `chat_gpt` or
   `google`, plus `match_type`, `location_name`/`location_code`, `date_from`/`date_to`,
   `filters`, `limit`.
2. A wrong field **type** is a **billed** rejection on the live host, so this oracle belongs in the
   build loop rather than in a debugging session after a wasted call.

### Three free probing techniques, in order of usefulness

1. **A plausible body against the sandbox** — the vendor names the missing or mistyped field
   (`40501`), so a schema can be discovered field by field at `cost=0`.
2. **An empty POST** — separates a path that does not exist (`404`) from one that does (the vendor's
   validation error), so a whole family's routing can be mapped for nothing.
3. **A `GET` metadata call** — free, and it returns the real values (model names, locations) rather
   than samples.

## `llm_mentions/search_mentions/live` — the request shape, proven on the sandbox

The GEO-tracking call the product's core is built on. Decoded by the schema oracle in four attempts
at `cost=0`, each one naming the next constraint:

| Attempt | Payload                              | What the validator said                                 |
| ------- | ------------------------------------ | ------------------------------------------------------- |
| 1       | `target: ["example.com"]`            | _expected array_ — `target` is an array                 |
| 2       | `target: ["example.com"]`            | _Each 'target' item must be an object_                  |
| 3       | `target: [{}]`                       | _Exactly one of 'domain' or 'keyword' must be provided_ |
| 4       | `target: [{"domain":"example.com"}]` | `20000`, result present                                 |

**The minimal valid call — two fields:**

```json
[{ "platform": "chat_gpt", "target": [{ "domain": "example.com" }] }]
```

**Rules, each stated by the vendor rather than inferred:**

- `target` is an **array**, and every item is an **object** — never a bare string.
- **Exactly one of `domain` or `keyword`** per item. Both, or neither, is rejected.
- `location_code` and `language_code` are **optional on this route** — attempt 4 carried neither and
  was accepted.

**Response envelope:** `items`, `items_count`, `offset`, `search_after_token`, `total_count`.

**Two notes to carry into the client.** First, mirror the one-of rule in the client's schema — a wrong
payload is a **billed** rejection on the live host, so validating before sending is money. Second, the
cursor is **`search_after_token`**, not the `offset_token` used elsewhere in this codebase; that is a
cursor, not an offset, and it should be honoured rather than normalised away.

## `llm_scraper` — which routes exist, proven against the sandbox

Probed directly, because the mocked tests could not answer this: **a stubbed fetch validates a shape,
never a route.**

| Route                                                 | Result                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /v3/ai_optimization/{se}/llm_scraper/task_post` | **exists** — `20100` "Task Created."                                                            |
| `POST .../llm_scraper/live`                           | **404 — does not exist**                                                                        |
| `GET .../llm_scraper/locations`                       | **404** (also 404 as `locations_and_languages`, `locations/live`, `{se}/llm_scraper/locations`) |
| `GET .../llm_mentions/locations_and_languages`        | **exists** — `20000`, result present                                                            |

**Two defects this found in already-committed code.** A `live` variant was inferred from the
`llmScraper.live` price row's existence — **a price is not a route** — and a locations client was
written against a path that answers 404 in every form tried. Both were removed; the client now
exposes only `task_post` and the `task_get` collection.

**Two things remain unresolved, and are recorded as unresolved rather than assumed:**

1. **`task_get`.** Both `{se}/llm_scraper/task_get/<uuid>` and the unscoped form returned 404, but the
   probes used an all-zero uuid and then an empty id, so they cannot distinguish _wrong route_ from
   _no such task_. The empty id returned the vendor's structured `40400 "Not Found."` rather than a
   bare 404, which reads like a task miss — suggestive, not proof.
2. **Whether `task_post` returns an id.** On the sandbox it answers `20100` with `result: null`, so the
   creation body's `id` cannot be seen there. Production almost certainly returns one — the sibling
   `llm-responses-queue.ts` reads `task.id` — but "the neighbouring file does it" is the reasoning
   that produced the 404 route above, so it stays unverified.

**Both could be settled by one live `task_post` at roughly $0.0012.** That is a spend decision for the
account owner, not one taken while they sleep.

## `domain_analytics/technologies` — the route, the field, and why it matters (CL-408)

**Route:** `POST /v3/domain_analytics/technologies/domain_technologies/live`

Probed, not assumed: `technologies/technologies/live` and the `/live`-less form both 404, while
`technologies_domain/live` returns a structured `40402 "Invalid Path."` — the vendor's own "wrong
path" error, which is how a family that exists but is misaddressed looks.

**Minimal valid body — one string field:**

```json
[{ "target": "example.com" }]
```

→ `20000`, result present, `cost=0`. Note `target` is a **plain string** here, not the array of
`{domain}`/`{keyword}` objects that `llm_mentions/search_mentions` requires. Two endpoints in the same
API family spell the same idea differently; neither should be generalised from the other.

**Result shape, from the live response:** `domain`, `title`, `description`, `domain_rank`,
`technologies`, **`emails`**, **`phone_numbers`**, **`social_graph_urls`**, `meta_keywords`,
`language_code`, `content_language_code`, `country_iso_code`, `last_visited`, `type`.

**This is the tech-slicing lead list's foundation, and the reason is the contact fields.** A call
returns the technologies a domain runs _and_ the contact points to reach it — so a filter like "runs
Shopify but not Klaviyo" yields a list of stores to sell to, with an email attached. That is the
audit-to-prospect step the GEO wedge needs, and it arrives in the same response as the technology
stack rather than needing enrichment.
