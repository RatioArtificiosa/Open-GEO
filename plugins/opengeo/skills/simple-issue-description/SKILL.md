---
name: simple-issue-description
description: Rewrite a feature request or bug report into a short, plain issue a maintainer can act on in one read. Use when opening an OpenGeo issue, or when asked to turn notes, a chat message or an agent's draft into one.
---

# Simple Issue Description

Write the issue as a person would say it out loud. Not as a spec, not as default AI
output.

This exists because the maintainer reads every issue himself, and he cannot read the
default output of a coding agent any more. It is not that it is wrong — it is that it
is 900 words of confident hedging around a request that fits in three sentences.

## What makes one of these useful

The two things that actually move an issue forward:

1. **The problem, from the user's side.** What were you doing, what happened, what did
   you expect instead. One paragraph.
2. **The full user experience.** If you are proposing a feature, walk through using it
   from start to finish — not what the screen looks like, but what you *do* and what
   happens as a result.

Everything else is optional. Environment details matter for bugs. Screenshots help. A
transcript from your agent that shows the failure is often the single most useful
attachment, because it proves the case rather than asserting it.

## The shape

Sections in this order, and drop any that do not apply:

- **Problem** — what is wrong or missing, in plain words. One paragraph, no preamble.
- **Steps to reproduce** — numbered, and only if it is a bug. Include the version.
- **Expected** — what should happen instead. One sentence.
- **Full user experience** — the proposal, as a walkthrough. Skip for pure bugs.
- **Why it matters** — one sentence, and only if it is not already obvious.

## What to cut, without exception

These are the tells of a generated issue, and each one costs the reader more than the
fact it surrounds:

- **"I would like to propose..."** Open with the problem. The reader can infer the rest.
- **Restating the request in three different registers.** Say it once.
- **A list of alternatives you considered that you did not choose**, each with a
  paragraph of justification. Mention the closest one only, if it matters.
- **Priority words.** "This is critical" is a judgement the maintainer makes himself,
  and it reads as pressure.
- **An implementation plan with file names.** He builds it himself. If you have built a
  proof of concept, link it — that is worth far more than describing it.
- **A summary at the end.** The issue is already the summary.

## Before you post

Read it once as the person who will act on it. If you cannot tell what they would do
next, the issue is not finished. Cut rather than expand: a short issue that names the
problem precisely gets built, and a long one that hedges gets deferred.
