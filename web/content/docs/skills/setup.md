---
title: "Set up OpenGeo Agent Skills"
description: "Add OpenGeo skill files to your AI agent after connecting OpenGeo MCP."
---

OpenGeo Agent Skills are separate files from OpenGeo MCP.

On Claude Code, skip the steps below and use the [OpenGeo plugin](/docs/claude-code-plugin) instead — it installs MCP and every skill in one step. On Codex CLI, use the [OpenGeo plugin](/docs/codex-plugin) the same way.

First, [set up OpenGeo MCP](/docs/mcp). MCP gives your agent access to OpenGeo data.

Then add the OpenGeo `SKILL.md` files you want your agent to use. Each skill gives your agent one SEO workflow.

## Choose an installation option

Pick the option that matches how you want to install the files.

### Option 1: Install and choose interactively

Use this if you want the installer to show the available skills and agents.

```bash
npx skills add RatioArtificiosa/Open-GEO
```

### Option 2: Install all OpenGeo skills

Use this if you want every OpenGeo skill.

```bash
npx skills add RatioArtificiosa/Open-GEO --skill '*'
```

### Option 3: Install all skills for Claude Code only

Use this if the skills should be available in Claude Code only.

```bash
npx skills add RatioArtificiosa/Open-GEO --skill '*' --agent claude-code
```

### Option 4: Install all skills for OpenAI Codex only

Use this if the skills should be available in Codex only.

```bash
npx skills add RatioArtificiosa/Open-GEO --skill '*' --agent codex
```

### Option 5: Copy the skill files manually

Use this if you prefer to copy files into your agent's skills folder.

```bash
git clone https://github.com/RatioArtificiosa/Open-GEO.git

# Codex
mkdir -p ~/.codex/skills
cp -R open-geo/plugins/opengeo/skills/* ~/.codex/skills/

# Claude Code
mkdir -p ~/.claude/skills
cp -R open-geo/plugins/opengeo/skills/* ~/.claude/skills/
```

You can also review the source skills on GitHub:

- [OpenGeo Agent Skills on GitHub](https://github.com/RatioArtificiosa/Open-GEO/tree/main/.agents/skills)

Each skill page also links to its source `SKILL.md`.

## Update installed skills

Use the [update prompt or commands for your installation method](/docs/agent-setup#update-your-skills). Update the OpenGeo plugin if it supplies your skills; otherwise use the installer you originally chose or update your manual copies.

## Run a skill

After the skill files are available to your agent, run the matching slash command:

- `/seo-project-setup`
- `/seo-coach`
- `/keyword-research`
- `/keyword-clustering`
- `/competitive-landscape`
- `/competitor-analysis`
- `/link-prospecting`
- `/local-seo`
- `/seo-audit`

## Next step

Start with [SEO Project Setup](/docs/skills/seo-project-setup) if this is a new SEO project, or [SEO Coach](/docs/skills/seo-coach) if you are not sure which workflow to run first.
