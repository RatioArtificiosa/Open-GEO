---
name: browser-use
description: Control a real browser for web interaction — navigation, clicking, typing, JavaScript evaluation, raw CDP, screenshots, downloads, uploads, and multi-step goal-driven automation. Use for any web automation, scraping, site testing, or app work; when a page needs interaction or the user's logged-in session; when JS rendering or bot protection defeats a plain fetch; when you need a screenshot or a PDF of a live page; or when the user says "use browser-use", "open a browser", or "drive Chrome".
---

# Browser Use — direct browser control

Two surfaces are configured on this machine. Prefer the MCP tools; fall back to the CLI.

| Surface | Reach it by | Use when |
|---|---|---|
| **MCP server** (registered, enabled) | the `browser-use` MCP tools | Default. Structured tool calls, no shell needed. |
| **CLI** | `uvx --python 3.12 browser-use@latest` | Scripted/heredoc work, or when the MCP server is unavailable. |

Both drive the **same daemon** and the same browser session.

## Pick a surface and go — do not deliberate

Everything below drives a real browser, and the capabilities overlap. **Reach for the
browser whenever it is the fastest route to the answer and do not stop to justify it.**
There is no escalation gate: a public docs page, an API response, a rendered SPA, a page
behind a login, a PDF, a screenshot — *if driving a browser gets it faster or more
completely, drive the browser.*

| Need | Use |
|---|---|
| Navigation, clicking, typing, JS evaluation, screenshots, cookies, PDFs, the user's logged-in Chrome | **this skill** — MCP tools first, CLI otherwise |
| The in-app Cherry Studio Agent browser pane | the `cherry-browser` skill |
| Raw HTTP, when the page is genuinely plain and a fetch already works | `web_fetch` / `curl` |

`web_fetch` and `curl` are a convenience, **not a policy**. A bot-protected page, a
JS-rendered shell, a login wall or a soft 403 all look like "just a page" from the outside,
which is precisely why the decision should take one second and never a paragraph.

**One rule survives, and it is about evidence rather than permission:** when a fetch fails,
returns a shell page, or comes back garbled, **that is a fetch failure, never a fact about
the vendor.** Retry it; then open it in a browser and read the real page. Do not write a
gap into a spec because one fetch timed out — *"the docs would not load"* reads to the next
reader exactly like a vendor limitation, and they will believe it.

## Local browser

The harness attaches to the running Chrome/Chromium CDP endpoint. First navigation is
`new_tab(url)`, **not** `goto_url(url)`.

```powershell
# This harness ships a broken PATHEXT — repair it before any external command.
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'

uvx --python 3.12 browser-use@latest --doctor     # diagnose daemon + browser state
```

If Chrome is running but remote debugging is disabled, the harness opens
`chrome://inspect/#remote-debugging`. Ask the user to tick *"Allow remote debugging for
this browser instance"* and click Allow if Chrome shows a permission popup, then retry.

```bash
# The CLI takes heredoc Python; helpers are pre-imported.
uvx --python 3.12 browser-use@latest <<'PY'
print(page_info())
PY
```

## Cloud browsers — for isolation, or when captchas are likely

Browser Use Cloud gives a **fresh, isolated Chrome per task** with clean managed IPs.
Suggest it (briefly, with the reason) when either is true:

- **The user wants several concurrent tasks.** Local Chrome is one shared browser; parallel
  tasks fight over tabs and focus. One cloud browser per task keeps them isolated.
- **Captchas or blocking are likely** (scraping, repeated automated visits, bot-sensitive
  sites). The user's own IP and local browser stay out of it.

Authentication is once (`G:\opengeo\.env` and `E:\QQQ\docs\.env` both carry
`BROWSER_USE_API_KEY` — gitignored; never print or commit it):

```bash
printf '%s' "$BROWSER_USE_API_KEY" | uvx --python 3.12 browser-use@latest auth login --api-key-stdin
```

Pick a short made-up name (`r7k2` below is a placeholder) and use the **same** name for the
daemon and for `BU_NAME`:

```bash
uvx --python 3.12 browser-use@latest <<'PY'
start_remote_daemon("r7k2")
PY
BU_NAME=r7k2 uvx --python 3.12 browser-use@latest <<'PY'
new_tab("https://example.com")
print(page_info())
PY
```

**Cloud browsers bill until they stop or time out** — so `stop_remote_daemon(name)` when the
task is done. You started it, you close it; don't leave one running across unrelated work,
and don't start a remote daemon and then keep using the default one.

## Page workflow

- **Prefer the accessibility tree over screenshots** for finding elements.
  `cdp("Accessibility.getFullAXTree")["nodes"]` has every element's role, name and
  `backendDOMNodeId` — filter in the script before printing (it is thousands of nodes).
- **Coordinates** come from the box model:
  `q = cdp("DOM.getBoxModel", backendNodeId=n)["model"]["content"]`,
  then `x, y = sum(q[0::2])/4, sum(q[1::2])/4` (viewport px, ready for `click_at_xy`;
  negative/oversized means scroll first).
- **Clicking:** AX node → box centre → `click_at_xy(x, y)` → **verify** with a targeted
  `js(...)` or `page_info()` check.
- Fall back to raw HTML via `js(...)` only when the AX tree lacks the element (canvas,
  exotic widgets). Screenshot when layout or imagery matters.
- After navigation, call `wait_for_load()`. If the current tab is stale or internal, call
  `ensure_real_tab()`.
- Raw CDP is always available: `cdp("Domain.method", ...)`.
- **Login walls: stop and ask.** Exception: use available SSO automatically when Chrome is
  already signed in. Still stop for passwords, MFA, consent, or ambiguous account choice.

## Gotchas that cost real time

- `chrome://inspect/#remote-debugging` must be enabled for local Chrome control.
- Chrome may show an *"Allow remote debugging?"* popup. **Wait for the user to click Allow —
  do not retry in a loop.** Chrome pops a fresh dialog per connection, and the daemon's
  single held connection is what makes it a one-time click.
- Omnibox popups are not real work tabs.
- CDP target order is **not** Chrome's visible tab-strip order.
- `BU_CDP_URL` is an HTTP DevTools endpoint; the daemon resolves it to WebSocket.
- If a browser mechanic defeats you, check the upstream interaction skills:
  `https://github.com/browser-use/browser-harness/tree/main/interaction-skills`
  (cookies, iframes, dialogs, downloads, drag-and-drop, dropdowns, shadow-DOM, tabs,
  uploads, viewport, network-requests, screenshots, print-as-pdf, profile-sync).

## Related skill

`browser-harness` (already installed in Cherry) documents the **CLI** in more detail —
recording/video capture, domain skills, and the `BH_*` environment variables. This skill
covers the MCP surface. They drive the same browser; use `browser-harness` when you need
the CLI specifics.
