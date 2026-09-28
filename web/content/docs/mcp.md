---
title: "Set up OpenGeo MCP"
description: "Connect OpenGeo MCP to Claude, Codex, and other AI clients."
---

OpenGeo MCP lets compatible AI clients call OpenGeo tools for keyword research, SERP inspection, local business research, competitive search intelligence, domain research, backlink overview, saved keywords, rank tracking, shared project context, and Google Search Console performance and URL inspection.

The hosted MCP server URL is:

```txt
https://app.opengeo.so/mcp
```

The first connection sends you through OpenGeo login. After authorization, your MCP client can call OpenGeo tools with the project context and account scopes you approved. For headless environments and CI, [connect with an API key](#connect-with-an-api-key) instead.

For the most current setup UI and a copyable endpoint, open [Agent setup in OpenGeo](https://app.opengeo.so/ai).

For setup prompts, plugin commands, and skill updates, see [Agent setup](/docs/agent-setup).

No account yet? Try the [free SEO tools](/tools).

## Claude Code

The [OpenGeo plugin](/docs/claude-code-plugin) is the preferred way to connect Claude Code — one install adds MCP and the public SEO skills together. Use the steps below only if you want MCP on its own.

Use user scope to make OpenGeo available across projects. Use local scope for the current repository.

```bash
claude mcp add --transport http --scope user opengeo https://app.opengeo.so/mcp
```

After adding the server, approve the OpenGeo login when prompted.

## Claude Desktop

1. Open Customize -> Connectors.
2. Click Add (or +), then choose Add custom connector.
3. Paste `https://app.opengeo.so/mcp`.
4. Approve the OpenGeo login when prompted.

Claude Desktop custom connectors are available on Free, Pro, Max, Team, and Enterprise plans. Free plans support one custom connector.

## Cursor

1. Open Cursor Settings -> Tools & Integrations -> MCP Tools.
2. Click New MCP Server. Cursor opens `mcp.json`.
3. Add:

```json
{
  "mcpServers": {
    "opengeo": {
      "url": "https://app.opengeo.so/mcp"
    }
  }
}
```

4. Approve the OpenGeo login when prompted.

## Codex CLI

The [OpenGeo plugin](/docs/codex-plugin) is the preferred way to connect Codex CLI — one install adds MCP and the public SEO skills together. Use the steps below only if you want MCP on its own.

Run this in your terminal:

```bash
codex mcp add opengeo --url https://app.opengeo.so/mcp
```

Approve the login when prompted.

## Codex Desktop

1. Open Settings -> Integrations & MCP.
2. Click Add your own.
3. Paste `https://app.opengeo.so/mcp`.
4. Approve the OpenGeo login when prompted.

## Connect with an API key

Use an API key in headless environments, CI, or clients where OAuth is inconvenient. API keys are personal: anything an agent does with your key acts as you in your workspace.

In the [OpenGeo app](https://app.opengeo.so/settings), open **Settings -> API keys**, create a key, and copy it when it appears. It won't be shown again.

For Claude Code, run:

```bash
claude mcp add --transport http --scope user opengeo https://app.opengeo.so/mcp --header "Authorization: Bearer oseo_YOUR_KEY"
```

For Cursor, add `headers` to the server entry in `mcp.json`:

```json
{
  "mcpServers": {
    "opengeo": {
      "url": "https://app.opengeo.so/mcp",
      "headers": {
        "Authorization": "Bearer oseo_YOUR_KEY"
      }
    }
  }
}
```

For Codex CLI, put the key in an environment variable and reference it:

```bash
export OPENGEO_API_KEY=oseo_YOUR_KEY
codex mcp add opengeo --url https://app.opengeo.so/mcp --bearer-token-env-var OPENGEO_API_KEY
```

Any other client that supports custom HTTP headers can send `Authorization: Bearer oseo_YOUR_KEY` or `x-api-key: oseo_YOUR_KEY`.

## Available tools

OpenGeo MCP exposes tools for SEO research workflows:

- Research keywords with volume, difficulty, and CPC.
- Fetch live Google organic SERP results for keywords.
- Find exact keyword, page, rank, volume, CPC, intent, and traffic rows for a domain or page.
- Compare SERP competitors across a supplied keyword set.
- Search local businesses near a coordinate, filtering by rating, review count, or claimed status.
- Fetch one Maps or Local Finder SERP, and read Google Business Q&A when needed.
- Audit a Google Business Profile: categories, rating, hours, photos, and claim status.
- Collect Google reviews (including reviews from other sites) and Google Business posts.
- Look up valid Google Business category slugs.
- Check Google Maps rank at each point of a grid around a business.
- Hydrate keywords with search volume, difficulty, intent, CPC, and trends.
- List saved keywords from an OpenGeo project.
- Save useful keywords back to OpenGeo.
- Read rank tracker configs and latest keyword positions.
- Summarize a domain's organic footprint.
- Find keywords a domain already ranks for.
- Check backlink and referring-domain overview data.
- Read first-party Google Search Console performance (clicks, impressions, CTR, position).
- Inspect index status, crawl, and canonical for specific URLs (up to 10 per call).
- Read and update a project's shared context: business, goal, positioning, writing preferences, competitors, key pages, and a research log (free, no credits).
- Save and read HTML reports on a project (free, no credits).
- List a project's report templates, and save a reusable report brief to the project (free, no credits).

## What to do after setup

Once OpenGeo MCP is connected, [set up OpenGeo Agent Skills](/docs/skills/setup). MCP gives your agent access to OpenGeo data. Skills are separate `SKILL.md` files that tell your agent how to use that data for specific SEO jobs.

Start with one focused workflow instead of asking your agent to "do SEO" broadly.

- Use [SEO project setup](/docs/skills/seo-project-setup) to save your goals, positioning, competitors, and key pages to your project context, so every other skill reuses them.
- Use [SEO coach](/docs/skills/seo-coach) if you are new to SEO or are not sure which workflow to run first.
- Use [keyword research](/docs/skills/keyword-research) to discover keyword opportunities.
- Use [competitive landscape](/docs/skills/competitive-landscape) to map a market before choosing competitors or pages.
- Use [competitor analysis](/docs/skills/competitor-analysis) to study one competitor.
- Use [keyword clustering](/docs/skills/keyword-clustering) to turn keywords into page groups.
- Use [link prospecting](/docs/skills/link-prospecting) to find outreach prospects for a linkable asset.

## Troubleshooting

If your client cannot connect, check that the server URL is exactly `https://app.opengeo.so/mcp`.

If Codex reports `Authorization server response missing required issuer: expected https://app.opengeo.so`, upgrade Codex CLI or the Codex desktop app to 0.147.0 or later. Codex 0.143 through 0.146 drop the issuer from the OAuth callback. You can also [connect with an API key](#connect-with-an-api-key) instead of OAuth.

If authorization fails, disconnect the OpenGeo server in your client, add it again, and repeat the login flow.

If your agent cannot find a project, ask it to list OpenGeo projects first and use the returned project ID in later tool calls.
