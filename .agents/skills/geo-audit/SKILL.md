---
name: geo-audit
description: Use when asked whether a brand is visible in AI answers, why it is or is not cited, or which pages to fix first. Audits AI visibility across ChatGPT and Google AI Overviews, checks whether retrieved pages are actually cited, and ranks fixes by impact. Triggers on "is my brand in AI", "AI visibility", "GEO audit", "why doesn't ChatGPT recommend me", "am I cited by AI", "AI citations", "is my site in AI answers".
---

# GEO audit — find out what AI actually says, then fix it

Most tools count mentions. This skill produces a **diagnosis**: the specific queries where you are
missing, the pages AI retrieved but refused to cite, and the ranked fixes.

## Before you start

The OpenGeo MCP server must be connected. If it is not, say so and stop — **never invent AI
visibility data.** A plausible made-up number is worse than no answer.

## Workflow

### 1. Establish the baseline — per platform, never merged

Call `geo_get_visibility(target, platform)` **once for each platform** and report them as two
separate numbers.

> ⚠️ **Never sum, average, or chart `ai_search_volume` across platforms.** Google's figure is real
> search volume; ChatGPT's is a People-Also-Ask model. We measured 12,621,380 vs 63,850 for the same
> keyword. A combined total is a wrong number that looks authoritative — that is the single easiest
> way to lose an expert client's trust. If asked why, point to the methodology page.

For competitors: `geo_share_of_voice([brand, ...competitors], platform)`, per platform.

### 2. Find the gap — start here, it's the highest-value output

```
geo_inclusion_citation_gap(target)
```

Returns queries where the model **retrieved** a page but **did not cite it**. Almost no tool
surfaces this, and it converts directly into work.

**If the gap list is non-empty, lead your report with it.** "ChatGPT pulled your pricing page 34
times and cited a competitor instead" beats "your score is 42" every time.

**Scope limit — state it, don't imply otherwise:** the retrieval list is returned for **ChatGPT
records only**. For Google AI Overviews we see what was cited, not what was retrieved. Saying
otherwise is a factual error.

### 3. Check how AI frames the brand

```
geo_brand_framing(target)
```

Returns the titles and categories AI associates with the brand. Diagnostic value: if AI classifies
you as a "blog" or an "outdated tool" rather than a category leader, the fix is positioning and
entity clarity — **not more content volume.** Say that plainly; it's the insight they can't get
elsewhere.

### 4. Get the evidence

For the 3–5 highest-traffic queries where the brand appears or should:
```
geo_search_mentions(target, query, platform, limit)
```

**Quote the answer verbatim.** The client needs to see AI's actual words, not your paraphrase of
them. Record the exact prompt alongside it.

### 5. Rank the fixes

Order by **impact ÷ effort**. Each fix names: the query, the specific page and section, and *why*
that change affects citation likelihood.

**Good:** *"Your comparison page ranks but isn't cited. The cited answer puts an X-vs-Y table in the
first 100 words. Restructure yours the same way."*

**Never:** *"Publish more content."* That is not a recommendation.

## Reporting

One page. Lead with the gap, then share of voice, then the ranked fixes.

Include the honesty caveat: *"AI answers are sampled and personalised. This reflects the recorded
corpus, not a guarantee of any single answer."*

## Cost discipline

Calls are metered. Before a large sweep, state the call count and dollar cost, and offer `dry_run`.
A careless audit can cost more than the tool is worth to the user.

## Never

- Never merge `ai_search_volume` across platforms.
- Never claim Google-AIO retrieval data — it isn't returned.
- Never present ETV or AI search volume as measured traffic.
- Never invent a score the tool didn't return.
