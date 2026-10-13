# CONTRIBUTOR GUIDANCE

**Read this before adding a file to this repository.** It is short because the rule
is short, and it is here because the rule was once forgotten in a way that took a
day to unpick: seventeen commits of internal work sat on a branch here and were
merged wholesale, including material that was never meant to leave.

This repository is the **free, MIT, self-hosted OpenGeo product**. It holds only
what an end user needs to install and run that product on their own PC or server.

## The one test

> **Does an end user need this file, as it is, to install and run the free product
> themselves?**

Yes → it belongs here. No, or if it needs arguing → it belongs in the private
repository, and it is not a judgement call to make alone. "It is about the product"
is not the same as "a self-hoster needs it": a _note about_ the product is still a
note, and a publication built from our customers' data is our site's asset rather
than a product feature.

## Belongs here

- The application source needed to install and run the product: `src/`, the
  migrations a self-hoster applies, `Dockerfile.selfhost`, `compose.yaml`,
  `docker-entrypoint.sh`.
- Documentation a person reads to get a working instance and to trust its numbers:
  `README.md`, `docs/LOCAL_DEVELOPMENT.md`, `docs/SELF_HOSTING_*.md`,
  `docs/METHODOLOGY.md`, `docs/PLATFORMS.md`, `docs/DATAFORSEO_GOTCHAS.md`.
- Configuration a self-hoster fills in: `.env.selfhost.example`, `compose.yaml`.
- The product's own features: metering, cost display, dry-run price quoting,
  credit refusal.
- Gates over the code an end user runs: `pnpm ci:check` — formatting, knip, both
  TypeScript projects, type-aware lint, the test suite, slop detection, migration
  parity and coverage, the docker-selfhost compose check, the prepublish audit.

## Never belongs here

- Our website, its code, its content, or its SEO publication pages.
- The paid/hosted product: pricing, markup, billing internals, admin surfaces.
- Platform vendor economics — spend ledgers, monthly caps, kill switches,
  depletion alerts, anything framed as "our live key" or "the platform's account".
- Research apparatus: identifier registries and their provenance gates, doc
  re-reads, `docs/research/`, `docs/ops/`.
- Engineering notes and records: `maintainer-docs/`, checklists, TODOs, proposals,
  roadmaps, decision records, session logs, incident notes.
- Our coding skills and harness configuration: `.kilo/`, `.claude/`, `.opencode/`,
  `.agents/`.
- **Secrets of any kind.** `.env`, API keys, tokens, passwords, account ids — none
  of these are ever committed to any repository.

## Before you push

```bash
git ls-files | rg -i "(^|/)(\.env|\.dev\.vars)|^web/|^specs/|^\.kilo/|OPENGEO_(PROPOSAL|TODO|CHECKLIST|MASTER)|^docs/(ops|research)/|^\.(agents|claude|opencode)/"
git ls-remote --heads origin    # the branch you are pushing to is the one you meant
```

The first command must print nothing. If it prints anything, stop: that file is in
the wrong repository.

If you are an agent working in this folder, the full boundary — including where
each kind of file goes instead — lives in the private repository's `AGENTS.md` and
in `REPO_BOUNDARY.md` beside it. When in doubt, ask the maintainer rather than
guessing; a wrong guess here is not reversible in the way most mistakes are.
