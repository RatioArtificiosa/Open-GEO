# Severity language & report quality bar

## Severity definitions (canonical)

### CRITICAL
User or system suffers **wrong outcomes**, **data loss**, **security breach**,
or **silent production misbehavior** on a hot path.

Examples:
- Auth bypass; IDOR across tenants
- Wrong financial amount; double charge without idempotency
- API by-id returns different entity's content (heal-away bug)
- Cache returns mutable shared state that corrupts other requests
- Dropped write that is acknowledged as success

### HIGH
Feature is **wired wrong** or **semantically incorrect** such that normal use
fails or teaches the system the wrong behavior, even if process doesn't crash.

Examples:
- Pipeline maps piece A to craft/job of piece B
- Recommend always starves a legitimate segment
- Missing inject on the primary piece the feature exists for
- Race that can lose updates under modest concurrency
- Registry constants drift from data (unknown jobs always)

### MEDIUM
Incorrect on **edge paths** or **secondary surfaces**; incomplete vs sibling
parity; foot-guns that bite advanced users.

Examples:
- Nested cache mutation only if caller mutates lists
- Lifecycle pieces missing inject while primary nurture works
- Case-sensitive filter inconsistency
- Weak validation that still mostly works for well-formed clients

### LOW
Polish, docs, consistency nits without functional harm.

### NOTE
Intentional tradeoffs, pre-existing sibling debt, deploy not requested, optional
SRE stretch goals for tiny diffs.

---

## Mapping findings → actions

| Severity | Must fix in audit? | Blocks PASS? |
|----------|--------------------|--------------|
| CRITICAL | Yes | Yes until fixed |
| HIGH | Yes | Yes until fixed |
| MEDIUM user-facing | Yes if writable | Yes if left unfixed without reason |
| MEDIUM internal | Prefer fix | No if residual documented |
| LOW | Optional | No |
| NOTE | No | No |

If you cannot fix (permissions, missing product decision), **FAIL** with a
clear human decision needed — do not pass with open CRITICAL/HIGH.

---

## Issue write-up template

```markdown
### Issue N — Severity: CRITICAL|HIGH|MEDIUM|LOW|NOTE
- **File:** path/to/file.ext:LINE
- **Surface:** API | pipeline | cache | CLI | data | UI | security | …
- **Title:** one-line name
- **Description:** what is wrong in plain language
- **Why it matters:** user/system impact
- **Evidence:** command output, repro steps, before/after values
- **Root cause:** one sentence
- **Fix:** what you changed (or exact fix plan if blocked)
- **Proof after fix:** command + expected observation
- **Regression guard:** test/assert added?
```

---

## Evidence standards

Good evidence:
- Exact command + exit code + relevant stdout
- Before/after string of a prompt block or response JSON
- Thread stress: "8 threads × 40 loops, 0 errors"
- Integrity script JSON `"ok": true`

Bad evidence:
- "Should be fine"
- "Looks correct"
- "Tests probably cover it" without running them

---

## Best-way assessment (short paragraph rules)

Answer:
1. Does this match the **local pattern family**?
2. Is there a **simpler** correct approach already used nearby?
3. Did we introduce **accidental complexity**?
4. Is the **default** safe for the majority use case?
5. Can a future engineer **extend** without forking logic?

If the answer to 3 is yes and 1 is no, prefer aligning to sibling pattern over
inventing a new style.

---

## Out-of-scope residuals (durable capture)

**Firm rule (skill SKILL.md):** real findings that are out of current ship scope
must be written to a **project-durable** surface (observations log, checklist,
issue tracker, feature residual section, or project residual backlog) — **not**
chat-only.

| Situation | PASS allowed? | Required action |
|-----------|---------------|-----------------|
| In-scope CRITICAL/HIGH unfixed | No | Fix or FAIL with decision |
| Out-of-scope CRITICAL/HIGH | Usually FAIL or blocked until product decides | Durable row with severity + owner decision needed |
| Out-of-scope MEDIUM/LOW | Yes if captured | Durable row + report table with path |
| Residual only in chat report | No | Phase 11b write, then re-verdict |
| Pure style / speculation | N/A | Do not capture as backlog noise |

Minimum residual row fields: **ID · Severity · Gap · Why it matters · Suggested
later fix · Status · Durable path**.

---

## PASS / FAIL discipline

**PASS** means:
- No open CRITICAL/HIGH **in scope** (or out-of-scope CRITICAL/HIGH with explicit
  blocked human decision **and** durable capture — prefer FAIL until decided)
- MEDIUM user-facing either fixed or explicitly accepted by user in-session
- Build/tests/integrity for the change are green
- Wiring for primary surfaces verified with evidence
- Residual items that still need work are **durably captured** (not chat-only);
  in-report residuals that need no action may be LOW/NOTE only

**FAIL** means:
- Open CRITICAL/HIGH, or
- Build/tests broken by the change, or
- Primary wiring unverified and cannot be verified, or
- Security boundary clearly broken, or
- Real out-of-scope residuals left **only** in chat with no durable write

Do not FAIL for pure style. Do not PASS because the author worked hard.
Do not PASS by “forgetting” debt that was out of scope today.

---

## Report length guidance

| Change size | Report |
|-------------|--------|
| Tiny fix | Scope + issues + evidence + verdict (short) |
| Feature / library | Full template from SKILL.md |
| New service | Full template + SRE pack + security pack |

Ultra-detailed does **not** mean padded. It means **no silent gaps** in the
phases that matter.
