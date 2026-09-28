---
title: "Install the OpenGeo plugin for Codex"
description: "Add OpenGeo MCP and Agent Skills to Codex with one marketplace and one install command."
---

The OpenGeo plugin bundles OpenGeo MCP and all ten SEO Agent Skills into one install. This is the preferred way to set up OpenGeo in Codex CLI.

## Install

Run these commands in your terminal:

```bash
codex plugin marketplace add RatioArtificiosa/Open-GEO
codex plugin add opengeo@opengeo
codex mcp login opengeo
```

`codex mcp login` opens a browser to approve the OpenGeo connection. If it reports that `opengeo` isn't found, restart Codex first â€” bundled MCP servers only register after a restart, not immediately after install â€” then run `codex mcp login opengeo` again.

Codex connects OpenGeo MCP at `https://app.opengeo.so/mcp` and enables ten skills:

- SEO Project Setup
- SEO Coach
- SEO Audit
- Keyword Research
- Keyword Clustering
- Competitive Landscape
- Competitor Analysis
- Local SEO
- Link Prospecting
- SEO Report

## Run a skill

Type `$` in Codex to see available skills, or ask Codex to run one by name, for example "run seo-project-setup" or "run seo-audit on example.com".

## Update

```bash
codex plugin marketplace upgrade opengeo
```

Reload or restart Codex if the updated skills are not available. For other installation methods, see [Agent setup and skill updates](/docs/agent-setup#update-your-skills).

## Remove

```bash
codex plugin remove opengeo@opengeo
```

## Troubleshooting

If the OpenGeo MCP server doesn't appear after restart, run `/mcp` in the Codex TUI to check its status, then run `codex mcp login opengeo` again.

If it still doesn't authenticate, log out first and retry:

```bash
codex mcp logout opengeo
codex mcp login opengeo
```

If a `codex plugin` command reports "unrecognized subcommand," run `codex plugin --help` to see the subcommands your installed version actually supports â€” they've changed across versions (for example, `add`/`remove`, not `install`/`uninstall`).

## Other clients

This plugin is for Codex CLI. For Claude Code, use the [OpenGeo plugin for Claude Code](/docs/claude-code-plugin) instead. For Claude Desktop, Cursor, Codex Desktop, or an API key setup, see [Set up OpenGeo MCP](/docs/mcp) and [Set up OpenGeo Agent Skills](/docs/skills/setup).
