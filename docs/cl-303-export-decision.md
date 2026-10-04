# CL-303 — what "PDF export" means here, and why it is not a PDF writer

**Decision: the artefact is a print-optimised document the reader saves as PDF.
No PDF library is added.**

## Why this reverses nothing, it completes a decision

`specs/0012-dynamic-reports.md` already ruled server-side PDF out:

> **line 44** — "Server-side PDF: the report is a real document with its own print
> CSS, so the browser prints it."
> **line 49** — listed under _Not in scope_.

That reasoning still holds, and checking it against the report's actual print CSS
is what makes it a decision rather than an inherited preference.

## What the report uses that a PDF writer would have to reimplement

From `plugins/opengeo/skills/seo-report/SKILL.md`:

| feature                                     | line    | why a hand-rolled PDF regresses                     |
| ------------------------------------------- | ------- | --------------------------------------------------- |
| `@page` margin boxes                        | 148     | page headers/footers need a full box layout engine  |
| `counter(page) " of " counter(pages)`       | 148     | pagination must be known before the footer is drawn |
| `break-inside:avoid` on tables/figures/rows | 158-159 | needs a break search over arbitrary authored HTML   |
| `orphans:3; widows:3`                       | 160     | paragraph-level pagination                          |
| `print-color-adjust:exact`                  | 165     | charts print blank without it                       |

**None of these are "nice to have"** — they are what makes a 30-page agency
deliverable look designed rather than dumped. A library that cannot do them
produces a worse artefact than the browser does today, for the same input.

## What the Worker cannot afford

`REPORT_MAX_HTML_BYTES` is 500 KB, chosen _"for the app worker's heap, not for
storage"_ — the worker's P90 heap already sits near its limit. A headless browser or
a from-scratch PDF writer has a completely different heap profile on that same
input, and the repo would be trading a working deliverable for a crash under load.

## So the work is the two halves nobody has done

1. **A download, not a dialog.** `?print=1` opens the browser's print dialog;
   the reader still chooses a destination, a filename and a paper size. CL-303 asks
   for an artefact, and an artefact arrives as a file.
2. **White-label identity carried through it.** There is **no branding column** —
   no logo, no client name, no accent. The only white-labelling in the system is
   inside the document: the `--accent` custom property and `.byline`, which the
   seo-report skill says is _"the one token a report template may change"_. So the
   export has to **read the branding out of the stored HTML**, because that is where
   it lives.

## Consequences worth stating now

- **No new runtime dependency**, which is the larger win: the public repo ships to
  users, and a PDF library is a large transitive surface to add to a Workers
  bundle for a capability the platform already provides.
- **The print path and the download path share one document builder**, so the two
  cannot diverge — the failure mode being a download that paginates differently
  from what prints.
- **The download is served with a filename and `Content-Disposition`**, derived
  from the report title, and it must be an `attachment` so the browser saves it
  rather than navigating to it.
