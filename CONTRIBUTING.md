# Contributing to OpenGeo

OpenGeo is MIT-licensed and the self-hosted path is uncapped, so a contribution here
reaches everyone who runs it — including people who use the hosted service. That is
the reason this file is short and specific rather than a generic template.

## The one gate

```bash
pnpm ci:check
```

That is the whole local gate: formatting, dependency graph, both TypeScript
projects, type-aware lint, the test suite, slop detection, and the repository's own
consistency scripts. It takes about 75 seconds. **If it is green, a review is about
your change and not about your machine.**

The suite includes a static check on vendor spend (`scripts/cost-profile.mjs`), which
is why the DataForSEO balance rule below is a build constraint and not a preference.

## Rules an outsider cannot infer

**Never spend the DataForSEO balance.** The project's account holds exactly one
dollar, so it is not a sandbox you can point tests at. Every test reaches the vendor
through a pinned base host or a mocked client; `scripts/cost-profile.mjs` fails the
build if a test file can reach the vendor with nothing pinning the host. A PR that
adds a billable test path fails CI with the file named.

**The DataForSEO attribution requirement.** The product's numbers are DataForSEO's
data, and the vendor's terms require attribution in any public fork. The README and
`NOTICE.md` carry it; a PR that moves or reformats those files should keep the
attribution intact rather than treating it as boilerplate.

**Schema changes need both dialects.** `src/db/*.schema.ts` is SQLite and
`src/db/pg/*.schema.ts` is Postgres, and `src/db/schema-parity.test.ts` enforces the
table set, columns, nullability, types, defaults, keys and indexes across both. Run
`pnpm db:generate` and commit the new migration for **each** dialect, or a Postgres
deploy misses the table silently — the note at the top of each Postgres schema file
is there because that has happened.

**No `Array#toSorted`.** The library target is ES2022. Sort a copy, or compare sets.

**Do not publish a hosted rate.** The multiplier applied to a vendor cost is an
operator setting resolved per request on the server, and it is deliberately absent
from the client bundle, the source and the site. A PR that reintroduces a rate
literal to `src/shared/**` will fail `scripts/check-business-model.mjs` on the
marketing site and is the wrong shape regardless of that.

## Opening an issue

Issues are the most useful thing you can contribute here, and the templates are
short on purpose: `.github/ISSUE_TEMPLATE/bug_report.yml`,
`feature_request.yml`, and `good_first_issue.yml` if you are looking for somewhere
to start. There is a `/simple-issue-description` skill for the format the
maintainer reads fastest — plain words, the problem, and for a feature the full user
experience rather than what the screen looks like.

**A note on how issues land here.** Pull requests are read but not merged yet, so an
issue with a clear problem statement, a reproduction or a short walkthrough is worth
more than a patch. If you have built a proof of concept, link it.

## Useful starting points

The repository carries a `.greptile/` reviewer config scoped to `src/**`; the
maintainer docs, the pricing model and the roadmap live in the private repository,
so a PR touching those subjects is worth talking through first rather than
discovering at review.

## What happens after you open one

Reviews are by a human, with an independent second opinion from an automated reviewer run
over the change before it is merged. A finding has to be reproducible before it is fixed,
so expect a "what is the failing case" question more often than a style comment.
