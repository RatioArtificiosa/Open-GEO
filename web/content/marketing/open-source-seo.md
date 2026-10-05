---
title: Why OpenGeo Is Open Source — and Why You Would Not Run It
description: Open source is why you can check us. It is not why you should do the work yourself, and it is not a cheaper way to get the same thing.
---

OpenGeo is MIT-licensed. You can read every line of it, run it yourself, and change
whatever you want.

**We are also going to tell you why most people should not do that** — including us,
who wrote it. The licence and the recommendation are different things, and a page
that only makes the first argument is not being straight with you.

## What the licence actually gives you

**You can check us.** Every metric, every price and every vendor endpoint is in the
repository, and every number on this site opens onto the code that produced it. If we
were marking up quietly or reporting a score we cannot support, you would find it in
an afternoon. That is the whole reason the code is open, and it is a real constraint
on us — not a marketing posture.

**You can leave.** If OpenGeo raised its price past the point of usefulness, you can
fork it and keep working. Nobody can stop you, because that is what MIT means.

**You can build on it.** Agencies and developers extend OpenGeo rather than
rebuilding keyword research, backlinks and rank tracking from scratch. We would
genuinely rather you built on it than started over.

## Why you should subscribe instead

Because the hard part was never the code.

The application is the small half. The other half is a database, a scheduler that has
to survive a vendor outage, rate-limit handling, retry policy, nightly monitoring
runs, and a data pipeline that stays inside your budget when a crawl gets expensive by
accident. **None of that is interesting work, and all of it is work.**

| | Hosted | Self-hosted |
|---|---|---|
| Setup | Two minutes | A database, a volume, an environment file, an auth decision |
| Uptime | Ours to answer for | Yours, on a night when it matters |
| Vendor account | We hold it, and publish the rate | You open one, and read the docs |
| The 28% markup | Disclosed on `/pricing` | Not applicable — you pay DataForSEO direct |
| Upgrades | Included | When you get round to it |
| A client's data | Same workspace, one login | Same code, your server, your evening |

**The row worth reading is the last one.** If you are an agency handling a client's
site, the question is not whether you *can* run this. It is whether running it is the
job you were hired to do.

## Self-hosting is a genuinely good option

For some readers it is exactly right, and we would rather you chose it than chose
badly.

- **You want the data to never touch our account.** Then self-host. That is a
  legitimate reason, and we would rather lose the subscription than push you past it.
- **You want to extend the product.** Build on it — that is what it is for.
- **You already run infrastructure well** and a service is another box you already
  have a process for. Then it costs you an afternoon.

It runs on **Docker, Cloudflare Workers, Railway, Coolify, Dokploy and Vercel**, and
you bring your own DataForSEO key and pay them directly. The
[self-hosting docs](/docs/self-hosting) cover each one, including the persistent
volume every PaaS needs and the auth mode you must not get wrong.

**But none of those is cheaper than doing nothing.** They are cheaper than our
subscription, which is not the same claim — they still cost you the setup, the
maintenance, and the upgrade you skip because you are busy.

## Where the data comes from, and what it costs

OpenGeo uses [DataForSEO](https://dataforseo.com/), which has been running for close
to a decade and is the reference provider for pay-by-usage SEO data. They cover SERP,
rank, backlink, keyword and AI-answer workflows.

**We publish both sides of that bill.** `/pricing` shows what we pay and what we
charge, and the difference is a flat 28% — the same on every endpoint. No competitor
in this category will print that number, because printing it means publishing their
margin. If you would rather pay DataForSEO directly, self-hosting does exactly that,
and the `/pricing` page shows you the arithmetic either way.

## Why this product is built for agents, and what that buys you

Most AI-era SEO tools automate SEO as a job function. That is hype: SEO is deciding
what to do next, and if every company runs the same agent there is no edge.

OpenGeo was built after agents became useful, so it is shaped around working *with*
one. It has an [MCP server](/docs/mcp) that Claude, Codex, Cursor and any other MCP
client can drive — and the important part is that **the agent shows you where the
data came from** instead of asking you to trust its judgement. Ask it to do keyword
research and it hands back a link into the workspace.

That collaboration is going deeper: agent-built dashboards for a business or a
client, and reusable workflows for the routine parts of a monthly report.

## Can you really replace your SEO tool with OpenGeo?

It depends, and it is worth being straight about where.

**If you are new to SEO**, yes. The onboarding is not a maze, and an agent can walk
you through the basics with you.

**If you are an expert with a tool you like**, keep it. If your current tool is
bloated, poorly designed, or costs more per month than your clients charge you, then
OpenGeo is built to be the all-in-one replacement for
[Semrush](https://www.semrush.com/) and [Ahrefs](https://ahrefs.com/) — at a tenth of
the price, with the sources attached.

**If you need something neither of us has** — 40,000 tracked keywords, a global CDN
dataset — say so and we will tell you whether we have it. A competitor list that
concedes nothing is not a competitor list, it is a brochure.