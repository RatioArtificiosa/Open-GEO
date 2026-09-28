---
title: "Install the OpenGeo plugin for Claude Code"
description: "Add OpenGeo MCP and Agent Skills to Claude Code with one marketplace and one install command."
---

The OpenGeo plugin bundles OpenGeo MCP and all ten SEO Agent Skills into one install. This is the preferred way to set up OpenGeo in Claude Code.

## Install

Run these two commands in Claude Code:

```bash
/plugin marketplace add RatioArtificiosa/Open-GEO
/plugin install opengeo@opengeo
```

If the install summary says `Run /reload-plugins to activate.`, run that command.

Claude Code connects OpenGeo MCP at `https://app.opengeo.so/mcp` and enables ten skills:

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

## Finish the login

Claude Code should prompt you to log in to OpenGeo right after install. If it doesn't, run `/mcp` and approve the OpenGeo connection from there.

## Run a skill

Plugin skills are namespaced by the plugin name:

```
/opengeo:seo-project-setup
/opengeo:seo-coach
/opengeo:seo-audit
/opengeo:keyword-research
/opengeo:keyword-clustering
/opengeo:competitive-landscape
/opengeo:competitor-analysis
/opengeo:local-seo
/opengeo:link-prospecting
```

## Claude Desktop

Claude Desktop doesn't support this plugin format â€” plugins are a Claude Code feature. For Claude Desktop, [add OpenGeo as an MCP connector](/docs/mcp#claude-desktop) instead.

## Update

Run inside Claude Code:

```text
/plugin marketplace update opengeo
/plugin update opengeo@opengeo
/reload-plugins
```

Updates land in the cache immediately, but the running session keeps the old version until you run `/reload-plugins` or restart Claude Code.

For other installation methods, see [Agent setup and skill updates](/docs/agent-setup#update-your-skills).

## Remove

```text
/plugin uninstall opengeo@opengeo
```

## Troubleshooting

To check what's actually installed, run `/plugin list` rather than bare `/plugin` â€” `/plugin` alone opens an interactive panel that doesn't show plain text.

If `/reload-plugins` reports `0 skills`, that's normal, not a failure â€” its summary only counts a plugin's `commands/` directory, not `skills/`. Confirm the skills loaded by running one directly, for example `/opengeo:seo-audit`.

If `/plugin uninstall opengeo@opengeo` reports "not installed in this project," you likely installed to a different scope than the one being checked (User, Project, or Local). Run `/plugin list` to see the actual scope, or sidestep the picker entirely with the shell form: `claude plugin uninstall opengeo@opengeo --scope user`.

If plugin skills don't appear, clear the plugin cache with `rm -rf ~/.claude/plugins/cache` â€” this clears every installed plugin's cache, not just OpenGeo's, so reinstall anything else you have after â€” then restart Claude Code and reinstall the plugin.

If the OpenGeo connection doesn't show as authenticated, run `/mcp`, select OpenGeo, and complete the login.

## Other clients

This plugin is for Claude Code. For Codex CLI, use the [OpenGeo plugin for Codex](/docs/codex-plugin) instead. For Cursor, Codex Desktop, Claude Desktop, or an API key setup, see [Set up OpenGeo MCP](/docs/mcp) and [Set up OpenGeo Agent Skills](/docs/skills/setup).
