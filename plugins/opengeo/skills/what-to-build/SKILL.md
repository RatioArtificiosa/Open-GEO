---
name: what-to-build
description: Use when asked what content to create, which keywords to target, or how to beat a competitor's content coverage. Turns competitor keyword gaps into a prioritised, format-specific build plan with briefs. Triggers on "what should I write", "content ideas", "what to build", "keyword gap", "beat competitor", "content plan", "topic ideas", "why do they rank and I don't", "content gap analysis".
---

# What to build — from competitor gap to ranked content plan

This produces a **decision**, not a keyword dump. Four hundred keywords is not an answer. "Build
these four pages, in this order, in these formats" is.

## Workflow

### 1. Find the gaps

For each competitor, call `get_domain_keyword_suggestions(domain)` and keep
`keyword`, `position`, `volume`, `difficulty` per row. A gap is a keyword a
competitor ranks for that the user does not (checked in step 3): there is no
single gap call on the wire, so the comparison is yours, not the tool's.
(The Labs domain-intersection endpoint exists server-side but is not exposed
as a tool. Do not call `domain_intersection` by name.)

### 2. Decide the format — never skip this

The intent label maps directly to a content format:

| Intent | Build |
|---|---|
| Informational | Guide, tutorial, explainer, FAQ |
| Commercial | Comparison, review, alternatives page |
| Transactional | Product, service, landing page |
| Navigational | Brand or product page |

Then let the **SERP elements** refine it:

| Element present | Action |
|---|---|
| Many video elements | Make a video, or a video-supported article |
| `people_also_ask` | Add a Q&A section |
| `images` | Add original visuals with real alt text |
| `featured_snippet` | Structure a concise answer, list, or table near the top |
| `ai_overview` | Mirror the topics its sources cover |
| `ai_overview` **and we're retrieved but not cited** | Not a volume problem — a *directness* problem. Rewrite the direct answer. |

That last row is the insight worth the whole workflow. A retrieved-but-uncited page is rejected for
being indirect, not for being short.

### 3. Check we don't already rank for it

Pull current rank tracking first with `get_rank_tracker` (read-only latest
results, no credits — never `run_rank_tracker` for this, which spends).
**Never recommend a keyword the user already ranks #1 for** — it's
the fastest way to lose trust.

### 4. Add the AI-demand signal

```
ai_keyword_volume(keywords, location, language)
```

Compare AI search volume against Google volume. A topic with **high AI demand and low Google demand**
is invisible to classic SEO tools and often the cheapest traffic available. **Flag these explicitly** —
for most sites this is the most valuable output of the whole run.

### 5. Prioritise

Score: `(volume × intent weight) ÷ (difficulty + effort)`, boosted by rising AI demand.

Return **the top 5–10, ordered**, one line of justification each.

**Never return more than 10.** A ranked short list is advice. A long list is work you just handed
back to the user.

### 6. Write the briefs

For the top 3: target query, format, the questions it must answer, the entities to mention, the
internal links to include.

For the top 3, call `generate_content_brief(candidate)` with the gap
candidate — the candidateSchema keys (keyword, volume, keywordDifficulty,
intent, serpCompetitors, serpElements, competitorDomains, etv).
The brief is pure assembly — free, no vendor call. Its machine outline stays
explicitly empty until the funding-day vendor call fills it, so never invent
one. Prefer a brief to a full draft — clients usually want to write it
themselves.

## Reporting

One page. A ranked table: query · format · why now · effort. Then briefs for the top 3.

State the cost of the underlying data calls before a large sweep.

## Never

- Never recommend "publish more content" as a specific action.
- Never recommend a keyword the user already ranks #1 for.
- Never present AI demand as search volume — different metrics, different meanings.
- Never give an unranked list of more than 10 items.
