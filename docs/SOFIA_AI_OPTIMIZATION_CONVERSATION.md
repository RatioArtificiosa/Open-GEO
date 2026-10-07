# Sofia AI (DataForSEO) ? AI Optimization conversation, verbatim

Captured 2026-10-07 from https://chat.dataforseo.com/chat/13caa1e3-3233-444c-93ad-5dc67c866267

Source: DataForSEO's own assistant. Cost: $0.00. Kept verbatim because sections 3-5
(brand-mention tracking, Historical LLM Mentions detail, limits and costs) are the parts the
inventory file summarises least. Treat every path here as needing the 200-check the inventory
describes: one path she listed, llm_mentions/filters, 404s on both hosts.

```text
Sofia AI Assistant
Today
DataForSEO AI APIs
More
Last 30 days
Content API Access
More
ETV Formula & Trends
More
Benchmarks & Trends
More
Forecast Endpoints
More
DataForSEO API Rules
More
AI API Pricing Guide
More
AI API Pricing Guide
More
DataForSEO
API Documentation
Pricing
Theme
Private

I am building a self-hosted SEO/GEO product on DataForSEO. Be precise and complete: (1) List EVERY endpoint in the AI Optimization API family with exact paths and whether live or task-based. (2) For ChatGPT LLM Responses give the exact model names and request fields. (3) Which endpoints track whether a brand is mentioned or cited in ChatGPT answers and Google AI Overviews over time? (4) What are the Historical LLM Mentions API paths and what do they do? (5) Limits, required fields or costs I would get wrong before coding.

I’ll verify the current DataForSEO documentation for the AI Optimization API, LLM Responses, historical mentions, tracking, limits, and pricing before answering.

Searching relevant content...

Reading from database...

Searching relevant content...

Searching relevant content...

Reading from database...

Searching relevant content...

Reading from database...

Reading from database...

Making DataForSEO API call...

Making DataForSEO API call...

Below is a coding-oriented inventory based on the current DataForSEO documentation and the live ChatGPT model-list response retrieved from the API.

Sources: AI Optimization overview, LLM Mentions overview, ChatGPT LLM Responses.

1. AI Optimization API endpoints

“Live” means one POST request returns the result. “Task-based” means task_post followed by task_get, tasks_ready, or a callback. Model/location-list endpoints are GET.

A. LLM Responses

Supported platforms include ChatGPT, Claude, Gemini, and Perplexity. ChatGPT and Claude support both Live and Standard methods; Perplexity is Live-only. Gemini supports Live and Standard methods according to its overview.

ChatGPT
Method	Exact path	Type
GET	/v3/ai_optimization/chat_gpt/llm_responses/models	Free metadata
POST	/v3/ai_optimization/chat_gpt/llm_responses/live	Live
POST	/v3/ai_optimization/chat_gpt/llm_responses/task_post	Task-based
GET	/v3/ai_optimization/chat_gpt/llm_responses/task_get/{id}	Task result
GET	/v3/ai_optimization/chat_gpt/llm_responses/tasks_ready	Completed-task queue
Claude
Method	Exact path	Type
GET	/v3/ai_optimization/claude/llm_responses/models	Free metadata
POST	/v3/ai_optimization/claude/llm_responses/live	Live
POST	/v3/ai_optimization/claude/llm_responses/task_post	Task-based
GET	/v3/ai_optimization/claude/llm_responses/task_get/{id}	Task result
GET	/v3/ai_optimization/claude/llm_responses/tasks_ready	Completed-task queue
Gemini
Method	Exact path	Type
GET	/v3/ai_optimization/gemini/llm_responses/models	Free metadata
POST	/v3/ai_optimization/gemini/llm_responses/live	Live
POST	/v3/ai_optimization/gemini/llm_responses/task_post	Task-based
GET	/v3/ai_optimization/gemini/llm_responses/task_get/{id}	Task result
GET	/v3/ai_optimization/gemini/llm_responses/tasks_ready	Completed-task queue
Perplexity
Method	Exact path	Type
GET	/v3/ai_optimization/perplexity/llm_responses/models	Free metadata
POST	/v3/ai_optimization/perplexity/llm_responses/live	Live

Perplexity LLM Responses currently supports Live retrieval only.

B. LLM Scraper

The documentation currently exposes ChatGPT and Gemini LLM Scraper families.

ChatGPT LLM Scraper
Method	Exact path	Type
GET	/v3/ai_optimization/chat_gpt/llm_scraper/locations	Free metadata
POST	/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced	Live
POST	/v3/ai_optimization/chat_gpt/llm_scraper/live/html	Live
POST	/v3/ai_optimization/chat_gpt/llm_scraper/task_post	Task-based
GET	/v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/{id}	Task result
GET	/v3/ai_optimization/chat_gpt/llm_scraper/task_get/html/{id}	Task result
GET	/v3/ai_optimization/chat_gpt/llm_scraper/tasks_ready	Completed-task queue

advanced returns structured ChatGPT Search data. html returns raw HTML.

Gemini LLM Scraper
Method	Exact path	Type
GET	/v3/ai_optimization/gemini/llm_scraper/locations	Free metadata
GET	/v3/ai_optimization/gemini/llm_scraper/languages	Free metadata
POST	/v3/ai_optimization/gemini/llm_scraper/live/advanced	Live
POST	/v3/ai_optimization/gemini/llm_scraper/live/html	Live
POST	/v3/ai_optimization/gemini/llm_scraper/task_post	Task-based
GET	/v3/ai_optimization/gemini/llm_scraper/task_get/advanced/{id}	Task result
GET	/v3/ai_optimization/gemini/llm_scraper/task_get/html/{id}	Task result
GET	/v3/ai_optimization/gemini/llm_scraper/tasks_ready	Completed-task queue
C. AI Keyword Data

AI Keyword Data supports Live retrieval only.

Method	Exact path	Type
GET	/v3/ai_optimization/ai_keyword_data/locations_and_languages	Free metadata
POST	/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live	Live

The search-volume endpoint returns current AI search volume and monthly AI search-volume history.

D. LLM Mentions

LLM Mentions supports Live retrieval only. The platform values are:

chat_gpt — ChatGPT
google — Google AI Overviews
Method	Exact path	Type
GET	/v3/ai_optimization/llm_mentions/locations_and_languages	Free metadata
GET	/v3/ai_optimization/llm_mentions/filters	Free metadata
POST	/v3/ai_optimization/llm_mentions/search_mentions/live	Live
POST	/v3/ai_optimization/llm_mentions/target_metrics/live	Live
POST	/v3/ai_optimization/llm_mentions/target_metrics_lite/live	Live
POST	/v3/ai_optimization/llm_mentions/multi_target_metrics/live	Live
POST	/v3/ai_optimization/llm_mentions/top_mentioned_domains/live	Live
POST	/v3/ai_optimization/llm_mentions/top_mentioned_domains_lite/live	Live
POST	/v3/ai_optimization/llm_mentions/top_mentioned_pages/live	Live
POST	/v3/ai_optimization/llm_mentions/top_mentioned_pages_lite/live	Live
POST	/v3/ai_optimization/llm_mentions/historical/live	Live
POST	/v3/ai_optimization/llm_mentions/timeseries_delta/live	Live
POST	/v3/ai_optimization/llm_mentions/timeseries_new_lost/live	Live

Important: the documentation page currently returned for timeseries_new_lost/live was mislabeled as a Backlinks page in its title/content, but the LLM Mentions Help Center documentation identifies the intended path and behavior as the LLM Mentions Timeseries New and Lost endpoint. Validate the latest schema in the live docs before production deployment.

2. ChatGPT LLM Responses
Model names

The model list is dynamic. Do not hard-code this list permanently; use:

The current live response returned these 49 names:

Each model entry also includes:

Always check web_search_supported and task_post_supported before exposing those options in your product.

Required request fields

For both Live and Standard ChatGPT LLM Responses:

user_prompt
String
Required
Maximum 500 characters
model_name
String
Required
Base names are accepted; DataForSEO selects the latest version when applicable

Example:

Optional request fields
Field	Type	Important rules
max_output_tokens	integer	Default 2048; maximum 4096. For reasoning models, minimum 1024 in the current ChatGPT documentation.
temperature	float	Range 0–2; default 0.94; not supported for reasoning models.
top_p	float	Range 0–1; default 0.92; cannot be combined with temperature.
web_search	boolean	Default false; model must support web search.
force_web_search	boolean	Requires web_search: true; not supported for reasoning models.
web_search_country_iso_code	string	Requires web search; not supported by some models.
web_search_city	string	Requires web search; not supported by some models.
system_message	string	Optional; maximum 500 characters.
message_chain	array	Optional; maximum 10 messages.
message_chain[].role	string	user or ai.
message_chain[].message	string	Maximum 500 characters per message.
tag	string	Optional; maximum 255 characters.
postback_url	string	Standard method only; receives completed results by POST.
pingback_url	string	Standard method only; completion notification by GET.

temperature and top_p are mutually exclusive.

Live request

The POST body must be a JSON array containing exactly one task:

Standard request

A Standard POST may contain up to 100 tasks:

Then retrieve using:

or:

For production integrations, prefer postback_url or pingback_url over polling.

3. Tracking brand mentions and citations
ChatGPT brand mentions

Use:

Set:

This returns:

question
answer
sources
search_results
ai_search_volume
monthly_searches
brand_entities
fan_out_queries
first_response_at
last_response_at

For citations specifically, inspect the sources array. For ChatGPT, you can also analyze search_results.

Google AI Overviews brand mentions and citations

Use the same endpoint with:

For Google, model_name is returned as google_ai_overview, and citation data is represented by the sources array.

Aggregated brand visibility

For totals and dimensions rather than individual answers:

Returns aggregation by:

location
language
platform
cited source domain
ChatGPT search-result domain
ChatGPT brand entity title
brand entity category
total mentions and AI search volume

For a lighter response:

Competitive share of voice

Use:

Define each brand or competitor under targets with a custom key. This is appropriate for side-by-side comparison of brands such as:

Top cited domains and pages

Use:

The links_scope field selects:

sources — citations in the final answer
search_results — ChatGPT search results only

The Lite alternatives return a simpler response:

4. Historical LLM Mentions API

There are three historical/time-series paths.

A. Historical snapshot

Returns month-by-month:

mentions
ai_search_volume

Historical data is available from 2025-08-01.

Example:

B. Period-over-period delta

Required additional fields:

date_from
date_to
group_range

group_range can be:

Returns:

date
delta_mentions
delta_ai_search_volume
C. New and lost mentions

Returns:

new_mentions
lost_mentions
new_ai_search_volume
lost_ai_search_volume

This helps distinguish genuine growth from churn.

Important calculation detail:

However:

does not necessarily equal:

DataForSEO documents these as complementary metrics calculated using different logic.

5. Limits, required fields, and costs to account for
Request and concurrency limits
Limit	Value
General API rate limit	2,000 requests/minute
Most AI Optimization Live calls	One task per request
AI Optimization simultaneous-request limit	30
LLM Responses Live execution time	Up to 120 seconds
LLM Scraper Live execution time	Up to 120 seconds
LLM Mentions Live execution time	Up to 120 seconds
Standard task_post tasks	Up to 100 tasks per POST
tasks_ready calls	Up to 20/minute
tasks_ready returned tasks	Up to 1,000 per call
Completed-task retention in queue	Three days
Standard result retrieval by ID	Up to 30 days

For Standard workflows, use webhooks first:

Submit with postback_url or pingback_url.
Store the task ID and tag.
Use task_get/{id} for recovery or verification.
Use tasks_ready mainly for failed/missed callbacks.

Do not build a production system around a tight tasks_ready polling loop.

Live-task array rule

For Live endpoints, the POST array must contain exactly one task.

This applies especially to:

ChatGPT LLM Responses Live
LLM Mentions Live endpoints
AI Keyword Data Live
LLM Scraper Live endpoints

If more than one task is supplied, the first may be processed and subsequent tasks can return:

LLM Mentions target rules

For LLM Mentions endpoints:

target is required.
Maximum 10 target entities per target array.
Each entity contains either domain or keyword.
A request must contain at least one included target:
search_filter: "include"
Domain:
maximum 63 characters
omit https:// and www.
Keyword:
maximum 250 characters
Keyword search_scope values:
any
question
answer
brand_entities
fan_out_queries
Domain search_scope values:
any
sources
search_results
search_results scope is ChatGPT-only.
match_type:
word_match
partial_match

For brand-in-answer monitoring, use:

Do not use only brand_entities unless you specifically want the model’s structured brand-entity data rather than textual answer mentions.

Platform restrictions

For LLM Mentions:

ChatGPT data is currently available only for:
United States
English
Google AI Overview supports the locations and languages returned by:
/v3/ai_optimization/llm_mentions/locations_and_languages

Do not assume that a ChatGPT request with a non-US location or non-English language will return data.

AI Keyword Data limits

For:

keywords is required.
Maximum 1,000 keywords per task.
Maximum 250 characters per keyword.
A location is required:
location_name or location_code
A language is required:
language_name or language_code
LLM Scraper limits

For Scraper requests:

keyword is required.
Maximum 2,000 characters.
Location is required:
ChatGPT: location_name or location_code
Gemini additionally supports location_coordinate
Language is required:
language_name or language_code
Standard POST supports up to 100 tasks.
Live requests support one task.
Pricing
LLM Responses Live

The documented pricing formula is:

The response includes:

input_tokens
output_tokens
reasoning_tokens
money_spent

The task-level cost includes the DataForSEO base price plus provider usage.

LLM Responses Standard

The documented Standard pricing includes:

The $0.01 advance is refunded partially if provider usage is lower, and refunded if the task fails because the 72-hour completion window expires.

LLM Mentions, Scraper, and AI Keyword Data

These are paid data endpoints. The exact amount depends on endpoint, method, task, and options. Use the current pricing pages:

AI Optimization pricing
LLM Responses pricing
LLM Mentions pricing
LLM Scraper pricing
AI Keyword Search Volume pricing

The following metadata endpoints do not charge the account:

model lists
locations/languages lists
filters lists
tasks_ready
Standard task_get result retrieval

That does not make the originating task free: Standard tasks are charged when posted.

This is an approximate price. For more details and assistance, you can contact support at the vendor support desk (address redacted: a vendor escalation path is not ours to redistribute), which is available 24/7 and always ready to help with your request and calculate pricing for your specific use case.

For custom integration or volume pricing, contact a named vendor contact (address redacted). Custom pricing is available only for volumes of 2+ million requests per month.

How does DataForSEO LLM Responses API work?
What is the difference between Live and Standard methods?
How do AI Keyword Data API tasks return results?

DataForSEO AI can make mistakes. Consider double-checking important information with support and documentation.
```
