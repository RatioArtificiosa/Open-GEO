---
name: opengeo
description: Use whenever the user asks about their site's search performance, AI visibility, keywords, competitors, backlinks, rankings, or technical SEO — or asks to audit, research, track, or report on any of it. Routes to the right OpenGeo workflow and keeps the reporting honest. Triggers on "SEO", "why isn't my site ranking", "audit my site", "competitor analysis", "backlinks", "keyword research", "AI visibility", "does AI recommend me", "search console", "site health", "what should I do for SEO".
---

# OpenGeo — SEO and AI-visibility routing

OpenGeo answers two questions classic SEO tools cannot: **what is AI saying about this brand**, and
**what should be built next**. This skill routes the request and keeps reporting honest.

## First, check the connection

If the OpenGeo MCP server isn't available, say so plainly and point to the setup docs at
`opengeo.so/docs/mcp`. **Never fabricate SEO or AI-visibility data.** A plausible invented number is
worse than no answer, and the user cannot tell the difference without checking.

## Routing

| The user asks | Run |
|---|---|
| "Does AI recommend me?" / "AI visibility" / "am I cited" | `geo-audit` skill |
| "What should I write?" / "keyword gap" / "beat competitors" | `what-to-build` skill |
| "Audit my site" / "technical issues" | `run_site_audit`, then `get_audit_issues` |
| "Research keywords" / "what are people searching for" | `research_keywords` |
| "How do I rank?" / "track my keywords" | `run_rank_tracker`, `get_rank_tracker` |
| "Who are my competitors?" | `find_serp_competitors`, `get_domain_overview` |
| "Search Console data" / "is my site healthy?" | `get_search_console_performance` |
| "What will this cost?" | estimate first, state it, then spend |
| "What can you do?" | This skill, plus the MCP tool list |

## Reporting principles

**Name the source of every number.** AI visibility comes from a recorded corpus of AI answers — not
from live prompting, and not personalised to the user. Traffic, search volume and AI demand are
models. Say "estimated", and say estimated *of what*.

**Never sum across AI platforms.** `ai_search_volume` is computed differently for Google AI Overviews
and ChatGPT. Two numbers, always. If the user pushes back, this is the answer: *"they measure
different things — Google's is real search volume, ChatGPT's is modelled from People-Also-Ask. A
combined total would be a number with no meaning."*

**Volume, not verdicts.** Every report ends with something they can do today, on a named page.

**Cost before spend.** Calls are metered against a real balance. On any large sweep, state the call
count and dollar cost first, and use `dry_run` where the tool offers it.

## What OpenGeo can and cannot do

**Can:** AI mentions and citations · share of voice · the citation gap (retrieved but not cited) ·
an archive of exact prompts, answers and sources · AI search demand · keyword and competitor
research · rank tracking · site audits · backlinks · Search Console and Analytics.

**Cannot:** promise a specific ranking or citation — AI answers are sampled and personalised · give
conversion data (needs their own analytics) · state a competitor's traffic exactly (ETV is a model) ·
show what Google *retrieved* for AI Overview pages (only citations are returned).

If asked for something outside this list, **say so rather than approximating it.**

## Tone

Direct and concrete. Real numbers, real pages, a real next action. No "supercharge", no "unlock", no
filler enthusiasm. If the data looks bad, say so — that is the service.
