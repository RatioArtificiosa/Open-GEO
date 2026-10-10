---
name: desktop-commander
description: Drive this machine through the Desktop Commander MCP server — persistent shells and REPLs that survive across turns, interactive processes (dev servers, SSH, databases, watch modes), filesystem search across large trees, diff-based file editing (edit_block), and structured readers for Excel/PDF/DOCX. Use when a task needs a shell whose state persists between turns, when the built-in pwsh tool cannot start a background process, when you need surgical multi-line edits, or when the user says "use desktop commander".
---

# Desktop Commander MCP

A real shell and filesystem on this computer, exposed as MCP tools. The difference from
the built-in `pwsh` tool is that **state survives across turns**: you can start a dev
server, keep a REPL open, drive an interactive process, and read from it later.

**Installed and enabled on this machine:** `@wonderwhy-er/desktop-commander` **v0.2.51**
(26 tools), launched via `npx -y @wonderwhy-er/desktop-commander@latest`.

## Why this exists here specifically

The built-in `pwsh` tool in this harness has **two hard limits** that Desktop Commander
covers:

1. **No background processes.** `tool-pwsh` is configured `enableRunInBackground: false`.
   So a long-running command — a CodeRabbit review, a dev server, `graf watch` — cannot be
   launched and polled. Start it through Desktop Commander instead and poll it with a
   follow-up call.
2. **No persistent shell.** Every `pwsh` call is a fresh shell, so a REPL, an SSH session,
   or an activated virtualenv cannot be carried between turns.

It does **not** fix the `PATHEXT` defect (that is an environment variable in the spawned
shell) — repair that inside whatever shell you use:

```powershell
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'
```

## Tool inventory (26)

Grouped by what they are for:

| Group | Tools |
|---|---|
| **Terminal / process** | `start_process`, `interact_with_process`, `read_process_output`, `force_terminate`, `list_sessions`, `kill_process` |
| **Filesystem** | `read_file`, `read_multiple_files`, `write_file`, `edit_block`, `move_file`, `create_directory`, `list_directory`, `get_file_info` |
| **Search** | `search_files`, `search_code` |
| **Structured files** | `read_excel`, `read_pdf`, `read_docx` (and write equivalents) |
| **Config** | `get_config`, `set_config_value`, `list_allowed_directories` |

## ⚠️ `start_process` requires `timeout_ms`

It is a **number**, and omitting it fails with a bare schema error rather than a useful
message. Always pass it:

```json
{ "command": "python", "args": ["--version"], "timeout_ms": 10000 }
```

## The edit-block format

`edit_block` is a surgical, diff-style replace — it does not rewrite the whole file, so it
is safer than `write_file` for a small change in a large file.

```text
<<<<<<< SEARCH
exact existing text
=======
replacement text
>>>>>>> REPLACE
```

Rules that matter: the SEARCH block must match **exactly** (including whitespace and line
endings), and it must be **unique** in the file or the edit is refused. For a repeated
block, include enough surrounding context to make it unique.

## Persistent-shell pattern

```text
1. start_process  { "command": "cargo", "args": ["run","--","dev"], "timeout_ms": 5000 }
      → returns a PID / session id
2. (do other work across turns)
3. read_process_output { "pid": <pid> }        → incremental output since last read
4. interact_with_process { "pid": <pid>, "input": "..." }   → for REPLs
5. force_terminate { "pid": <pid> }            → ALWAYS clean up
```

Always terminate what you start. An abandoned process holding a bind mount or a lock is
the failure this pattern exists to avoid.

## Safety — read this before using it

**Desktop Commander is not a sandbox.** Its own documentation is explicit: the
`allowedDirectories` setting restricts **file operations only**, while **terminal commands
can still reach outside those directories**, and the process runs with your full user
permissions.

Treat it as **equivalent to the shell access you already have — no broader.** Every
project rule still binds:

- Never print, commit or echo the contents of `E:\QQQ\docs\.env` (live credentials).
- Never commit review transcripts or scratch output into a repository.
- A destructive operation needs the same approval it would need anywhere else; do not use
  "the tool allowed it" as the reason it was safe.

## Transport gotcha (recorded, because it recurs)

MCP tool search does not always surface this server's tools even when it is healthy. If
the tools do not appear in a listing, drive the server directly over stdio rather than
concluding it is broken — that is how it was first verified on this machine
(`list_directory` on `E:\QQQ\crates` returned the real listing; `edit_block` changed a file
on disk; `start_process` ran `python --version` → `Python 3.13.2`).

## When to reach for it — and when not to

**Use it for:** long-running processes, watch modes, REPLs, SSH sessions, interactive
installers, searching a very large tree, reading Excel/PDF/DOCX, and surgical edits.

**Do not use it for:** anything the purpose-built tools already do better. Prefer the
native `read` / `write` / `edit` tools for ordinary file access (they respect the
workspace policy and give line numbers), and prefer `pwsh` for one-shot commands — it is
lower-latency and its output is captured for you.
