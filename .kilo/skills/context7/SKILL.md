---
name: context7
description: Retrieve up-to-date, version-specific documentation, API references and code examples for any developer library, framework, SDK, CLI tool or cloud service. Use whenever the user asks about a specific library or API — even well-known ones like React, Next.js, Prisma, Express, Tailwind, Wasmtime, Tokio, rustls, Django or Spring Boot — because training data goes stale and APIs change. Use for API syntax questions, configuration options, version-migration issues, "how do I" questions naming a library, library-specific debugging, setup instructions, and CLI tool usage. Prefer this over web search for library documentation and API details. Also use when the user says "check the docs", "look up the latest", or "find-docs".
---

# Documentation lookup — Context7

Your training data has a cutoff. Wasmtime, Tokio, rustls, React and Next.js all move;
a remembered API shape may be wrong. Context7 serves **current** documentation for a
named library, with version pinning.

## Two ways to reach it — both are configured on this machine

| Route | How | When |
|---|---|---|
| **MCP server** (preferred) | Tools `context7` → `resolve-library-id`, `get-library-docs` | Installed and enabled. Use directly; no shell needed. |
| **CLI** | `npx ctx7@latest library <name> "<query>"` then `npx ctx7@latest docs <libraryId> "<query>"` | When you need it in a shell, or the MCP server is unavailable. |

### MCP workflow

1. `resolve-library-id` with the library name **and** a query describing what you need.
2. `get-library-docs` with the returned `/org/project` (or `/org/project/version`) id and
   a focused query.

### CLI workflow

```powershell
# This harness ships a broken PATHEXT, so external commands need it repaired first.
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'

# Step 1 — resolve the library to an ID
npx ctx7@latest library "Wasmtime" "how to configure epoch interruption"

# Step 2 — query docs with that ID
npx ctx7@latest docs /bytecodealliance/wasmtime "epoch interruption and fuel limits"
```

You **must** call `library` first to obtain a valid ID unless the user already gave one
in `/org/project` or `/org/project/version` form. Run at most **3** lookups per question;
if three fail, answer with the best result you have and say it was truncated.

**Authentication.** Both routes work unauthenticated. `E:\QQQ\docs\.env` holds
`CONTEXT7_API_KEY` and `CONTEXT7_MCP_URL` (gitignored — never print, commit or echo it).
To raise rate limits on the MCP server, add an `Authorization` header carrying that key.
On the CLI: `npx ctx7@latest login`, or set `CONTEXT7_API_KEY` in the environment.

## Writing good queries

The query directly affects result quality. Be specific, and keep each query to **one
topic** — if the question spans distinct concepts, run a separate query per concept
(unless the question is genuinely about how they interact).

| Quality | Example |
|---|---|
| Good | `"How to set up authentication with JWT in Express.js"` |
| Good | `"Wasmtime epoch_interruption with async host functions"` |
| Bad (too vague) | `"auth"` |
| Bad (too broad) | `"routing and auth and caching in Next.js"` |

Describe what to look up **in the library's documentation**, not the task to complete.
Use the official name with proper punctuation (`Next.js`, not `nextjs`; `Three.js`, not
`threejs`); if results look wrong, try alternates such as `next.js` before changing the query.

## Result fields worth using

- **Library ID** — `/org/project`, or `/org/project/version` when pinned
- **Code Snippets** — count of available examples; prefer libraries with more
- **Source Reputation** — High / Medium / Low / Unknown
- **Benchmark Score** — quality indicator, 100 is the maximum
- **Versions** — use one of these when the user names a version

## When NOT to use this

- You can answer locally: `cargo doc --open`, the vendored source in
  `~/.cargo/registry/src/…`, `cargo tree -i <crate>`, `node_modules`.
- The question is about **this repository** — use the repo's own docs (`llms.txt`,
  `docs/AGENT-HANDBOOK.md`, the Proposal/Checklist/Observations corpus in QQQ).
- It would tempt you to **upgrade a pinned dependency**. QQQ pins Wasmtime 48 on purpose
  (`§D-003`); an engine upgrade is a scheduled activity with its own checklist item, not a
  side effect of a documentation lookup.

## Error handling

- **Quota exhausted** ("Monthly quota reached" / "quota exceeded"): tell the user their
  Context7 quota is spent, suggest authenticating for higher limits, and — if they decline
  — answer from training knowledge while saying plainly that it may be outdated.
- **DNS / network errors** (`ENOTFOUND`, host resolution failures, `fetch failed`):
  rerun outside the sandbox rather than retrying inside it.
- **Never silently fall back to training data.** Always say why Context7 was not used.

## Common mistakes

- Library IDs need the `/` prefix — `/facebook/react`, not `facebook/react`.
- Always `library` first; `docs react "hooks"` fails without a valid ID.
- One topic per query; split multi-concept questions.
- Never put API keys, passwords, credentials, personal data or proprietary code in a query.
