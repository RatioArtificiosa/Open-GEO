# OpenGeo

> **Know whether AI recommends your brand — before your competitor finds out.**

OpenGeo is an open-source **GEO (Generative Engine Optimization)** and SEO platform. It shows you
exactly what ChatGPT, Gemini, Perplexity and Google AI say about your brand, then tells you what to
change. Your AI agent can drive all of it through MCP.

MIT licensed. Bring your own DataForSEO key, or use the hosted version at **[opengeo.so](https://opengeo.so)**.

---

## The problem

Your rankings are fine. Then a prospect asks ChatGPT _"best CRM for a small team"_ — and your brand
isn't in the answer. You have no way to see that, no way to prove it, and no way to fix it.

That's a traffic leak with no dashboard. OpenGeo is the dashboard.

## What OpenGeo does

|                            |                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 🔍 **AI Visibility**       | Mentions, AI search demand, share of voice and citation tracking across ChatGPT and Google AI Overviews                            |
| 🧠 **Answer Intelligence** | Every AI answer archived — the exact prompt, the response, the sources, and where your page was cited _(or retrieved and dropped)_ |
| 🎯 **What to Build**       | Content gaps ranked by intent, format and difficulty, with machine-generated briefs                                                |
| 🔮 **Forecasts**           | Traffic and AI-visibility projections built on stored history                                                                      |
| 🧪 **AI Readiness Audit**  | `llms.txt`, AI-crawler rules, schema and citability — scored, with fixes                                                           |
| 📈 **Classic SEO**         | Keyword research, rank tracking, backlinks, site audits, competitors — a full Semrush-class toolkit                                |

**Free (this repo):** the complete, uncapped product. You pay DataForSEO directly.
**Hosted (opengeo.so):** no infrastructure, managed scheduling, history, forecasts, multi-client workspaces.

## What makes it different

DataForSEO — our data provider — **does not do forecasting, benchmarking, breakout detection, or
recommendations.** It supplies history and measurement. Ask their own AI assistant whether they
forecast; the answer is no. So we build the decision layer on top:

1. **The diagnosis** — _why_ you score what you score. Which query retrieved your page and cited a competitor instead. The exact answer text.
2. **The attribution** — publish a page on the 14th, watch mentions move on the 21st. A stateless AI skill has no memory. We keep the record.
3. **The receipts** — every number opens the exact prompt, answer, source and vendor cost behind it. In a market full of untraceable dashboards, provable provenance _is_ the premium feature.
4. **The scale** — one AI skill handles one brand in one session. OpenGeo tracks thousands, nightly.

## Honest numbers, and one thing we won't do

`ai_search_volume` is **computed differently per platform** — Google's figure is real search volume,
ChatGPT's is a People-Also-Ask model. Measured on one keyword: **12,621,380 vs 63,850 — a 198× gap.**

So OpenGeo never merges them. You get two platform cards, each with its own methodology note,
because a single confident "total" would be wrong — and you'd have no way to know.

Every metric's computation is documented in [`docs/METHODOLOGY.md`](./docs/METHODOLOGY.md).

## Quickstart

```bash
git clone https://github.com/RatioArtificiosa/Open-GEO.git
cd Open-GEO
cp .env.example .env      # add your DataForSEO key
docker compose up
```

Open **http://localhost:3001**. You need one thing: a
[DataForSEO API key](https://app.dataforseo.com/register) (base64 `login:password` from the API Access tab).

**Prefer not to sign up yet?** Run with `DEMO_MODE=true` — seeded data, no key, no cost.

## Self-hosting

| Path                            | Best for                                                         |
| ------------------------------- | ---------------------------------------------------------------- |
| **Docker**                      | Trying it out, personal use, your own machine                    |
| **Cloudflare**                  | Internet-facing, team use, multi-device — works on the free plan |
| **Railway / Coolify / Dokploy** | One-click PaaS deploys                                           |

Guides: [Docker](./docs/SELF_HOSTING_DOCKER.md) · [Cloudflare](./docs/SELF_HOSTING_CLOUDFLARE.md) · [Railway / Coolify / Dokploy](./docs/SELF_HOSTING_PAAS.md) · [DataForSEO key](./docs/DATAFORSEO_API_KEY.md)

## MCP & Agent Skills

OpenGeo exposes an MCP server so agents — Claude Code, Codex, Cursor, Gemini CLI, opencode — can use
your data directly. Agent Skills are reusable workflows that walk an agent through GEO and SEO work.

```bash
npx skills add https://github.com/RatioArtificiosa/Open-GEO
```

- [Set up the MCP server](https://opengeo.so/docs/mcp)
- [Set up Agent Skills](https://opengeo.so/docs/skills/setup)

## Costs

Self-hosting costs you exactly what DataForSEO charges — **~$3.30 per brand monitored daily per
month** (10 rows returned). The full price book is in
[`src/shared/dataforseo-pricing.ts`](./src/shared/dataforseo-pricing.ts) and pinned by tests, so a
vendor price change fails the build rather than quietly changing your bill.

The hosted service adds a margin on those requests. No seat fees, no annual contracts.

## Local development

See [`docs/LOCAL_DEVELOPMENT.md`](./docs/LOCAL_DEVELOPMENT.md).

## Contributing

Creating clear issues is the best way to contribute. Start with
[`good first issue`](https://github.com/RatioArtificiosa/Open-GEO/labels/good%20first%20issue).

Read more here: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md)

We have a `/simple-issue-description` skill that helps:

```sh
npx skills add RatioArtificiosa/Open-GEO --skill simple-issue-description
```

## Community

Join Discord to chat: [Discord](https://discord.gg/c9uGs3cFXr)

Follow along for updates:

- Follow on X: https://x.com/bensenescu
- Sign up for the mailing list: [opengeo.so](https://opengeo.so)

## Credits

OpenGeo is a derivative work of **[OpenSEO](https://github.com/every-app/open-seo)** (MIT, © 2026 Ben
Senescu), extended with the GEO suite. Upstream attribution is preserved in [`LICENSE`](./LICENSE)
and [`NOTICE.md`](./NOTICE.md). We are grateful to the OpenSEO authors.

Data provided by [DataForSEO](https://dataforseo.com).
