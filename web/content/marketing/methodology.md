---
title: Methodology
description: How every number in OpenGeo is computed — its source, its formula, and its limits. Including what we refuse to claim.
---

A dashboard you cannot audit is a dashboard you cannot trust.

Every figure below states its source, its formula, and — where it matters — its
limits. Where a metric changes between versions, the changelog says so and the
version is recorded with the data.

If a metric disagrees with its description here, that is a bug.
[Open an issue](https://github.com/RatioArtificiosa/Open-GEO/issues).

---

## What we do not claim

This section comes first on purpose. It is the most persuasive thing on the page
for the buyer this product actually has.

- **No individual-level data.** DataForSEO is not a consumer data provider. We build
  aggregate segments and behavioural personas, never identities.
- **No cross-platform totals** for any demand metric — see the rule below.
- **No forecast without a confidence band and a stated model version.**
- **No "AI visibility" number without a receipt.** Every figure opens onto the
  prompt, the answer, the sources, and the vendor cost that produced it.
- **No readiness score.** A site with its AI crawler blocked and otherwise perfect
  content averages to a healthy-looking middle, while the one thing that would make
  it citable is still switched off. A single number would hide that finding behind
  a digit that looks like every other score in the category — so you get ranked
  fixes instead.

---

## The one rule that governs everything

### `ai_search_volume` is platform-specific. It is never summed across platforms.

The same field name is computed two different ways:

| Platform            | Derivation                                                       | What it means                                                     |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| Google AI Overviews | **Google Search Volume** of the query                            | Demand from traditional Google searches whose AI Overview matched |
| ChatGPT             | **People-Also-Ask model** — PAA questions containing the keyword | Estimated conversational demand                                   |

These are different quantities measured from different sources.

### The measured record, in full

So you can reproduce this rather than take it:

|                         |                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Endpoint**            | DataForSEO `/v3/dataforseo_labs/llm_mentions/target_metrics/live`                                        |
| **Keyword**             | `renault`                                                                                                |
| **Location / language** | United States / English                                                                                  |
| **Retrieved**           | 2026-09-28 — this project's first live measurement of the pair                                           |
| **Raw payload**         | stored against the task in `geo_vendor_tasks`, so any workspace that ran it can read the response itself |

One response carries both platforms' rows, and the field is spelled
`ai_search_volume` in each:

| Platform           | `mentions` | `ai_search_volume` | How that figure is derived                                   |
| ------------------ | ---------- | ------------------ | ------------------------------------------------------------ |
| Google AI Overview | 17,676     | 12,621,380         | Google Search Volume of the query                            |
| ChatGPT            | 3,060      | 63,850             | People-Also-Ask model — PAA questions containing the keyword |

**12,621,380 ÷ 63,850 = 197.7, which is the 198× we quote.** Two derivations, one
field name, one response.

Adding these, or charting them on one axis, produces a number with no meaning.

**How we present it:** two separate platform cards, each with its own demand label,
sparkline, and methodology note. Where one view is genuinely needed we use a
**per-platform index against its own baseline** — "Google visibility is 18% above
baseline, ChatGPT visibility is 32% above baseline" — which is valid because each
number is compared only to itself. It is never labelled a volume.

This is not a documentation preference. There are twenty places in this codebase
that refuse to add these two numbers together — several of them because it had
already been done by accident.

---

## Cost transparency

### AI keyword volume — where the $0.11 comes from

The homepage quotes **$0.11 for 1,000 AI keywords**, so here is the arithmetic.

|                                   |                                                                       |
| --------------------------------- | --------------------------------------------------------------------- |
| **Endpoint**                      | DataForSEO AI Optimization Keyword Search Volume — **Live mode only** |
| **Per task**                      | **$0.01**                                                             |
| **Per keyword returned**          | **$0.0001**                                                           |
| **Maximum keywords per response** | **1,000**                                                             |

```
$0.01           task fee
+ 1,000 × $0.0001   per item
= $0.11
```

**The task fee is added, not amortised across the batch.** Filling a response to its
1,000-keyword maximum does not make each keyword cheaper, and a planner that treats
the fee as per-keyword under-bills by two orders of magnitude — which is a bug this
repository made and fixed. That is why the fee lives beside the unit price rather than
folded into it.

The estimator is `estimateAiKeywordBatch()`, and its constants are in
[`src/shared/ai-keyword-batch-cost.ts`](https://github.com/RatioArtificiosa/Open-GEO/blob/main/src/shared/ai-keyword-batch-cost.ts),
so this page and the code that bills cannot drift apart. Prices last verified against
DataForSEO's published list on **2026-10-04**.

### What a monitored brand costs

**About $3.30 per brand, monitored daily, per month** (10 rows returned per check).

The full DataForSEO price book lives in
[`src/shared/dataforseo-pricing.ts`](https://github.com/RatioArtificiosa/Open-GEO/blob/main/src/shared/dataforseo-pricing.ts)
and is pinned by a test. **A vendor price change breaks the build** rather than
silently changing what a customer is billed.

---

## Corrections

This page is a living record. If you find a metric that disagrees with its
description, that is a bug, and we would rather you told us than trusted us.
