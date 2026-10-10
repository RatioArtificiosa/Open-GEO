# Enterprise ultra-audit — domain depth packs

Use the packs that match the change set. Skip irrelevant packs. Every item is a
prompt for evidence, not a checkbox theater.

Sources blended into this checklist: Google eng-practices code review guidance,
OWASP secure code review themes, SRE production-readiness (SLIs/SLOs, golden
signals, PRR), concurrency/TOCTOU/idempotency patterns, API design review
practice, and real agent audit patterns (resolve/heal, registry integrity,
inject wiring).

---

## A. Universal code correctness

- [ ] Compiles / typechecks / imports clean on cold start
- [ ] Unit + integration tests for new behavior; failure modes covered
- [ ] Assertions match real requirements (not tautological mocks)
- [ ] Error messages actionable; no silent `except: pass` on critical paths
  without documented reason
- [ ] No dead code paths that look live
- [ ] Magic numbers explained or named constants
- [ ] Resource cleanup: files, connections, locks, temp dirs (`try/finally` /
  context managers)
- [ ] Comparison: float equality, string case, locale
- [ ] Integer division / truncation intentional
- [ ] Pagination stable under inserts (cursor vs offset tradeoffs known)

---

## B. Data, registries, catalogs, configs

- [ ] Schema version field present and bumped when shape changes
- [ ] Generator script ↔ committed artifact in sync
- [ ] Codes/tags/slugs unique; 1..N or documented sparse policy
- [ ] Enum constants in code == values in data
- [ ] Pack membership: no orphans; intentional multi-pack documented
- [ ] Required fields non-empty; optional fields default safely
- [ ] Unknown keys ignored or rejected deliberately
- [ ] File missing → empty safe default or loud fail (pick one, document)
- [ ] mtime/ETag/version cache invalidation correct
- [ ] Returned rows are copies if callers might mutate
- [ ] Nested mutables (list/dict) not shared across callers
- [ ] Multi-tenant: data paths include workspace/tenant id

---

## C. Resolve / recommend / defaulting logic

Classic foot-guns (audit every variant):

- [ ] Explicit user/code selection not overwritten by default **when browsing
  by id**
- [ ] Explicit selection **is** rejected/healed when job/mode mismatches
  **if product requires job purity**
- [ ] Map/dict overrides (`*_codes[job]`) beat single global code when designed
- [ ] Bad map values fall through; never accept wrong-job codes
- [ ] Unknown job: empty list vs coerce-to-default — consistent and documented
- [ ] Traffic/vertical filters soft-fail (don't starve entire job) when that is
  sibling policy
- [ ] Prefer-tags / default_for ordering stable and intentional
- [ ] Limit clamps: `0`, negative, huge; watch `x or default` falsy bugs

---

## D. API / HTTP / RPC

- [ ] Auth on every sensitive route (parity with siblings)
- [ ] 404 vs 403 correct (no existence leak if required)
- [ ] Input validation: type, range, length, enum
- [ ] Output pagination: limit/offset or cursor; total counts honest
- [ ] Idempotency keys for POSTs that create money/side effects
- [ ] CORS / CSRF as applicable
- [ ] Content-Type handled; JSON errors consistent shape
- [ ] No stack traces to clients in prod mode
- [ ] Rate limiting / body size limits on public endpoints
- [ ] Versioning strategy not broken by change
- [ ] OpenAPI/docs updated if repo keeps them
- [ ] Detail-by-id returns **that** entity's prompt/view, not a healed default

---

## E. CLI / jobs / workers

- [ ] Exit codes: 0 success, non-zero failure
- [ ] `--help` / usage accurate
- [ ] Dry-run for destructive ops if sibling CLIs have it
- [ ] Paths resolved from app root, not CWD assumptions alone
- [ ] Cron/worker handlers idempotent
- [ ] Poison message handling / DLQ
- [ ] Visibility timeout > max runtime
- [ ] Partial batch failure policy clear

---

## F. Concurrency & shared state

- [ ] Document process model (threads, async, multi-worker, multi-host)
- [ ] Locks cover full critical sections
- [ ] No lock order inversion (A then B vs B then A)
- [ ] Atomical file replace (write temp + rename) for configs if needed
- [ ] DB transactions isolation level appropriate
- [ ] Optimistic concurrency (version column) where lost updates hurt
- [ ] Cache keys include all dimensions that affect value
- [ ] Session/memory caches safe under ASGI/WSGI multi-worker (often **not**
  shared — don't assume they are)

---

## G. Security (OWASP-oriented)

### Injection & input
- [ ] Parameterized queries only
- [ ] No shell=True with user input; sanitize paths
- [ ] Template auto-escape on; raw HTML reviewed
- [ ] Header injection / log injection considered

### Authn / authz
- [ ] Authentication before authorization
- [ ] Object-level auth (IDOR)
- [ ] Function-level auth (admin routes)
- [ ] Token expiry, rotation, storage

### Data protection
- [ ] Secrets not in repo; env/secret manager
- [ ] PII minimized in logs
- [ ] Encryption in transit; at rest if required
- [ ] Backup/export access controlled

### Other
- [ ] SSRF: user URLs allowlisted
- [ ] Deserialization of untrusted data avoided
- [ ] Dependency additions reviewed
- [ ] Security headers if web UI
- [ ] File upload: type, size, storage outside web root

---

## H. Persistence & migrations

- [ ] Migration forward works on clean DB
- [ ] Migration forward works on prod-like data volume sample
- [ ] Rollback/expand-contract for zero-downtime if required
- [ ] Indexes for new query patterns
- [ ] Nullability and defaults backfill strategy
- [ ] Soft delete vs hard delete intentional
- [ ] Cascade rules don't destroy tenant data accidentally
- [ ] Connection pool sizing / leak free

---

## I. Frontend / UX (if UI touched)

- [ ] Loading / empty / error / success states
- [ ] Forms: validation, disabled submit while in-flight, double-submit
- [ ] Accessibility: labels, focus, keyboard, contrast for changed UI
- [ ] Responsive / safe areas if mobile
- [ ] No layout thrash; images sized
- [ ] Client routing auth guards
- [ ] XSS via `dangerouslySetInnerHTML` / `v-html` reviewed
- [ ] Feature flag UX for incomplete features

---

## J. DevOps / SRE / production readiness

Scale to change size. New service = full pack. Small fix = health + rollback note.

### Release
- [ ] Rollback path known
- [ ] Config changes backward compatible for one release if rolling deploy
- [ ] Feature flag for risky behavior
- [ ] Migration order vs app deploy order documented

### Health
- [ ] Liveness vs readiness separated if platform supports it
- [ ] Healthcheck binary exists in image (curl/wget) if Docker HEALTHCHECK needs it
- [ ] Health doesn't false-unhealthy on optional deps

### Observability
- [ ] Golden signals where relevant: latency, traffic, errors, saturation
- [ ] Structured logs; correlation id
- [ ] Alerts not page-worthy noise; runbook link if culture uses them
- [ ] Dashboard or log query for "is new feature working?"

### Resilience
- [ ] Timeouts on egress
- [ ] Retries only on idempotent ops or with idempotency key
- [ ] Bulkhead/queue limits for overload
- [ ] Dependency failure mode tested mentally or with chaos note

### Capacity
- [ ] Expected QPS / data size
- [ ] Hot path complexity acceptable
- [ ] Cache hit path exists for expensive pure functions if needed

---

## K. AI / LLM / agent features

- [ ] System prompts not overridable by raw user content without boundary
- [ ] Tool allowlists; no unconstrained shell/file from model unless designed
- [ ] Output validated before side effects (JSON schema, allowlists)
- [ ] PII / secrets redaction before send to model
- [ ] Token/cost budgets; truncation strategy
- [ ] Determinism needs: temperature, seed, caching
- [ ] Eval or golden tests for critical prompts if repo has them
- [ ] Jailbreak / prompt injection considered for user-visible tools
- [ ] Human-in-loop for irreversible actions

---

## L. Marketing / funnel / growth code (copy, email, ads, pages)

- [ ] Stage-legal CTAs (no early book/hard sell if doctrine forbids)
- [ ] Message match: acquisition → landing → nurture → offer
- [ ] Claims flagged unconfirmed / proof placeholders
- [ ] Unsubscribe / preference / legal footers if email send path
- [ ] Subject/preview laws if email
- [ ] Tracking params preserved end-to-end
- [ ] A/B or pack selection doesn't leak wrong vertical defaults
- [ ] Distinct craft layers not mixed (hook vs primary text vs image vs journey)

---

## M. Monorepo / multi-package

- [ ] Public API of package versioned or changelog noted
- [ ] Dependent packages still import
- [ ] Shared types single source of truth
- [ ] CI matrix covers affected packages
- [ ] No accidental cross-package circular deps

---

## N. Testing quality bar

- [ ] Tests fail when assertion inverted (not false green)
- [ ] Not only happy path
- [ ] Not over-mocked to the point of testing the mock
- [ ] Fixtures minimal and readable
- [ ] Flakes: time, order, external network — eliminated or marked
- [ ] Property/fuzz optional for parsers
- [ ] Contract tests for API shapes
- [ ] Integrity script for registries promoted to CI if critical

---

## O. Documentation & operability

- [ ] START_HERE / README / operator doc updated if new OS layer
- [ ] Runbook snippet for failure: "if empty registry, run build_X"
- [ ] Examples of campaign/config fields (`*_code`, `*_codes` maps)
- [ ] Distinct-from notes when two tag families exist

---

## P. "Future problems" stress questions

Answer in the report for any non-trivial change:

1. Misuse of public function by next caller?
2. 10× data volume?
3. Multi-instance deploy skew?
4. Empty bootstrap day-0?
5. New enum only in JSON not code?
6. Cache mutation by plugin/middleware?
7. Cross-tenant key collision?
8. Partial feature flag on?
9. Dependency down?
10. Legal/compliance change (consent, retention)?

---

## Q. Parity matrix vs sibling feature (mandatory for "OS layer" additions)

When adding a library that mirrors others (registry + packs + API + CLI +
pipeline inject + matrix + health + recommend):

| Capability | Sibling A | Sibling B | This change |
|------------|-----------|-----------|-------------|
| Registry JSON | | | |
| Packs JSON | | | |
| load mtime cache + lock | | | |
| list/get copy safety | | | |
| resolve job-aware | | | |
| recommend filters | | | |
| prompt_block | | | |
| API list/detail/packs | | | |
| Health count | | | |
| CLI info/sync | | | |
| Pipeline inject | | | |
| Matrix binding text | | | |
| Integrity verify script | | | |
| Operator docs | | | |

Gaps in the last column are either **fixes** or **documented NOTES**.
