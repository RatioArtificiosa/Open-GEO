# OpenGeo Design System

**The single source of truth for how OpenGeo looks.** Any font, colour, radius, shadow
or spacing value not defined here is a defect, not a choice. If the design needs
something new, it gets added here first, with a reason.

Last updated **2026-09-28**. Owner: founder.

---

## 0. What we are, in one line

**A measurement instrument that happens to be beautiful.**

OpenGeo's product is a record of what AI systems actually say about a brand, kept
over time. Every design decision follows from that: the interface is an
instrument panel, not a marketing page. It should feel closer to a financial
terminal or an oscilloscope than to a SaaS landing page — because the thing that
makes us defensible is _precision and provenance_, and decoration argues against
both.

### The one-line test

Before shipping any UI, ask: **does this make a number more trustworthy, or make
the product more likable?** The first is our job. The second is optional.

---

## 1. The three decisions the founder made

These are settled. Do not relitigate them in a PR.

| Decision             | Choice                                  | Why                                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Accent colour**    | **Amber `#F59E0B`**                     | Every competitor is blue, red or green. Amber reads as _measurement and signal_ — the colour of a highlighted metric — and it will not be mistaken for Semrush, Ahrefs or Surfer. It is also the only one of the four that stays legible on a dark UI without glowing.         |
| **Display typeface** | **The grotesque** (same family as body) | Display and body share one family at different weights and tracking. The restraint reads as expensive, and a headline can be set in the same face as a table cell without a seam. An AI product that reaches for a distinctive display font is telling you it is compensating. |
| **Density**          | **Compact, tabular**                    | The primary view is a time series. Whitespace is not a virtue here; the ability to see 90 days of answers at once is the feature.                                                                                                                                              |

> **On the accent:** amber is a _signal_ colour, not a _chrome_ colour. It marks
> the one number on a screen that matters. If more than roughly 3% of a viewport
> is amber, we have made decoration out of our signal and the number stops
> working. This is the rule that makes the choice hold.

---

## 2. Colour

### 2.1 Surfaces

No pure black. Pure black (`#000`) reads as a hole and kills the elevation
ladder; our darkest surface is a very slightly blue-shifted near-black, so
shadows read as depth rather than as void.

| Token                 | Value     | Use                            |
| --------------------- | --------- | ------------------------------ |
| `--og-bg`             | `#0B0D10` | Page background                |
| `--og-surface`        | `#12151A` | Cards, panels, table shells    |
| `--og-surface-raised` | `#1A1E25` | Hover, popovers, nested panels |
| `--og-border`         | `#252A33` | Default 1px borders            |
| `--og-border-strong`  | `#39404D` | Focus rings, active borders    |

### 2.2 Text

| Token                 | Value     | Use                                   |
| --------------------- | --------- | ------------------------------------- |
| `--og-text`           | `#E8EAED` | Primary text, numbers                 |
| `--og-text-secondary` | `#A8B0BD` | Labels, axis text, secondary metadata |
| `--og-text-muted`     | `#6B7280` | Timestamps, footnotes, disabled       |
| `--og-text-inverse`   | `#0B0D10` | Text on an amber fill                 |

**Never** `#999` grey. If a colour is not in this table, it is not in the system.

### 2.3 Accent — amber

| Token                | Value                      | Use                                                                |
| -------------------- | -------------------------- | ------------------------------------------------------------------ |
| `--og-accent`        | `#F59E0B`                  | The signal: the primary metric, a positive delta, the active state |
| `--og-accent-hover`  | `#D97706`                  | Hover on an amber surface                                          |
| `--og-accent-subtle` | `rgba(245, 158, 11, 0.12)` | Tinted background behind a signal value                            |
| `--og-accent-border` | `rgba(245, 158, 11, 0.32)` | Border on a signal element                                         |

### 2.4 Status colours

Status is never communicated by hue alone — every status also carries an icon or
a label, because colour-blind users are a third of our audience and a red/green
delta is the single most common way to lose them.

| Token           | Value     | Meaning                    |
| --------------- | --------- | -------------------------- |
| `--og-positive` | `#34D399` | Improved                   |
| `--og-negative` | `#F87171` | Regressed                  |
| `--og-caution`  | `#FBBF24` | Needs attention            |
| `--og-neutral`  | `#6B7280` | No change / not applicable |

**Delta rule:** a change is coloured only when it is _statistically meaningful_.
A +0.1% move is `--og-text-secondary`, not green. Colouring every decimal
movement is noise, and noise is the thing we exist to eliminate.

---

## 3. Typography

**One family, used at several weights.** That is the whole system.

```css
--og-font-sans:
  "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
  sans-serif;
--og-font-mono:
  "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace;
```

**Why Instrument Sans, and why not Inter or Geist.** Every competitor measured
uses Inter or Geist, which is what makes them the fingerprint of a generated page
— `scripts/check-slop-budget.mjs` enforces exactly this, and fails the build if
the declared body font is either one. General Sans and Satoshi were rejected
because neither is on Google Fonts, so naming either would have shipped a silent
fallback. **The full rationale is in `web/src/styles/app.css` beside the token,
and it is that comment that is authoritative; this table is a copy.**

Mono is for **data only**: hashes, task ids, URLs, raw vendor payloads, ETV
figures in tooltips. Never for prose, and never for a heading.

### 3.1 Scale

| Role                 | Size / line-height | Weight | Tracking                                      |
| -------------------- | ------------------ | ------ | --------------------------------------------- |
| Display              | 48 / 52            | 600    | −0.02em                                       |
| H1                   | 32 / 38            | 600    | −0.015em                                      |
| H2                   | 24 / 30            | 600    | −0.01em                                       |
| H3                   | 18 / 24            | 600    | −0.005em                                      |
| Body                 | 15 / 22            | 400    | 0                                             |
| Body strong          | 15 / 22            | 500    | 0                                             |
| Label                | 13 / 18            | 500    | 0.01em                                        |
| Caption              | 12 / 16            | 400    | 0.01em                                        |
| **Metric (tabular)** | 28 / 32            | 600    | −0.01em, `font-variant-numeric: tabular-nums` |

**No italic anywhere.** We have no quotations from people. Emphasis is weight or
colour. This is a hard rule, not a preference.

**No uppercase for emphasis.** Section labels use `text-transform: uppercase`
with `letter-spacing: 0.08em` at 12px, and nothing else is ever uppercased.

### 3.2 The tabular rule

Every number that can change over time is set in **tabular figures** with a fixed
column width. A traffic estimate that shifts a pixel when it updates reads as a
different value. This is a correctness issue, not a polish issue.

---

## 4. Spacing, radius, elevation

**Spacing** is a 4px base scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96`. No
other value is permitted. There is no `14px` and there is no `18px`.

**Radius** is deliberately small. Large radii read as friendly; we are an
instrument.

| Token              | Value  | Use                         |
| ------------------ | ------ | --------------------------- |
| `--og-radius-sm`   | 4px    | Inputs, badges, inline code |
| `--og-radius`      | 6px    | Buttons, cards, table cells |
| `--og-radius-lg`   | 10px   | Modals, drawers, popovers   |
| `--og-radius-full` | 9999px | Pills and avatars only      |

**Elevation** is a border, not a shadow. Shadows are reserved for things that are
genuinely floating above the page.

| Token                 | Value                         |
| --------------------- | ----------------------------- |
| `--og-shadow-popover` | `0 8px 24px rgba(0,0,0,0.4)`  |
| `--og-shadow-modal`   | `0 24px 48px rgba(0,0,0,0.5)` |

---

## 5. Data visualisation

This is where the product lives, so the rules are strictest here.

### 5.1 Series colours

In order: `--og-accent` (amber), `--og-positive`, `#60A5FA`, `#A78BFA`,
`--og-caution`, `#F472B6`. Beyond six series, **do not add colours** — facet the
chart or aggregate. A seven-colour line chart is unreadable and is a sign the
question was wrong.

### 5.2 Platform identity

Each AI platform keeps a fixed colour everywhere it appears, so a user learns it
once:

| Platform            | Colour                                               |
| ------------------- | ---------------------------------------------------- |
| ChatGPT             | `#10A37F`                                            |
| Gemini              | `#4285F4`                                            |
| Perplexity          | `#20808D`                                            |
| Google AI Overviews | `#F59E0B` (the accent — it _is_ the primary surface) |

### 5.3 Mandatory chart annotations

Three rules, each one earned by a specific way we would otherwise mislead:

1. **Per-platform charts are separate charts.** Never plot ChatGPT and Google AI
   demand on one axis. They are different models with different units, and a
   combined axis is a lie that looks like a chart.
2. **Any series crossing 2026-11-01 carries a visible, labelled rule** at the
   boundary, from `trendCaveat()`. Not a tooltip — _on the chart_. This is the
   concrete form of the claim that most tools' traffic lines break silently here.
3. **Estimates are labelled as estimates.** Any ETV, search-volume or AI-demand
   figure carries an `≈` or a caption saying what model produced it. An unlabelled
   estimate is a measurement, and that is a lie.

### 5.4 Forecasts

Forecasts render as a **band**, never a line. A single projected line implies a
confidence we do not have. Every band states its method and its width at the
90-day horizon.

---

## 6. The honesty rules, in UI terms

These are product rules expressed as design rules. They are the reason the design
system exists.

| Never                                            | Instead                                     |
| ------------------------------------------------ | ------------------------------------------- |
| A combined AI-visibility number                  | One figure per platform, always labelled    |
| An empty "citation gap" list with no explanation | `retrievalAvailable: false` plus the reason |
| A score with no history                          | The series, with the archive behind it      |
| "AI says you're not visible"                     | "Not mentioned in 3 of 40 archived answers" |
| A trend line through the ETV boundary            | The line, plus the boundary rule            |
| An interpolated missing month                    | A gap, visibly a gap                        |
| A `0` and a `null` rendered identically          | `0` and "no data", distinct                 |

---

## 7. Motion

Motion exists to explain a change, never to entertain.

| Purpose                    | Duration | Easing                       |
| -------------------------- | -------- | ---------------------------- |
| Hover, focus               | 120ms    | `ease-out`                   |
| Panel, dropdown            | 180ms    | `ease-out`                   |
| Value change (number tick) | 240ms    | `cubic-bezier(0.2, 0, 0, 1)` |
| Chart first paint          | 400ms    | `ease-out`                   |

**No spring physics. No bounce. No stagger.** A staggered list entrance is the
single most reliable AI-slop tell, and it is banned. Respect
`prefers-reduced-motion`: all durations drop to 0.

---

## 8. Component rules

1. **Every table has a purpose line.** A column without a stated reason gets cut.
   A dashboard that shows everything shows nothing.
2. **Every number states its source** in the row or a tooltip: which endpoint,
   which date, which formula version.
3. **No modal for a read.** Modals are for decisions that commit. Viewing an
   answer, a citation or a run-over-run diff happens in a panel or a route.
4. **Empty states teach.** "No answers yet — your first patrol runs tonight at
   02:00 UTC" beats "No data".
5. **Buttons say what happens.** "Run patrol now (~$0.11)" not "Submit".
6. **Destructive actions name the consequence.** "Delete 1,284 archived answers
   permanently", with the count, not a generic "Are you sure?".

---

## 9. The no-slop gate

This document is not a style guide we "try to follow". It is **enforced**:

```bash
npx impeccable detect src/     # 61-rule AI-slop detector, headless, no LLM
```

It runs in CI. A merge that trips it does not land. The rules it checks include
gradient-everything, emoji-as-icon, centred hero + three feature cards, glassmorphism,
purple-blue SaaS defaults, uniform shadow blur, and arbitrary border radii — every
one of which this document already forbids.

**If the detector flags something and you think it is wrong, fix the detector
config or this document — not by suppressing the rule.** A suppression is a lie
about the state of the product.

---

## 10. Definition of done for any UI change

- [ ] Every new colour, size, radius and spacing value appears in this file
- [ ] `npx impeccable detect src/` passes
- [ ] No number on screen lacks a source
- [ ] No chart crosses a method boundary without a visible rule
- [ ] Works at 200% zoom and in forced-colours mode
- [ ] `prefers-reduced-motion` honoured
- [ ] The empty state and the error state were both written
- [ ] Contrast ≥ 4.5:1 for text, ≥ 3:1 for UI borders
