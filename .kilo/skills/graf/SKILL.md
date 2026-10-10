---
name: graf
description: Navigate stored code and document graphs; explicitly add sources, select providers, analyze, export, and refresh with Graf.
---

<!-- graf guidance version: 2; executable: 0.6.0 -->
# Graf code graph

Use `graf query "symbol or topic"`, `graf show SYMBOL`, `graf callers SYMBOL`,
`graf callees SYMBOL`, `graf impact SYMBOL`, and `graf path FROM TO` to navigate
the local SQLite snapshot. With MCP enabled, use the Graf tools for the same
reads. Use exact returned IDs for ambiguous names, `--json` for structured
results, and `--db PATH` to select a database. Check `truncated`, diagnostics,
and unresolved references. Read source files whenever useful to verify results.
Default graph reads do not check source freshness. Graph reads never rebuild,
fetch URLs or call providers; explicit memory annotations check cited local files.

## Create and refresh

Run `graf index .` for static code and supported local documents; `--code-only`
limits discovery to code/configuration. `graf check-update` compares local
fingerprints without models or converters. `graf update` explicitly refreshes.
`graf watch --interval-ms 1000` is an optional foreground update loop, not a
service. Index/update/watch reuse stored extraction settings. Keep `.graf/`
databases, source caches, and setup receipts out of Git. No watcher is required.

## Add sources and select providers

`graf add FILE --project .` or `graf add URL --name page.html --project .`
imports once and saves extracted facts for later updates. Repeat add to fetch
again. Ordinary queries and updates do not refetch these saved sources.
Google pointers require explicit `--google` and configured gws; OCR uses
`--ocr` with installed Tesseract, media uses `--whisper MODEL` with Whisper/FFmpeg
or explicit `--download-media` with yt-dlp. Do not treat missing converters or
failed downloads as successful extraction; inspect errors and retain provenance.

Semantic extraction is opt-in: `graf provider --project . list` lists provider
choices; `graf provider --project . add NAME settings.json` registers settings.
`graf index . --provider NAME` selects one. Built-in HTTP providers need a full
`--endpoint URL`, a suitable `--model MODEL`, and `--key-env VARIABLE` when needed.
Use `--deep` to additionally enrich code, and `--vision` to allow image upload.
`--code-only --deep` can still send code to a model. Choose providers/endpoints
only for explicitly requested enrichment: calls may disclose source text and
incur costs. Bound work with `--max-semantic-files N` and provider call/token
settings; per-file limits are not a whole-corpus spending limit. Keys belong in
environment variables. Never invent an endpoint or silently enable a provider.
`graf index . --no-semantic` disables stored semantic settings. Check failures,
inferred confidence, evidence, and coverage rather than claiming complete facts.

## Analyze, export, and combine

`graf analyze`, `graf communities`, and `graf hubs --sort pagerank` explicitly
load the complete saved graph and can cost more than bounded navigation.
`--resolution` controls granularity; `--max-community-size` and `--min-cohesion`
are soft split targets. Inspect reported unsatisfied constraints.
`graf report --output report.md` and `graf export html --output graph.html`
create reports; `graf export snapshot-json --output graph.json` saves interchange
data. Other export formats include graphml, cypher, mermaid, svg, canvas,
callflow-html, tree-html, wiki, and obsidian. Wiki/Obsidian need an existing
output directory and create a fresh folder. `graf diagnose multigraph` reports
parallel/mixed edges and collapse risks without changing topology.
`graf label --output labels.json` saves deterministic membership-based labels;
`graf report --labels labels.json` applies only labels whose members still match.
`graf report --check-freshness` explicitly scans native source fingerprints;
without it, coverage describes stored inputs rather than checkout freshness.
`graf benchmark --query SYMBOL --iterations 20` times local bounded SQL reads;
timings are machine/cache dependent and do not compare other graph tools.

`graf global add NAME PROJECT` and `graf global refresh` explicitly rebuild a
stored aggregate. `graf global list` and `graf global query TEXT` use saved data
without opening registered sources. Missing sources abort rebuilds and retain
the previous aggregate. `graf merge --project NAME=PATH --snapshot NAME=FILE
--output NEW_DB` combines named inputs without collapsing source identities.
Analysis, labels, and exports never refresh the original graph implicitly.

Save reviewed useful answers explicitly with `graf save-result --question TEXT
--answer-file FILE --outcome useful --nodes ID`, using exact returned node IDs.
`graf reflect --if-stale` writes local lessons; ordinary queries never save answers
automatically. Add `--memory-dir graf-out/memory` to `graf show SYMBOL` or
`graf report --output report.md` to read observations and check cited sources
without changing graph data, ranking or lessons; the report still writes its
requested output. Inspect stale, unverified and omitted observations.

`graf provider detect --json` inspects local configuration without contacting
providers or verifying authentication. Preview `graf provider template PRESET
--json`; explicitly register `graf provider --project . setup NAME PRESET`.
Registration does not enable extraction; `index --provider NAME` does. Only when
GitHub inspection is requested, use `graf prs --repo OWNER/REPO` or
`graf prs NUMBER --repo OWNER/REPO`. These contact GitHub through authenticated
`gh`; they do not post comments/reviews, merge or change worktrees.

Optional project guidance hooks use `graf install --platform claude --project .
--tool-hooks` (also `codebuddy`). For Gemini with MCP, select `--mcp --tool-hooks`
together. Hooks never deny source access. Uninstall with the same platform,
project and component selection; add `--skill` explicitly if wanted. If Gemini
MCP or hooks are already installed separately, uninstall that selection before
installing both together.

## Guidance updates

Compare the installed guidance version with a newer Graf installation's output.
Rerun `graf install` with the same platform, scope, and component flags to update
receipt-owned guidance. Later edits are refused, not overwritten. Uninstall with
the same selection restores the original pre-install bytes, including after a
guidance upgrade. No source-read restrictions or background services are needed.
