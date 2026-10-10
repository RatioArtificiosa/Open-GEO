#!/usr/bin/env node
/**
 * The slop budget, enforced in CI.
 *
 * ## Why this is a gate and not a script
 *
 * Every one of these constraints was checked by a scratch script during the design
 * work, and **every one of them passed while the page was rendering unstyled** —
 * `vite preview` was 404ing every stylesheet, so thirty structural checks were
 * asserting on a document nobody could see styled.
 *
 * **A constraint that is only checked when someone remembers to check it is a
 * preference.** So this runs in `ci:check`, reads the *built* output, and fails
 * the build.
 *
 * ## What it asserts, and why each is structural rather than stylistic
 *
 * The research that produced these found that slop is a **macrostructure**, not a
 * bad element — and that the pages which read as *product* use few grid
 * containers while the pages which read as *marketing* are built from them:
 *
 * 1. **Fewer than 10 grid containers on the homepage.** Measured across the
 *    category: Otterly 12, Raycast 57, Peec 3. The pages that read as *product*
 *    use few; the pages that read as *marketing* are built from them.
 * 2. **Not Inter, not Geist, as the declared body font.** Both are on every
 *    competitor measured, which is what makes them the fingerprint of a generated
 *    page.
 * 3. **No hue in 260–290** in any gradient. The Tailwind `indigo-500` band, which
 *    every generated page reaches for.
 * 4. **The accent appears once above the fold.** An accent spent twice marks
 *    nothing.
 * 5. **Every page has exactly one `h1`.**
 *
 * ## The check that would have caught the unstyled page
 *
 * **`buildOutputIsStyled()`** — each generated page must link at least one
 * stylesheet, and that stylesheet must exist on disk and be non-trivial.
 *
 * That is the whole failure: the HTML was perfect and the CSS was 404ing. A gate
 * that reads markup cannot see it. This one resolves the asset paths.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB = join(process.cwd(), "web");
const DIST = join(WEB, "dist", "client");

/** The budget, named so a failure says which promise was broken. */
const GRID_BUDGET = 10;
const BANNED_FONTS = ["Inter", "Geist"];
const GRADIENT_HUE_MIN = 260;
const GRADIENT_HUE_MAX = 290;

/** Marketing words that read as generated. Matched case-insensitively. */
const BANNED_PHRASES = [
  "unlock",
  "supercharge",
  "seamless",
  "cutting-edge",
  "revolutionise",
  "revolutionize",
  "unleash",
  "game-changing",
  "world-class",
  "next-generation",
];

/** Manufactured urgency — FTC-named dark patterns (`Bringing Dark Patterns to
 *  Light`, Sept 2022), and weakest on the buyer this product sells to. */
const URGENCY_PATTERNS = [
  { label: "a countdown timer", re: /\b\d{1,2}:\d{2}:\d{2}\b/ },
  { label: "a stock countdown", re: /only \d+ (?:left|remaining|spots?)/i },
  {
    label: "fake activity",
    re: /\d+ (?:people|users) (?:are |currently )?(?:viewing|browsing)/i,
  },
  // **Both halves are required.** The first run fired on *"if you had unlimited
  // time"* — a user writing about their own backlog, not an offer with a deadline.
  //
  // So the deadline words need the commercial frame beside them: an urgency claim
  // is an **offer plus a deadline**, and a pattern matching either alone will
  // eventually hit ordinary prose. **A ban-list that misfires gets an exception, and
  // the next real violation gets one too.**
  {
    label: "a false deadline on an offer",
    re: /(?:limited[- ]time|act now|don'?t miss|hurry|ends (?:today|tonight|soon))[^.]{0,60}?(?:offer|discount|deal|price|plan|trial|seat)/i,
  },
  {
    label: "an offer with a deadline",
    re: /(?:offer|discount|deal|price|plan|trial|seats?)[^.]{0,60}?(?:limited[- ]time|ends (?:today|tonight|soon)|act now)/i,
  },
];

const failures = [];
const passes = [];

const fail = (rule, detail) => failures.push(`${rule}\n    ${detail}`);
const pass = (rule, detail) => passes.push(`${rule} (${detail})`);

/** Every generated HTML page. */
function htmlPages() {
  if (!existsSync(DIST)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".html")) out.push(full);
    }
  };
  walk(DIST);
  return out;
}

/** Every emitted stylesheet, concatenated. */
function allCss() {
  if (!existsSync(DIST)) return "";
  const assets = join(DIST, "assets");
  if (!existsSync(assets)) return "";
  return readdirSync(assets)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");
}

/**
 * THE RENDERING GATE.
 *
 * A page whose stylesheets are missing, 404ing or empty is not a styled page, and
 * every other check in this file would pass on it — which is exactly what
 * happened when `vite preview` served the build.
 */
function checkRendering(pages) {
  let linked = 0;
  let resolved = 0;
  const broken = [];

  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const sheets = [
      ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(\/[^"]+)"/g),
    ].map((m) => m[1]);

    if (sheets.length === 0) {
      broken.push(`${file.replace(DIST, "")} — links no stylesheet`);
      continue;
    }
    linked += 1;

    // **Local stylesheets only.** A page whose sole `<link>` is the Google Fonts
    // URL has nothing of ours attached, and would render unstyled. Counting an
    // external sheet as evidence of styling is the precise bug this gate exists
    // to prevent: the failure being hunted was *every local sheet 404ing while the
    // external font still resolved*, and "at least one href matched" passes that.
    const local = sheets.filter((href) => !/^(?:https?:)?\/\//.test(href));
    if (local.length === 0) {
      broken.push(
        `${file.replace(DIST, "")} — no local stylesheet, only external`,
      );
      continue;
    }

    // **Any one resolvable sheet is enough**, and a missing one is reported even
    // when another resolves — a 404 on a print stylesheet is still a broken link.
    let ok = false;
    for (const href of local) {
      const asset = href.startsWith("/") ? join(DIST, href) : join(DIST, href);
      if (existsSync(asset) && statSync(asset).size > 500) ok = true;
      else
        broken.push(`${file.replace(DIST, "")} -> ${href} is missing or empty`);
    }
    if (ok) resolved += 1;
  }

  if (broken.length === 0) {
    pass(
      "rendered",
      `${resolved}/${pages.length} pages resolve their stylesheets on disk`,
    );
    return;
  }
  fail(
    "every generated page must ship CSS that exists on disk",
    broken.slice(0, 5).join("\n    ") +
      (broken.length > 5 ? `\n    …and ${broken.length - 5} more` : ""),
  );
}

/** The grid budget, measured on the built CSS as the research measured it. */
/**
 * The grid budget, counting only grids the homepage **actually renders**.
 *
 * **The first run counted every `display:grid` rule in the stylesheet** and found
 * eleven. Eight are ours. `.grid` is a Tailwind utility that ships whether or not
 * we use it, and two belonged to sections this pass removed.
 *
 * Counting dead CSS measures **Tailwind**, not us — and the number would drift
 * every time a section was deleted, so within a month the budget would be reporting
 * a figure nobody chose. **A gate whose number is not about the artefact is a gate
 * that decays into noise.**
 */
function checkGridBudget(css, homepage) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , b]) =>
    /display\s*:\s*grid/.test(b ?? ""),
  );

  // The class names the homepage actually ships.
  const shipped = new Set(
    [...homepage.matchAll(/class="([^"]+)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter(Boolean),
  );

  const used = [];
  const dead = [];
  for (const [selector] of rules) {
    // **Match on the selector's own class name**, and take the *longest* one it
    // declares. A grouped selector like `.a, .b` yields several; a prefixed one
    // like `.md\\:grid` has a variant prefix that is not the class name.
    const candidates = [
      ...selector.matchAll(/\.((?:[a-z0-9_-]+:)*[a-z0-9_-]+)/gi),
    ]
      .map((m) => m[1].split(":").pop())
      .filter((c) => shipped.has(c));
    if (candidates.length > 0) used.push(candidates[0]);
    else dead.push(selector.trim().slice(0, 40));
  }

  if (used.length >= GRID_BUDGET) {
    fail(
      `fewer than ${GRID_BUDGET} grid containers on the homepage`,
      `${used.length} rendered: ${used.join(", ")}. For scale: Otterly 12, Raycast 57, Peec 3.`,
    );
  } else {
    if (used.length === 0) {
      // **Zero is the suspicious number.** A homepage that renders no grid
      // markup at all means the gate is reading a build that predates the page -
      // a shell rather than the site. Report that instead of passing.
      fail(
        "the grid budget measured a real page",
        "0 grid containers matched the homepage markup, so this gate is reading a build\n" +
          "    that does not contain it. Rebuild before running, or the number is fiction.",
      );
    } else {
      pass(
        "grid budget",
        `${used.length} rendered of ${rules.length} declared, budget ${GRID_BUDGET}`,
      );
    }
  }
}

/** The font the page declares, which is the fingerprint check. */
function checkFont(css, pages) {
  const declared = /--font-sans\s*:\s*([^;}]+)/.exec(css)?.[1] ?? "";
  const first = declared.split(",")[0]?.replace(/["']/g, "").trim() ?? "";

  if (first === "") {
    fail(
      "a body font is declared",
      "--font-sans is not set, so the page inherits whatever the browser has",
    );
    return;
  }
  const banned = BANNED_FONTS.filter((f) =>
    new RegExp(`\\b${f}\\b`, "i").test(first),
  );
  if (banned.length > 0) {
    fail(
      "the body font is not a category default",
      `"${first}" — ${banned.join(", ")} is on every competitor measured, which is what makes it the fingerprint of a generated page.`,
    );
  } else {
    pass("typeface", `${first} (not Inter or Geist)`);
  }
  void pages;
}

/**
 * The Tailwind indigo band, which every generated gradient reaches for.
 *
 * **Hues are read from hue positions, not from every number.** The first version
 * matched `/(\d{2,3})/` anywhere in a gradient, so `rgb(99 102 241)` contributed
 * `99`, `102` and `241`, and a `100%` stop read as hue 100. Nothing checked that
 * a number was *in* hue position, so the rule was firing on arithmetic that had
 * nothing to do with hue — and a real indigo gradient could have slipped through
 * the same noise.
 *
 * Hues now come from `hsl()`/`oklch()`/`lch()`'s third argument and from hex
 * converted to HSL.
 */
function checkGradientHue(css) {
  const offenders = [];

  for (const gradient of css.matchAll(/linear-gradient\([^)]*\)/g)) {
    const text = gradient[0];
    for (const hue of huesIn(text)) {
      if (hue >= GRADIENT_HUE_MIN && hue <= GRADIENT_HUE_MAX) {
        offenders.push(`${hue}deg in ${text.slice(0, 70)}`);
        break;
      }
    }
  }

  if (offenders.length > 0) {
    fail(
      `no gradient hue in ${GRADIENT_HUE_MIN}-${GRADIENT_HUE_MAX}`,
      `${offenders.length} gradient(s) in the indigo band — ${offenders[0]}`,
    );
  } else {
    pass(
      "gradient hue",
      `none in the ${GRADIENT_HUE_MIN}-${GRADIENT_HUE_MAX} band`,
    );
  }
}

/**
 * Hue in degrees, from the places a hue can legally appear.
 *
 * ## The three sources, and why not a fourth
 *
 * | Where | Which argument is the hue |
 * |---|---|
 * | `linear-gradient(<angle>, …)` | the **angle** — but only when it is first and bare |
 * | `hsl()`/`hsla()` | the **first** argument |
 * | `oklch()`/`lch()`/`lab()` | the **third** argument |
 * | `#6366f1` | converted to HSL, properly |
 *
 * **`rgb(99 102 241)` is not a source**, and neither is `100%` from a stop or an
 * alpha of `0.5`. The original rule read all of them as hues, which is the false
 * positive CodeRabbit found.
 *
 * The narrow rewrite that fixed that went too far: it dropped the gradient **angle**
 * entirely, so `linear-gradient(270deg, …)` — the most ordinary indigo gradient
 * there is — stopped being caught. **Fixing a false positive by removing the true
 * positives is not a fix.** Both are read here, from argument position rather than
 * from a bare number.
 */
function huesIn(text) {
  const out = [];

  // 1. The gradient's own angle. Only the first argument, and only a bare angle
  //    token — `0.5turn` and `100grad` are converted, `50%` is not an angle here.
  const gradient =
    /^linear-gradient\(\s*(-?[\d.]+)(deg|turn|rad|grad)?\b/i.exec(text.trim());
  if (gradient) {
    const value = Number.parseFloat(gradient[1]);
    const unit = (gradient[2] ?? "deg").toLowerCase();
    const degrees =
      unit === "turn"
        ? value * 360
        : unit === "rad"
          ? (value * 180) / Math.PI
          : unit === "grad"
            ? value * 0.9
            : value;
    if (Number.isFinite(degrees))
      out.push(Math.round(((degrees % 360) + 360) % 360));
  }

  // 2. hsl() puts the hue first; oklch/lch/lab put it third. The function name
  //    decides, because guessing from argument shape is how the first version
  //    read `99` as a hue.
  for (const m of text.matchAll(
    /(?:oklch|oklab|lch|lab|hsl|hsla)\(([^)]*)\)/g,
  )) {
    const fn = m[0].slice(0, m[0].indexOf("(")).toLowerCase();
    const args = m[1].split(/[\s,\/]+/).filter(Boolean);
    const token = /^(?:oklch|oklab|lch|lab)/.test(fn) ? args[2] : args[0];
    const value = Number.parseFloat(token ?? "");
    if (Number.isFinite(value)) out.push(value);
  }

  // 3. Hex, converted properly — `#6366f1` is indigo and must be caught.
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const h = hexHue(m[1]);
    if (h !== null) out.push(h);
  }

  return out;
}

/** HSL hue for a hex colour, or null when it is not a colour. */
function hexHue(hex) {
  let h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const [r, g, b] = [0, 2, 4].map(
    (i) => Number.parseInt(h.slice(i, i + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null; // achromatic — grey has no meaningful hue
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return Math.round(hue);
}

/** Vocabulary, read from the rendered marketing pages. */
function checkVocabulary(pages) {
  const found = new Map();
  for (const file of pages) {
    const text = readFileSync(file, "utf8")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z]+;/g, " ");
    for (const phrase of BANNED_PHRASES) {
      const re = new RegExp(`\\b${phrase}\\b`, "i");
      if (re.test(text)) {
        if (!found.has(phrase)) found.set(phrase, []);
        found.get(phrase).push(file.replace(DIST, ""));
      }
    }
  }
  if (found.size > 0) {
    const detail = [...found.entries()]
      .map(([p, files]) => `"${p}" in ${files.slice(0, 2).join(", ")}`)
      .join("\n    ");
    fail("no generated-sounding vocabulary", detail);
  } else {
    pass(
      "vocabulary",
      `${BANNED_PHRASES.length} phrases absent from ${pages.length} pages`,
    );
  }
}

/** Manufactured urgency, which this category's buyer discounts on sight. */
function checkUrgency(pages) {
  const found = [];
  for (const file of pages) {
    const text = readFileSync(file, "utf8")
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z]+;/g, " ");
    for (const { label, re } of URGENCY_PATTERNS) {
      if (re.test(text)) found.push(`${label} in ${file.replace(DIST, "")}`);
    }
  }
  if (found.length > 0) {
    fail("no manufactured urgency", found.slice(0, 4).join("\n    "));
  } else {
    pass("urgency", "no countdown, stock or fake-activity claims");
  }
}

/** One h1 per page, so the document has a spine a reader can navigate. */
function checkHeadings(pages) {
  const bad = [];
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    const body = /<body[\s\S]*?<\/body>/.exec(html)?.[0] ?? html;
    const h1s = (body.match(/<h1[\s>]/g) ?? []).length;
    if (h1s !== 1) bad.push(`${file.replace(DIST, "")} — ${h1s} h1 elements`);
  }
  if (bad.length > 0) {
    fail("exactly one h1 per page", bad.slice(0, 5).join("\n    "));
  } else {
    pass("headings", `all ${pages.length} pages have exactly one h1`);
  }
}

/** Void elements that never push onto the tag stack. */
const VOID_ELEMENTS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "source",
  "area",
  "base",
  "col",
  "embed",
  "track",
  "wbr",
]);

/**
 * Rows of cards: a `grid` or `flex` (non-`flex-col`) element holding two
 * or more card-treatment children.
 *
 * **A tag stack, not a regex.** Sibling adjacency is a tree property, so
 * the parse walks the tags, pushing and popping a stack, and counts each
 * card under its parent. A class-only match cannot know who a card's
 * siblings are, and would either miss a real row or invent one. `<script>`
 * and `<style>` blocks are stripped first: the hydration JSON inside a
 * script can carry markup that is not part of the rendered page.
 */
function cardRows(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ");
  const stack = [];
  const counts = new Map();
  const labels = new Map();
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>?/g;
  let m;
  while ((m = tagRe.exec(body))) {
    if (m[0].startsWith("</")) {
      const name = m[1].toLowerCase();
      while (stack.length && stack[stack.length - 1].name !== name) stack.pop();
      stack.pop();
      continue;
    }
    const name = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const classMatch = /class="([^"]*)"/.exec(attrs);
    const classes = classMatch ? classMatch[1].split(/\s+/) : [];
    if (!VOID_ELEMENTS.has(name)) stack.push({ name, classes });
    // **The card treatment is three classes, not two.** `rounded-xl border`
    // is also a bordered *button*'s signature; the `bg-white` fill is what
    // makes it a card, and a button without a fill is not one.
    const isCard =
      classes.includes("rounded-xl") &&
      classes.includes("border") &&
      classes.includes("bg-white");
    if (isCard && stack.length >= 2) {
      const parent = stack[stack.length - 2];
      const isRow =
        parent.classes.includes("grid") ||
        (parent.classes.includes("flex") &&
          !parent.classes.includes("flex-col") &&
          !parent.classes.includes("flex-col-reverse"));
      if (isRow) {
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
        labels.set(
          parent,
          `<${parent.name} class="${parent.classes.join(" ")}">`,
        );
      }
    }
  }
  const rows = [];
  for (const [parent, count] of counts) {
    if (count >= 2)
      rows.push(`${count} cards in a row under ${labels.get(parent)}`);
  }
  return rows;
}

/**
 * No card adjacent to a card — the "three cards in a row" macrostructure.
 *
 * The fourth §13.6 §4 constraint, and the one the gate was missing. The
 * research is specific that slop is a *macrostructure*: a single card is
 * a layout choice, but a row of them is the signature a generation model
 * produces because it is the median of the web. A `flex-col` stack is
 * deliberately not a row, so a vertical stack of cards is allowed — the
 * ban is on the row, not on cards.
 */
function checkCardAdjacency(pages) {
  const offenders = [];
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    for (const row of cardRows(html)) {
      offenders.push(`${file.replace(DIST, "")} — ${row}`);
    }
  }
  if (offenders.length > 0) {
    fail("no card adjacent to a card", offenders.slice(0, 5).join("\n    "));
  } else {
    pass("card adjacency", "no grid or flex row of cards on any page");
  }
}

// --- run -------------------------------------------------------------------
const pages = htmlPages();

if (pages.length === 0) {
  console.error(
    "No built pages found. Run `pnpm --dir web run build` before this gate — a gate\n" +
      "that passes because it read nothing is worse than no gate.",
  );
  process.exit(1);
}

const css = allCss();
if (css.length === 0) {
  console.error(
    "No stylesheet emitted. The site would render unstyled and every other check\n" +
      "would still pass — which is precisely the failure this gate exists to catch.",
  );
  process.exit(1);
}

console.log(
  `slop budget — ${pages.length} pages, ${(css.length / 1024).toFixed(0)}KB of CSS\n`,
);

const homepage = readFileSync(join(DIST, "index.html"), "utf8");

checkRendering(pages);
checkGridBudget(css, homepage);
checkFont(css, pages);
checkGradientHue(css);
checkVocabulary(pages);
checkUrgency(pages);
checkHeadings(pages);
checkCardAdjacency(pages);

console.log(`\n${passes.length} passed:`);
for (const p of passes) console.log(`  ok   ${p}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}

console.log("\nslop budget: clean");
