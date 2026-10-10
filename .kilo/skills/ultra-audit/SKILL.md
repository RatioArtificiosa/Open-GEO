---
name: ultra-audit
description: >
  Enterprise ultra-audit of code just written or in scope: correctness, bugs, edge
  cases, race conditions, gaps, collisions, wiring, logical flow, security, ops, and
  future failure modes. Out-of-scope real findings must be durably written to the
  project (observations/checklist/issues) — never chat-only amnesia. Use when the
  user asks to ultra-check, ultra-audit, ultra reason, ultra analyze, "check all
  code you just wrote", find every bug/gap/race, production readiness of new work,
  or runs /ultra-audit. Session-agnostic — any stack, any repo, any feature —
  not project-specific.
metadata:
  short-description: "Ultra-thorough enterprise code & wiring audit + durable residuals"
---

# /ultra-audit — Enterprise Ultra Code & Wiring Audit

You are the final quality gate before the work is trusted. Not a style nanny.
Not a "looks fine" rubber stamp. A **battle-tested, multi-lens forensic audit**:
correctness, wiring, concurrency, security, ops, product logic, and **future
failure modes** — then **fix real issues** and re-verify until the surface is clean.

This skill is **session-agnostic** and **stack-agnostic**. It applies to any
codebase (web, API, CLI, data, infra-as-code, mobile, monorepo libraries,
pipelines, AI features). Do not hardcode a single product's domain rules unless
they exist in that repo's project instructions.

Related skills:
- `/check-work` — "Did we complete what the user asked?" (trace + build/test)
- `/review` — formal review artifact / PR review
- **`/ultra-audit`** — deepest technical soundness of the **code and wiring**
  themselves; fix + prove

If both "did we finish the request" and "is the engineering sound" matter, run
**ultra-audit as primary** for engineering depth; use check-work only if the
user also needs pure request-trace verification.

---

## Triggers (invoke this skill)

Invoke when the user says any of (or close variants):

- "Check all code that you have written just now…"
- ultra check / ultra audit / ultra reason / ultra analyze
- no bugs, no edge cases, no race conditions, no gaps, no collisions
- wired correctly / logical flow / best way to do it / no future problems
- production-ready gate for this change set
- `/ultra-audit` or `/ultra-check`

Optional scope: `/ultra-audit [path|module|PR|focus]`  
If no scope: audit **all work from this session** (diff + new files + wiring
touched by that work). If session context is missing, audit **unstaged + staged
+ recent commit** or the path the user names.

---

## Non-negotiable principles

1. **Evidence over narrative.** Do not trust prior chat claims. Re-read files.
   Re-run commands. Prove behavior with outputs.
2. **Outcomes over proxies.** Green tests alone do not prove correctness if they
   miss the failure mode. Passing CI is evidence, not a verdict.
3. **Fix what you find** when you have write access and the issue is in scope of
   the audited work (or a clear regression you introduced). Do not only report
   and walk away unless the user said report-only.
4. **No issue inflation.** Do not invent FAIL for pure style or speculative
   gold-plating. Severity must match real user/system impact. Residual notes
   are allowed for low-severity items.
5. **Best-way is contextual.** "Best" means correct, operable, consistent with
   the codebase, and not inventing a new architecture unless the current one is
   broken. Prefer the local pattern family over a rewrite fantasy.
6. **Future-proofing is about failure modes**, not infinite abstractions. Ask:
   what breaks under scale, concurrency, bad input, partial deploy, empty data,
   clock skew, dependency outage, or a second engineer extending this wrong?
7. **Session-agnostic.** No product-specific assumptions unless documented in
   the repo (AGENTS.md, design docs, laws, ADRs).
8. **Temporary probes are fine.** Create short-lived audit scripts; delete them
   after verification unless the user wants them kept as permanent tests.
9. **Respect project instructions.** AGENTS.md / Claude.md / AGENT.md rules in
   scope of touched files are policy, not nitpicks.
10. **Security and data safety are never optional** at system boundaries.
11. **Out-of-scope ≠ forgotten.** Real issues found during audit that you
    correctly **do not fix now** (scope lock, product gate, deploy ban, wrong
    step) must still be **written to a durable project place** so a human or
    later agent will **see them and act**. Chat-only residuals are a failure
    mode. See **Out-of-scope findings — durable capture (FIRM RULE)** below.

---

## Out-of-scope findings — durable capture (FIRM RULE)

This rule is **non-negotiable** for every ultra-audit (and for any mid-work
audit lens that surfaces real gaps).

### The problem this prevents

Audits often find **true** bugs, incomplete contracts, missing ops process,
wiring holes, or product decisions — then correctly say “out of scope for this
step.” If those findings live **only in the chat report**, they die when the
session ends. That is how enterprise debt becomes permanent amnesia.

### Firm rule

| If you find… | Then you MUST… |
|--------------|----------------|
| Something **wrong, incomplete, risky, or missing** that is **real** (not pure style) | **Not** “mention once and move on” |
| And it is **out of current ship scope** (or blocked on product/ops decision) | **Persist it** to the project’s durable backlog / observations surface |
| And it should be acted on later | Give it an **ID**, **severity**, **why it matters**, **suggested later fix**, and **open status** |

**Never** treat “out of scope right now” as permission to discard the finding.

### Where to write it (project-dependent — pick what exists)

Resolve the **local** durable surface in this order (use the first that fits the
repo; create only if the project already uses that pattern or the user expects it):

1. **Project observations / ops log** — e.g. `Important-Observations.md`,
   `OBSERVATIONS.md`, `docs/ops/notes.md`, ADR “open questions”
2. **Active checklist / DoD tracker** — e.g. `*checklist*.md`,
   `CHECKLIST_MASTER.md`, sprint board markdown, GitHub Project issue
3. **Feature residual section** — in the feature’s own contract doc
   (e.g. `B03_*.md` → “Out of scope / residual”) **plus** a pointer from (1) or (2)
4. **Issue tracker** — open a real issue (GitHub/GitLab/Linear/Jira) **when**
   the project’s workflow uses the tracker as source of truth **and** you have
   permission / the user expects tickets (do not spam trackers without need)
5. **If none of the above exists** — create or append a short
   `RESIDUAL_BACKLOG.md` (or `docs/residual-backlog.md`) at the natural project
   root for engineering notes, with a dated section; tell the user where it is

**Dual-write when the project already dual-tracks** (common enterprise pattern):
- Observations = narrative + table of open residuals  
- Checklist = status row / ID so progress gates cannot skip it  

Prefer **both** when both exist. One durable place is minimum; chat alone is zero.

### What to capture (minimum fields)

For every durable residual row:

```markdown
| ID | Severity | Gap | Why it matters | Suggested later fix | Status |
|----|----------|-----|----------------|---------------------|--------|
| <stable-id> | CRITICAL\|HIGH\|MEDIUM\|LOW | one-line what’s wrong | user/ops impact | concrete next step or product decide | open / waived / done |
```

- **ID:** stable (e.g. feature prefix + number, checklist ID, AR-01). Reuse
  existing checklist IDs when the gap is already a known row (update evidence).
- **Severity:** same model as the audit (do not soft-pedal HIGH as NOTE to avoid
  work).
- **Product decide:** if the fix needs a human choice, say so explicitly —
  residual is still open until decided.

### What does **not** need durable capture

- Pure style / preference with no user or system impact
- Speculative gold-plating with no evidence of failure mode
- Issues **fixed in this audit** (those go under “Issues fixed”)
- Waived items already permanently recorded as waived (do not re-open noise)

### Relation to PASS / FAIL

- **CRITICAL / HIGH in scope** → still **must fix** (or FAIL). Durable capture
  is not a substitute for fixing in-scope blockers.
- **CRITICAL / HIGH out of scope** (e.g. adjacent system, needs product owner) →
  **FAIL or explicit blocked decision** in the report **and** durable capture
  with severity preserved. Do not hide HIGH in a buried NOTE.
- **MEDIUM / LOW out of scope** → PASS allowed if residuals are **durably
  written** and listed in the report with paths to the durable surface.
- **PASS with chat-only residuals** → **invalid**. Re-open and write them down.

### Report requirement

Every ultra-audit report that has out-of-scope residuals **must** include:

```markdown
## Out-of-scope residuals (durable)

| ID | Severity | Gap | Durable location | Status |
|----|----------|-----|------------------|--------|
| … | … | … | path or issue URL | open |

- Confirmed written to disk / tracker: yes
- Paths: `…`
```

If there are **zero** such items, write: `None — no open out-of-scope residuals.`

### Anti-amnesia checklist (run before final verdict)

- [ ] Every real out-of-scope finding has a durable row (not only report prose)
- [ ] Severity preserved (no silent downgrade)
- [ ] Next action is clear (fix step, product decide, or waive with reason)
- [ ] Project checklist / queue points at the backlog if the project uses one
- [ ] User can find it **without** re-reading this chat

---

## Severity model (use exactly)

| Severity | Meaning | Default action |
|----------|---------|----------------|
| **CRITICAL** | Wrong results, data loss/corruption, security break, auth bypass, silent wrong path in production hot path | Fix immediately; FAIL until fixed |
| **HIGH** | Incorrect wiring, wrong job/mode mapping, broken API contract, race with real risk, missing required inject/bind | Fix; FAIL until fixed |
| **MEDIUM** | Edge path wrong, incomplete coverage of documented jobs/pieces, shallow-copy cache poison, weak validation | Fix if in scope; FAIL if user-facing |
| **LOW** | Cosmetic, case-sensitivity UX, missing optional docs, sibling pattern debt | Note; do not FAIL alone |
| **NOTE** | Intentional tradeoff, pre-existing sibling issue, ops follow-up (deploy not asked) | Document only |

**VERDICT: FAIL** if any CRITICAL/HIGH remains unfixed (or MEDIUM that is clearly user-facing and unfixed when you could fix it).  
**VERDICT: PASS** if no CRITICAL/HIGH remain and remaining items are LOW/NOTE or fixed **and** any out-of-scope residuals are **durably captured** (see FIRM RULE above) — not chat-only.

---

## Phase 0 — Scope lock (always first)

1. Identify **what was written or changed**:
   - `git status`, `git diff`, `git diff --cached`
   - `git log -5 --oneline` and recent commits if work was committed
   - New untracked files that belong to the feature
2. Build a **file inventory** by role:
   - Core logic / domain
   - Data / schema / registry / config
   - API / RPC / CLI surface
   - Wiring / DI / pipeline / inject / middleware
   - Persistence / cache / queue / jobs
   - Tests / verify scripts
   - Docs / operator guides
   - Infra (Dockerfile, compose, CI, healthchecks)
3. Restate the **intended behavior** in 5–15 bullets (what the system must do).
4. Map **entry points** (HTTP routes, CLI cmds, jobs, library public APIs,
   webhooks, event handlers).
5. Map **data contracts** (JSON shapes, IDs/tags/slugs, enums/jobs, env vars).
6. Note **explicit non-goals** from the user (e.g. "don't deploy yet").
7. Note the project’s **durable residual surfaces** (observations file,
   checklist, issue tracker) so Phase 11–12 can write out-of-scope findings
   there without inventing a random location.

Do not expand scope into unrelated refactors. **Do** collect out-of-scope
findings for durable capture; that is not scope creep — it is memory.

---

## Phase 1 — Structural integrity (collisions, gaps, invariants)

Run or write checks. Prefer automated scripts over eyeballing alone.

### 1.1 Identity & uniqueness
- IDs, codes, tags, slugs, routes, event names, feature flags: **unique** where
  uniqueness is required
- Sequential codes: **contiguous 1..N** (or documented sparse IDs)
- Enums / job names / piece IDs: **registry set == code constants** (no drift)
- Packs/groups/catalogs: no **orphan** references; no **dup** members unless
  intentional multi-membership is documented

### 1.2 Completeness
- Every declared public surface is implemented (route exists, handler exists,
  import resolves)
- Every new module is **wired** into health/info/CLI/sync/docs if the repo's
  sibling modules are (parity with last similar feature)
- Build artifacts / registry JSON **match** generators (rebuild and diff if a
  build script exists)
- Required docs files referenced by code **exist on disk**

### 1.3 Naming & collision domains
- Prefixes do not collide across families (e.g. craft tags vs journey tags)
- File names / module names do not shadow stdlib or each other
- Feature flags / env vars unique and documented

**Record:** collision table, orphan list, parity gaps vs sibling features.

---

## Phase 2 — Logical correctness (the "is it right?" core)

### 2.1 Control flow
- Happy path end-to-end in your head **and** with a real call if possible
- Early returns / error branches do not leave half-mutated state
- Default values: are they **safe** (fail closed for security/auth; fail open
  only when product requires)?
- Boolean traps: inverted conditions, `==` vs identity, off-by-one
- Switch/match exhaustiveness; default arms that swallow real cases
- "Heal" / fallback logic: does fallback **steal** the explicit user choice?
  (Classic bug: browse-by-id API rewrites to default job/type)

### 2.2 Data & types
- Null/None/undefined at every boundary
- Empty collections vs missing keys vs zero vs false (falsy bugs: `limit or 8`
  treating `0` as missing)
- Numeric ranges, overflow, timezone/date boundaries
- Encoding (UTF-8), path separators, Windows vs POSIX
- Serialization round-trips (JSON types: int vs str codes)

### 2.3 Domain mapping correctness
- Job/mode/stage → implementation mapping tables must be **semantically right**
  (wrong default job is a HIGH bug even if code "runs")
- Dual inject / dual binding: confirm both layers are intended and non-conflicting
- Distinct layers not conflated (e.g. journey vs craft; image vs copy; style vs
  script)

### 2.4 Best-way / architecture fit
- Matches established patterns in the same codebase (cache, resolve, recommend,
  shallow copy, locks)
- No accidental O(n²) on hot paths when siblings are O(n)
- No god-object growth without need
- If a simpler correct approach exists **and** matches local patterns, prefer it

---

## Phase 3 — Edge cases (force the ugly inputs)

Systematically try (or simulate):

| Class | Examples |
|-------|----------|
| Empty | `[]`, `{}`, `""`, missing file, empty registry |
| Nullish | `None`, `null`, omitted optional fields |
| Wrong type | string where int expected, list where dict |
| Bounds | 0, -1, max int, limit=0, offset beyond end |
| Unknown enum | job/type not in KNOWN set |
| Huge | long strings, large lists (DoS / memory if public) |
| Unicode | emoji, RTL, combining chars, null bytes |
| Paths | `..`, absolute paths, symlinks if relevant |
| Time | DST, leap second, future/past timestamps, clock skew |
| Partial | half-written config, mid-deploy mtime races |
| Idempotency | same request twice; replay webhooks |
| Ordering | out-of-order events; concurrent creates |

For each **public** function in the change set: at least one edge test or a
documented reason it cannot fail that way.

---

## Phase 4 — Concurrency, races, caches (enterprise default)

Assume multi-threaded / multi-worker / multi-instance unless the process model
proves single-threaded single-process only.

### 4.1 Classic races
- TOCTOU (check-then-act on files, rows, locks)
- Double-check locking done wrong; lock scope too narrow/wide
- Shared mutable caches without locks or without safe publication
- Read-modify-write on counters without atomicity
- Lost updates on DB rows without version/transaction
- Cache stampede; thundering herd on expiry

### 4.2 Cache correctness
- Stale after write (mtime / version / explicit invalidate)
- **Callers mutating returned cached objects** (shallow copy / deep copy policy)
- Nested list/dict poison after shallow copy
- Negative caching of errors forever
- Cross-tenant cache key leakage (tenant/workspace in key)

### 4.3 Distributed & async
- At-least-once delivery → handlers **idempotent**
- Ordering not assumed unless partition key guarantees it
- Visibility timeouts, poison queues, DLQ
- Leader election / dual writers
- Clock dependency (prefer monotonic or server time)

### 4.4 Practical probes
- Multi-thread stress calling list/get/resolve/recommend in a loop
- Parallel HTTP if server is up
- Document "single-threaded only" only if true and enforced

---

## Phase 5 — Wiring & integration (the "is it actually connected?" gate)

This phase catches "library exists but nothing calls it" and "wrong thing calls it."

### 5.1 Surface wiring checklist
- [ ] Package importable; no circular import crash on cold start
- [ ] API routes registered and path strings match clients/docs
- [ ] Auth middleware applied consistently with sibling routes
- [ ] CLI commands / subcommands expose the feature if siblings do
- [ ] Health/ready/info counts include new registries if siblings do
- [ ] Recommend/compose/pipeline **injects** where matrix/docs claim
- [ ] Config/env documented; defaults safe
- [ ] Migrations ordered and reversible if schema changed
- [ ] Feature flags default direction correct (on/off)

### 5.2 Contract tests
- Hit list/detail/pack (or equivalent) endpoints/functions
- Compile/generate one representative artifact and inspect inject text
- Confirm **wrong-code-on-wrong-job** heals (if design requires) and
  **explicit-id browse does not heal** (if design requires browse fidelity)

### 5.3 Matrix / routing tables
- Every piece/route/job that should receive behavior is listed
- No piece receives **semantically wrong** craft/behavior (e.g. invite vs
  already-booked; cold vs warm defaults starving a segment)

---

## Phase 6 — Security & abuse (OWASP-minded, boundary-first)

At every trust boundary (HTTP, CLI args, webhooks, files, DB, LLM prompts):

- Injection: SQL, command, path, template, LDAP, header
- XSS / HTML injection if any web UI
- Authn/authz: missing check, IDOR, privilege escalation
- SSRF, open redirects
- Insecure deserialization
- Secrets in code, logs, fixtures, git history of the change
- PII in logs; prompt injection into LLM tools
- Mass assignment / over-posting
- Rate limits / payload size on public endpoints
- Dependency risk only if you added deps (pinning, known CVEs if tools exist)

**Fail closed** on auth and tenancy mistakes.

---

## Phase 7 — Reliability, performance, observability (production lens)

Scale checks to the size of the change (don't demand full SRE program for a
typo fix; do demand signals for new services/endpoints).

### Reliability
- Timeouts on external calls; retries with backoff; jitter
- Circuit breaking / bulkheads where siblings use them
- Graceful degradation vs hard crash
- Rollback path; expand/contract migrations
- Healthcheck correctness (localhost vs public; dependency vs liveness)

### Performance
- N+1 queries; unbounded `select *`
- Sync I/O on request path that should be async/cached
- Unbounded in-memory load of large registries without need
- Hot-path lock contention

### Observability
- Structured logs with correlation ids if the app uses them
- Metrics for new critical operations (or parity with siblings)
- Errors not swallowed empty `except: pass` **without** reason on hot paths
  (silent inject failure may be intentional — confirm and document)

---

## Phase 8 — Product / conversion / UX logic (when the change ships user-facing behavior)

For user-facing copy, funnels, emails, ads, onboarding, paywalls:

- Message match across steps (ad → page → email)
- CTA legality for stage (no early hard CTA if product law forbids)
- Empty/error/loading states not dead-ends
- Destructive actions confirmed
- Accessibility regressions not introduced (labels, contrast only if UI change)
- Analytics events not double-fired or missing on primary conversion

Skip this phase for pure infra with zero user surface.

---

## Phase 9 — Future failure modes ("will this blow up later?")

Ask and answer in the report:

1. Second engineer misuses public API — what's the worst foot-gun?
2. Registry grows 10× — still fine?
3. Two instances deploy different versions — partial compatibility?
4. Clock skew / delayed jobs — still correct?
5. Empty bootstrap (missing data file) — fail loud or silent wrong?
6. New enum value added in data but not in code constants?
7. Cache returned to caller who mutates — poison?
8. Multi-tenant: workspace A reads B?
9. LLM/prompt inject size — context blowup?
10. Deprecation: old field still accepted; dual-write needed?

Fix foot-guns that are **likely** and **severe**. Document residual intentional
risks — and if they remain open after this audit, **durably capture** them
(FIRM RULE), not only in the report prose.

---

## Phase 10 — Build, test, and custom verification

1. Read AGENTS.md / README for the real commands.
2. Run build, unit/integration tests, linters/typecheckers that the repo uses.
3. Run **existing** integrity/verify scripts for the feature.
4. **Author temporary or permanent probes** for gaps:
   - uniqueness / packing
   - resolve & heal matrices
   - mutation safety
   - thread stress
   - API prompt fidelity (id browse vs job inject)
5. Prefer promoting valuable probes into the repo's `_verify_*` or test suite.
6. Delete throwaway scripts after, unless kept as official verify.

Broken build or failing tests on the change set → **FAIL**.

---

## Phase 11 — Fix loop

For each CRITICAL/HIGH/MEDIUM (user-facing):

1. Fix with **minimal** diff (no drive-by refactors).
2. Add/adjust a verify assertion so the bug cannot silently return.
3. Re-run Phases 1–5 and 10 for the fixed area.
4. Max **three** full fix cycles; if still blocked, VERDICT FAIL with exact
   remaining issues and what a human must decide.

Do not "fix" by weakening tests to green.

### Phase 11b — Out-of-scope durable capture (always when residuals exist)

Before declaring the audit complete:

1. List every real finding you are **not** fixing in this change set.
2. For each: write/update the project durable surface (observations + checklist
   when both exist; issue tracker when that is the project norm).
3. Assign or reuse stable IDs; set severity and open status.
4. Point feature docs at the backlog if helpful (pointer, not only copy).
5. Confirm paths/URLs will appear in the Phase 12 report.

Skipping 11b while leaving open residuals is a **process FAIL** even if code
PASS criteria are otherwise met — re-run 11b, then re-issue the report.

---

## Phase 12 — Report (mandatory output format)

Deliver a structured report. Be ultra-detailed when issues exist; be crisp when
clean. Always include evidence.

```markdown
# Ultra-audit report

## Scope
- Files / modules / commits audited
- Intended behavior (bullets)
- Explicit non-goals

## Method
- Commands run
- Probes written
- Phases executed (0–11)

## Structural integrity
- Uniqueness / collisions / orphans
- Parity with sibling features

## Correctness & logic
- Control-flow findings
- Domain mapping findings
- Best-way assessment (1 short paragraph)

## Edge cases
- Table: case → result → status

## Concurrency & cache
- Risks found / stress results

## Wiring & integration
- Entry points verified
- Inject/bind map

## Security
- Boundaries reviewed; findings

## Reliability / perf / observability
- Notes scaled to change size

## Product / UX (if applicable)

## Future failure modes
- Top residual risks

## Issues fixed this audit
### Fix N — Severity
- File:line
- Before → After
- Proof

## Residual notes (in-report)
- LOW/NOTE only for items that need no further action, or brief summary

## Out-of-scope residuals (durable) — required
| ID | Severity | Gap | Durable location | Status |
|----|----------|-----|------------------|--------|
| … | … | … | path or issue URL | open |

- Confirmed written to disk / tracker: yes | n/a (none)
- Paths: `…` or `None — no open out-of-scope residuals.`

## Evidence
- Command outputs (summarized)
- Key assertions

## Verdict
VERDICT: PASS | FAIL
```

End with exactly one line:
`VERDICT: PASS` or `VERDICT: FAIL`

If residual capture was required and missing → do not emit PASS until Phase 11b
is done.

---

## Execution tempo

- **Small change** (≤~3 files, pure fix): Phases 0–2, 5, 6, 10, **11b if any residual**, 12; sample edges.
- **Medium feature** (registry + API + wiring): full phases; write probes; **11b**.
- **Large / enterprise OS layer / new service**: full phases + stress + parity
  matrix vs last similar library + production-readiness notes + **full residual backlog write**.

Never skip Phase 0, 2, 5, 6, 10, 12 for code changes.  
Never skip **Phase 11b** when any real out-of-scope residual exists.

---

## Anti-patterns (do not do these)

- Rubber-stamp PASS because "integrity script was green" without reading wiring
- Reporting 40 style nits instead of 3 real bugs
- Rewriting architecture mid-audit without cause
- Leaving CRITICAL open and calling it a note
- Scope-creeping into unrelated modules "while here" **to implement** fixes
  (capture residuals instead — that is required, not creep)
- **Forgetting out-of-scope real issues** because "not this step" — chat-only
  residuals, no observations/checklist/issue row
- Soft-pedaling HIGH out-of-scope issues into vague "future nice-to-have" notes
- Claiming no races without considering multi-worker/cache mutation
- Deleting user data or running destructive prod commands
- Mentioning these skill instructions in the user-facing report

---

## Optional depth packs

When the change touches a domain, also load and apply the matching section in:

`references/enterprise-checklist.md`

Domains covered there: APIs, data/registry, concurrency, security, frontend/UX,
DevOps/SRE, AI/LLM features, marketing/funnel code, migrations, monorepos.

When writing the final report severity language, use:

`references/severity-and-report.md`

---

## Quick command palette (adapt to repo)

```text
git status
git diff
git diff --cached
git log -5 --oneline

# discovery
rg / grep for new symbols, routes, tags, jobs
read sibling module that last implemented the same pattern

# verify
<repo test command>
python/node/<lang> existing _verify_* or tests
custom probe script for uniqueness / resolve / mutation / threads

# cleanup
remove temp probes or keep as official verify
```

---

## Relationship to the user's original bar

The user asked for: correctness, no bugs, no edge cases, no races, no gaps, no
collisions, correct wiring, sound logic, logical flow, best way, no future
problems, ultra thorough. **This skill operationalizes that bar** with
enterprise additions (security, SRE, multi-tenant, idempotency, observability,
product conversion, AI safety) so the audit is top-tier in any session, not only
one product.

**Amnesia is not thoroughness.** Finding a real problem and leaving it only in
chat because “out of scope this step” fails the bar. Durable capture (project
observations, checklist, tracker) is part of “no future problems.”
