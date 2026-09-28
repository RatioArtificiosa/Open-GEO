# OpenGeo Methodology

**How every number in OpenGeo is computed.**

Version 1.0 · Last updated 2026-09-28 · Data provider: [DataForSEO](https://dataforseo.com)

This page exists because a dashboard you cannot audit is a dashboard you cannot trust. Every metric
below states its source, its formula, and — where it matters — its limits. If a metric changes
methodology between versions, the changelog says so and the version is recorded with the data.

---

## The one rule that governs everything

### `ai_search_volume` is platform-specific. It is never summed or compared across platforms.

The same field name is computed two different ways:

| Platform                       | Derivation                                                              | What it means                                                     |
| ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `google` (Google AI Overviews) | **Google Search Volume** of the query                                   | Demand from traditional Google searches whose AI Overview matched |
| `chat_gpt`                     | **People-Also-Ask model** — counts PAA questions containing the keyword | Estimated conversational demand                                   |

These are different quantities measured from different sources. **Measured example** (keyword
"renault", United States, English):

| Platform           | `mentions` | `ai_search_volume` |
| ------------------ | ---------- | ------------------ |
| Google AI Overview | 17,676     | 12,621,380         |
| ChatGPT            | 3,060      | 63,850             |

A 198× difference for the same keyword. Adding these, or charting them on one axis, produces a
number with no meaning.

**How OpenGeo presents it:** two separate platform cards, each with its own demand label, its own
sparkline, and a methodology tooltip. When one combined view is needed, we use a **per-platform
index against its own baseline** — "Google visibility is 18% above baseline, ChatGPT visibility is
32% above baseline" — which is valid because each is compared only to itself. It is never labelled
as a volume.

**Source:** DataForSEO, _How the AI search volume metric works in LLM Mentions_.

---

## Metric reference

### AI Visibility Score (0–100)

Our composite. Every component is click-through to its evidence.

```
Score = 40 × Mention Coverage     (your mentions ÷ matching records, vs category median)
      + 25 × Share of Voice        (your mentions ÷ all tracked competitors' mentions)
      + 20 × Citation Authority    (quality and recency of domains citing you)
      + 15 × Momentum              (13-week trend + new/lost delta)
```

Mention Coverage, Share of Voice and Citation Authority are computed **within a single platform** and
then combined. See the rule above.

### Mentions

A count of matching AI answer records. Not a score, not a rate. This is a raw count and is labelled
as one.

### Estimated Traffic Volume (ETV)

Provided by DataForSEO's Labs endpoints as a model output, not a measurement.

> ⚠️ **ETV formula change — 2026-11-01.** DataForSEO is switching ETV to an improved model
> (layout-aware CTR that accounts for AI Overviews, shopping and snippets; intent-aware; and
> clickstream-normalised volume). Values computed under the two formulas are **not** directly
> comparable, and a series can show a discontinuity at the cutover even when rankings did not change.
>
> OpenGeo therefore **version-stamps every stored ETV value** (`etv_formula_version`) and never
> charts across the boundary without labelling it. If you see a step in a traffic line, check the
> formula version before you conclude your traffic moved.

### On-page score

`onpage_score` from DataForSEO's On-Page API — 0 to 100. It is a **technical/on-page score**, not an
editorial or content-quality grade, and we label it that way.

### Keyword difficulty, competition, CPC

Straight from Google Ads (or Bing Ads) via DataForSEO. Competition is 0–1 from Google Ads;
`competition_level` is the LOW/MEDIUM/HIGH label. These are Google's numbers, not ours.

### AI Readiness / citability

**Our score, our method** — DataForSEO provides the raw signals (crawl, schema, `onpage_score`,
SERP structure) but not an AI-readiness grade. It is a heuristic, published in full, and always
shown with the individual checks that produced it so you can disagree with a specific item.

### Forecasts

**Ours, and deliberately conservative.** Built on stored history (GSC where available, rank
snapshots, AI mention history) plus a stated model version. Forecasts are published with:

- the model version they were produced by,
- a confidence band, and
- a minimum-history requirement — below it, we show "collecting data" rather than a number nobody
  can defend.

**A forecast is a direction, not a promise.**

### Inclusion–Citation Gap

Our analysis over DataForSEO's `search_mentions`. A page is **retrieved but not cited** when its
URL appears in the model's background retrieval (`search_results`) and not in the sources it cited
(`sources`). Reported on the vendor's four-state model: Cited / Retrieved-not-cited / Cited-only
anomaly / Not retrieved.

**Scope limit:** `search_results` is available for **ChatGPT records only**. For Google AI Overview
records we cannot see the retrieval list, so we do not claim the gap there.

---

## What we do not claim

- **No individual-level data.** DataForSEO is not a consumer data provider. We build aggregate
  segments and behavioural personas, never identities.
- **No cross-platform totals** for any demand metric (see the rule above).
- **No forecast without a confidence band and a stated model version.**
- **No "AI visibility" number without a receipt** — every figure links to the prompt, answer,
  sources, and the vendor cost that produced it.

---

## Cost transparency

The full DataForSEO price book is in
[`src/shared/dataforseo-pricing.ts`](../src/shared/dataforseo-pricing.ts) and is pinned by
[`dataforseo-pricing.test.ts`](../src/shared/dataforseo-pricing.test.ts). A vendor price change
breaks the build rather than silently changing what a customer is billed.

Reference cost: **~$3.30 per brand monitored daily per month** (10 rows returned per check).

---

## Corrections

This document is a living record. If you find a metric that disagrees with its description, that is
a bug — please [open an issue](https://github.com/RatioArtificiosa/Open-GEO/issues). Corrections are
logged in the changelog with the version they landed in.
