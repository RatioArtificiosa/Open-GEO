#!/usr/bin/env node
/**
 * The business-model gate.
 *
 * ## Why this exists
 *
 * For months the site stated a pricing model we do not have: "$0.00 margin", "you
 * pay DataForSEO directly", "the free tier is uncapped". **Every automated check
 * passed the whole time**, because a copy check can only catch words someone thought
 * to forbid — and nobody had written this list, because the model was correct *in
 * the estimator* and wrong *in the prose*.
 *
 * That asymmetry is the lesson. `MARKUP = 1.28` was in the code from the start, so
 * the bug lived in a layer nothing was watching. **A gate written after the fact, for
 * a class rather than an instance, is the only thing that stops the next one.**
 *
 * ## What it asserts
 *
 * 1. **No pass-through claims on the hosted service.** We are the DataForSEO customer
 *    and mark data up; a page that says otherwise is lying about what a reader pays.
 * 2. **The self-hosted model is never conflated with the hosted one.** "Bring your own
 *    key" is true of self-hosting and false of our service — and the two were on the
 *    same page as if they were the same product.
 * 3. **The attribution is present on /notices and absent from the front page.** An MIT
 *    derivative must carry its licence and NOTICE, and neither is a reason to
 *    subscribe.
 * 4. **The markup is disclosed**, because publishing it is now the differentiator.
 *
 * ## Why it reads the build
 *
 * A source edit that misses a template, a comment shipped as prose, or a copy block
 * in `content/` all leave the source looking correct. **The built HTML is what a
 * reader sees**, so that is what this reads.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "web", "dist", "client");

if (!existsSync(DIST)) {
  console.error(
    "No build found. Run `pnpm --dir web run build` first — this gate reads the\n" +
      "built pages, because that is what a reader actually sees.",
  );
  process.exit(1);
}

/** The text of a rendered page, tags stripped. */
function text(path) {
  return readFileSync(join(DIST, path), "utf8")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

/** The homepage, and every page a reader reaches before subscribing. */
const FRONT_PAGES = ["index.html", "pricing/index.html", "compare/index.html"];

const failures = [];
const passes = [];
const fail = (rule, detail) => failures.push(`${rule}\n    ${detail}`);
const pass = (rule, detail) => passes.push(`${rule} (${detail})`);

const front = FRONT_PAGES.map((p) => [p, text(p)]);

// ── 1. no pass-through claims ────────────────────────────────────────────────
/**
 * Each of these was on the site and each is false of the hosted service.
 * They are listed as the exact strings used, not as a vague concept, so the
 * error message names what to search for.
 */
const PASSTHROUGH = [
  {
    label: "pay the vendor directly",
    re: /pay(?:ing)? (?:the vendor |DataForSEO )?directly/i,
  },
  {
    label: "a zero-margin claim",
    // **Margin language required, not a bare figure.** The pricing estimator
    // prints a cost for every line the sliders produce, and "0 checks this month"
    // legitimately costs $0.00 — a number in a bill, not a claim about earnings.
    // The first version matched the figure alone and fired on it.
    re: /\$\s*0\.00\s*(?:\|\s*)?margin|\b(?:zero|no)\s+margin\b|margin is zero|margin on (?:your|usage)/i,
  },
  {
    label: "a pass-through claim",
    re: /nothing on top|no (?:OpenGeo )?fee on top|we bill the vendor cost/i,
  },
  { label: "an uncapped-tier claim", re: /\buncapped\b/i },
  {
    label: "a bring-your-own-key claim on a hosted page",
    re: /bring your own (?:dataforseo )?key/i,
  },
];

for (const [path, body] of front) {
  for (const { label, re } of PASSTHROUGH) {
    if (re.test(body)) {
      fail(
        "the hosted service never claims to pass vendor cost through",
        `${path} says "${label}" — we are the DataForSEO customer and mark data up`,
      );
    }
  }
}
if (failures.length === 0) {
  pass(
    "no pass-through claims",
    `${FRONT_PAGES.length} front pages, ${PASSTHROUGH.length} patterns`,
  );
}

// ── 2. the markup is disclosed ───────────────────────────────────────────────
{
  const home = text("index.html");
  if (!/\b28\s?%/.test(home)) {
    fail(
      "the markup is disclosed on the homepage",
      "no 28% figure found — publishing it is the differentiator, and the claim " +
        "'none of them publish what the data costs' only works if we do",
    );
  } else {
    pass("markup disclosed", "the 28% figure is on the homepage");
  }
}

// ── 3. attribution lives on /notices, not the front page ─────────────────────
{
  const home = text("index.html");
  const offFront = [];
  if (/Every App, Inc\./i.test(home)) offFront.push("Every App, Inc.");
  if (/Ben Senescu/i.test(home)) offFront.push("Ben Senescu");
  if (/derivative work of/i.test(home))
    offFront.push("the upstream relationship");

  if (offFront.length > 0) {
    fail(
      "attribution is not on the front page",
      `${offFront.join(", ")} — these are obligations, so they stay on /notices, but ` +
        "a licence line is not a reason to subscribe",
    );
  } else {
    pass(
      "attribution off the front page",
      "no legal identity in the homepage copy",
    );
  }

  const noticesPath = join(DIST, "notices", "index.html");
  if (!existsSync(noticesPath)) {
    fail(
      "/notices exists",
      "the page carrying the licence and NOTICE is not in the build",
    );
  } else {
    const notices = text("notices/index.html");
    const missing = [
      ["the MIT licence", /MIT/i],
      ["the copyright holder", /Ben Senescu/i],
      ["the upstream credit", /OpenSEO/i],
      ["the data supplier", /DataForSEO/i],
    ].filter(([, re]) => !re.test(notices));

    if (missing.length > 0) {
      fail(
        "/notices carries the attribution",
        `missing: ${missing.map(([label]) => label).join(", ")}`,
      );
    } else {
      pass(
        "/notices complete",
        "licence, copyright, upstream and data supplier all present",
      );
    }
  }
}

// ── 4. self-hosting is not pitched as the way to avoid paying us ──────────────
/**
 * **The direction rule.** The gate above catches claims that are false. This one
 * catches claims that are *true and backwards*.
 *
 * "Self-hosting is free" is accurate — the self-hosted deployment has no OpenGeo fee.
 * It is also, on a page about what a subscription costs, an argument for not
 * subscribing. **A page can be entirely honest and still argue the reader out of the
 * sale**, and no amount of fact-checking finds that.
 *
 * So self-hosting is allowed. What is not allowed is the **cost-avoidance frame**: a
 * construction that pairs the deployment with the saving. Both halves are required,
 * because "self-host with your own key" is a legitimate statement and "so you can
 * self-host" is an instruction to leave.
 */
const SELF_HOSTING_PITCH = [
  {
    label: "self-hosting offered to avoid a cost",
    re: /(?:so you can self-host|self-host for free|self-hosting is free|free to self-host|if you['’]?d rather not pay|save money by self-hosting)/i,
  },
  {
    label: "self-hosting framed as the cheaper route",
    re: /(?:self-host[^.]{0,60}cheaper|cheaper[^.]{0,60}self-host|use it at cost)/i,
  },
  {
    label: "control over your stack as a benefit",
    re: /control over your (?:SEO |seo )?stack/i,
  },
];

{
  // **Every marketing page**, not just the front three. The backwards argument was
  // worst in the library FAQs and on the GSC page, which is the highest-traffic page
  // on the site — precisely because a reader who only ever sees one page should not
  // be told to leave by it.
  const offenders = [];

  for (const [file, body] of walkMarketingPages()) {
    for (const { label, re } of SELF_HOSTING_PITCH) {
      if (re.test(body)) {
        offenders.push(`${file}: ${label}`);
      }
    }
  }

  if (offenders.length > 0) {
    fail(
      "self-hosting is a real option, not the cheaper route we are arguing against",
      offenders.slice(0, 6).join("\n    ") +
        (offenders.length > 6 ? `\n    …and ${offenders.length - 6} more` : ""),
    );
  } else {
    pass(
      "no self-hosting-as-a-pitch",
      `${marketingPageCount()} pages, ${SELF_HOSTING_PITCH.length} patterns`,
    );
  }
}

// ── 4b. a page that states self-hosting costs less states what it costs too ──
/**
 * **The both-halves rule.** The list above bans specific
 * constructions. This rule catches the same frame in words the
 * list does not contain — the class rather than the instance,
 * which is the only way to stop the next phrasing.
 *
 * A page that tells the reader self-hosting costs less — that
 * they pay the vendor directly, that it costs nothing, that it
 * runs lower — is making the cost-avoidance argument in
 * whatever words it chose. The frame is the *pairing* of the
 * deployment with the saving, so the rule does not ban the
 * words: it requires the second half. A page that states
 * self-hosting's cost-advantage must also state what it costs
 * — the setup, the maintenance, that it is not cheaper than
 * doing nothing.
 *
 * **A page that has only the first half is the defect.** It is
 * entirely honest and still argues the reader out of the sale,
 * which is exactly what this gate exists to catch. A reader who
 * checks the page's own arithmetic finds the saving we never
 * offset.
 */
const COST_ADVANTAGE =
  /pay (?:them|their|DataForSEO) [^.]{0,20}directly|costs \$0|runs? (?:slightly )?lower|self-host[^.]{0,40}(?:costs less|less expensive|cheaper)/i;
const OFFSETING_COST =
  /not cheaper|costs you|setup and maintenance|the setup|the maintenance|an afternoon|rather lose the subscription|still cost/i;

{
  const offenders = [];
  for (const [file, body] of walkMarketingPages()) {
    if (COST_ADVANTAGE.test(body) && !OFFSETING_COST.test(body)) {
      offenders.push(file);
    }
  }

  if (offenders.length > 0) {
    fail(
      "a page that states self-hosting costs less states what it costs too",
      offenders.slice(0, 6).join("\n    ") +
        (offenders.length > 6 ? `\n    …and ${offenders.length - 6} more` : ""),
    );
  } else {
    pass(
      "self-hosting's cost is stated in both halves",
      `${marketingPageCount()} pages`,
    );
  }
}

// ── 4. the free tier is stated as $0.50, not as "unlimited" ──────────────────
{
  const pricing = text("pricing/index.html");
  if (!/\$0\.50/.test(pricing)) {
    fail(
      "the free tier's value is stated",
      "no $0.50 found on /pricing — the trial allowance is a number a reader can plan around",
    );
  } else {
    pass("free tier stated", "$0.50 of credit on /pricing");
  }
  if (/\$10/.test(pricing)) {
    pass("entry price stated", "$10/month on /pricing");
  } else {
    fail("the entry price is stated", "no $10 found on /pricing");
  }
}

/**
 * Every prerendered marketing page, as [path, prose] pairs.
 *
 * **All of them, not a sample.** The backwards argument was worst in the library
 * FAQs, on pages nobody on the team reads — a gate that only watched the homepage
 * would have passed every one of those.
 */
function* walkMarketingPages() {
  for (const file of marketingFiles()) {
    yield [file, text(file)];
  }
}

/** Every generated HTML file under the marketing routes. */
function marketingFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      // **Relative to DIST, and the root page is just `index.html`.** The first
      // version built `${rel}/index.html` for a file already ending in that, so
      // every path resolved one level too deep and nothing could be read.
      else if (entry.name === "index.html") out.push(rel);
    }
  };
  walk(DIST, "");
  return out;
}

function marketingPageCount() {
  return marketingFiles().length;
}

// ── 5. the free account's allowance is not confused with the plan ───────────────
/**
 * **$0.50 is the free account; $10 is the plan.** They are different things, and a
 * page that mentions one next to the other without saying whose it is has told the
 * reader the wrong price.
 *
 * CodeRabbit caught the instance: *"that is what the $10 plan is for — $0.50 of it
 * free"* reads as **a discount on the plan**, which would be a trial of the $10 tier.
 * That is the exact failure this gate exists to prevent, and it sat on the page whose
 * argument is that we publish our prices.
 *
 * So: a page naming $0.50 must attribute it — to the free account, the trial, or the
 * allowance — rather than attaching it to the plan.
 */
{
  const ATTRIBUTED = [
    /free account[^.]{0,60}\$0\.50/i,
    /\$0\.50[^.]{0,60}free account/i,
    /trial[^.]{0,60}\$0\.50/i,
    /\$0\.50[^.]{0,60}trial/i,
    /allowance[^.]{0,60}\$0\.50/i,
    /\$0\.50[^.]{0,60}allowance/i,
  ];

  const unattributed = [];
  for (const [file, body] of walkMarketingPages()) {
    if (!/\$0\.50/.test(body)) continue;
    if (!ATTRIBUTED.some((re) => re.test(body))) {
      unattributed.push(file);
    }
  }

  if (unattributed.length > 0) {
    fail(
      "the free account's allowance is distinguished from the plan's included usage",
      `${unattributed.slice(0, 5).join(", ")}` +
        (unattributed.length > 5
          ? ` …and ${unattributed.length - 5} more`
          : ""),
    );
  } else {
    pass(
      "free allowance attributed",
      "every page naming $0.50 says whose it is",
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────────
console.log("business model — the claims we make about what we charge\n");
for (const p of passes) console.log(`  ok   ${p}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  console.error(
    "\nIf the model has genuinely changed, update docs/ops/PRICING-MODEL.md and this\n" +
      "gate together — a model change with only the copy updated is what caused this.",
  );
  process.exit(1);
}

console.log("\nclean");
