# The rebrand hook: do not re-run it

A repo-wide `openseo` → `OpenGeo` hook ran once during development and produced
an output that was **not committed**. It is recorded here because the stash is
gone and the reasoning is the part worth keeping.

## What the hook did

A blanket search-and-replace across 47 files, plus an encoding conversion.

## Why its output was discarded

**It rewrote the licence attribution.** The project is a derivative work of
[OpenSEO](https://github.com/every-app/open-seo), which is MIT. MIT requires the
copyright and permission notice to be retained in all copies. The hook turned:

```
- We are grateful to the OpenSEO authors and contributors.
+ We are grateful to the OpenGeo authors and contributors.

- Upstream: https://github.com/every-app/open-seo
+ Upstream: https://github.com/RatioArtificiosa/Open-GEO
```

`every-app` appears on **3 removed lines and 0 added lines**: the upstream is not
named anywhere in the output. A derivative work that erases its own attribution
is a licence violation, not a style problem, and no amount of later repair makes
"we almost shipped this" a good answer.

**It re-encoded UTF-8 as Windows-1252.** 63 characters across 7 files — every
multi-byte punctuation mark became three garbage characters, because each of its
UTF-8 bytes was read as a separate Windows-1252 character. Verified against
`HEAD`, which is clean.

**A blanket replace cannot do this job.** The name `openseo` appears in two
unrelated roles: _our_ product name, and _upstream's_. Any search-and-replace
cannot tell them apart, and it picked wrong on exactly the lines where being
wrong matters most.

## If a rebrand is wanted later

Do it as an explicit, reviewable change, not a hook:

1. Rename the product's own occurrences only — never a licence or attribution
   line.
2. Leave `every-app/open-seo` intact and verify it still appears afterwards.
3. Run it as UTF-8 and diff the byte-level result; a re-encode is a separate
   failure and should never ride along with a rename.
4. `git diff --word-diff` on `NOTICE.md` and `package.json` before committing.

## If a hook must be blocked

The encoding damage alone is worth a gate: a test that fails when any tracked
text file contains a U+00E2 sequence would have caught this on its first run,
independently of the attribution question. `scripts/prepublish-audit.test.ts`
already reports which §12.4 clauses are unenforced — an encoding clause belongs
there rather than in a comment nobody reads.
