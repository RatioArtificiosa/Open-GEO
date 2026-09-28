# Where OpenGeo works — every agent, one MCP server

**Last verified: 2026-09-28.** Platform capabilities change; if something here is wrong, open an issue.

OpenGeo ships **one remote MCP server** (`https://app.opengeo.so/mcp`) and a **skills pack**. Every
platform below connects to one or both. There is nothing to fork per platform.

---

## Quick start

| Platform                            | Install                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| **Claude Code**                     | `/plugin marketplace add RatioArtificiosa/Open-GEO` → `/plugin` → install **opengeo** |
| **ChatGPT**                         | Plugins → add MCP server → `https://app.opengeo.so/mcp` → sign in with OpenGeo        |
| **Codex**                           | Copy `.codex-plugin/plugin.json` into your plugin, or add the MCP server URL          |
| **Cursor**                          | `.cursor/mcp.json` is already in this repo — or paste the URL into Settings → MCP     |
| **Antigravity CLI** (ex-Gemini CLI) | `agy extensions install https://github.com/RatioArtificiosa/Open-GEO`                 |
| **Grok / Grok Build**               | Add the remote MCP server URL in Connectors, or use the skills                        |
| **Cherry Studio**                   | Settings → MCP Servers → Add → Streamable HTTP → the URL                              |
| **CommandCode**                     | `.agents/skills/` is auto-discovered; add the MCP server URL                          |
| **OpenCode**                        | `.opencode/opencode.jsonc` — add the URL under `mcp`                                  |
| **Vercel**                          | Deploy the MCP server itself (see below)                                              |

---

## Platform detail

### Claude Code — full plugin

Manifest: `.claude-plugin/marketplace.json` → `plugins/opengeo/`. Ships skills + MCP with OAuth
2.1. This is the most complete integration we ship.

### ChatGPT — app + plugin

`chatgpt-app-submission.json` is the **Apps SDK submission manifest** (schema
`chatgpt-app-submission.v1`). It declares per-tool `annotations` and `justifications`, which the
directory requires for approval.

**How it connects:** ChatGPT reaches the server as a **remote MCP server** via `server_url`, or, for
our production endpoint, we ship it as a **plugin** (MCP server + skills, optionally with UI).
OpenAI's docs: _"Build an MCP server"_ and _"Package your plugin"_ under platform.openai.com/plugins.

**Two current facts worth knowing `[V 2026-09-28]`:**

- The old built-in `connector_id` mechanism is **deprecated for models released after 1 Sep 2026**.
  We use `server_url`, not a connector.
- OpenAI recommends `allowed_tools` to trim a large tool surface (cost + latency), and
  `defer_loading: true` so tool definitions are only loaded when needed. We should use both once the
  GEO tools land.

**Security note we take seriously:** with a remote MCP server, OpenAI's default is to require
approval per tool call. We keep it on for anything that spends money.

### Codex

`.codex-plugin/plugin.json` declares `skills` and `mcpServers`, plus an `interface` block
(`displayName`, `shortDescription`, `defaultPrompt`, `category`) that Codex surfaces to users. Codex
also reads skills from `.agents/skills/` at one directory level, which is where our
`opengeo`/`geo-audit`/`what-to-build` skills live.

### Cursor

`.cursor/mcp.json` is committed at the repo root. The plugin manifest is
`plugins/opengeo/.cursor-plugin/plugin.json`.

### Antigravity CLI (formerly Gemini CLI) — **important `[V 2026-09-28]`**

**Gemini CLI was replaced by Antigravity CLI on 18 June 2026.** Antigravity preserves backward
compatibility with Gemini CLI constructs, including the `gemini-extension.json` manifest, so:

```bash
# Antigravity CLI
agy extensions install https://github.com/RatioArtificiosa/Open-GEO
```

Our extension manifest is `plugins/opengeo/gemini-extension.json`. It points at the MCP server and
declares settings. Skills are discovered from `.agents/skills/`.

**Worth knowing:** Antigravity's onboarding automatically migrates existing Gemini CLI extensions and
skills, so users coming from Gemini keep their setup.

### Grok / Grok Build

xAI ships **Remote MCP Tools** — Grok connects to an external MCP server by URL. We add
`https://app.opengeo.so/mcp` as a remote MCP server. Grok also has **Grok Skills** (`SKILL.md`
format, Claude-compatible), so our skills directory works there too.

### Cherry Studio

Add as a **Streamable HTTP** MCP server with the URL. No local install needed.

### CommandCode

Discovers `.agents/skills/` automatically (that is where the design and research skills live). Add
the MCP server URL for the data tools.

### Vercel — hosting the MCP server `[V 2026-09-28]`

Vercel supports deploying MCP servers with `mcp-handler`. For anyone who wants to self-host the
_hosted_ app's MCP endpoint on Vercel rather than Cloudflare:

```bash
pnpm i mcp-handler@2.1.1 @modelcontextprotocol/server@2 zod@4
```

`mcp-handler` v2 uses `@modelcontextprotocol/server` (not the `sdk`), changes tool registration,
and drops legacy HTTP+SSE. Clients connect over **Streamable HTTP**. Add OAuth with `withMcpAuth` and
expose `/.well-known/oauth-protected-resource` for spec-compliant discovery.

**Recommendation:** our _default_ hosted deployment stays on Cloudflare Workers (edge-native, matches
the rest of the app). Vercel is a fully supported **alternative** for the MCP endpoint and the web
app, and we document it as such rather than pretending Cloudflare is the only path.

---

## The one rule for every platform

**The MCP server is the product surface; skills are the ergonomics.** Tools do the work; skills teach
the model how to sequence them and report honestly. Any platform that speaks MCP gets the tools.
Any platform that reads `SKILL.md` gets the workflows.

## What we should still do `[D]`

1. Publish the OpenGeo plugin to the ChatGPT directory (needs the hosted app live + an OpenAI
   developer account).
2. Publish the Antigravity extension to the official gallery.
3. List the MCP server in the community MCP directories.
4. Add an `openai.yaml` to skills that benefit from Codex-specific UI hints.
5. Re-verify every claim on this page each quarter — agent platforms ship breaking changes fast.
