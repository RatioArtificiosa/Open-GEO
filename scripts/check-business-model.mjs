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
