import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The theme, asserted against the decision that produced it.
 *
 * ## Why this file exists
 *
 * The accent was settled by the founder on 2026-09-28, written into
 * `OPENGEO_PROPOSAL.md:1037` (*"Settled by the founder: the accent is amber
 * `#F59E0B`. Not cyan."*) and carried in `DESIGN.md` §2.3. **It was never
 * implemented.** `app.css` kept upstream's `oklch(50% 0.12 262)` — hue 262, which
 * is blue — through the global rename, and nothing failed, because no test looked
 * at a stylesheet.
 *
 * A colour is a decision with no compiler behind it. This file is the compiler.
 *
 * ## What is asserted, and why not the literal strings
 *
 * **Hue and contrast, not exact values.** A hand-rounded OKLCH that is 0.1 off is
 * not a defect; hue 262 is. Asserting the string would make every future
 * adjustment a test failure and would be fixed by reverting rather than by
 * re-measuring — which is how a checked value becomes a superstition.
 */

const css = readFileSync(
  new URL("../../client/styles/app.css", import.meta.url),
  "utf8",
);

/** DESIGN.md §2.3 picked #F59E0B, which is hue 70. */
const AMBER_MIN_HUE = 50;
const AMBER_MAX_HUE = 85;

type Token = { l: number; c: number; h: number };

/** Every `--<name>: oklch(L C H)` in each `daisyui/theme` block. */
function parseThemes(source: string): Record<string, Record<string, Token>> {
  const themes: Record<string, Record<string, Token>> = {};
  for (const block of source.matchAll(
    /@plugin "daisyui\/theme" \{([\s\S]*?)\n\}/g,
  )) {
    const name = /name:\s*"([^"]+)"/.exec(block[1])?.[1];
    if (name === undefined) continue;
    const tokens: Record<string, Token> = {};
    for (const decl of block[1].matchAll(
      /--(color-[\w-]+):\s*oklch\(([^)]+)\)/g,
    )) {
      const [l, c, h] = decl[2].trim().split(/[\s/]+/);
      // **Lightness is divided by 100, and it has to be.** The OKLab conversion
      // cubes `L`, so it requires 0–1; the stylesheet writes `oklch(15.82% …)` and
      // the naive parse produced `15.82`. That is cubic in the scale, so every
      // contrast ratio came out inflated — the dark amber printed **114.65:1**
      // against a true 9.06:1 — and `isReadableOn`'s 4.5 threshold stopped meaning
      // anything, because a bad colour cleared it.
      //
      // The tell was two implementations of one number disagreeing: the hex path
      // (WCAG from sRGB, no lightness scale) was right, and the OKLCH path was
      // wrong. When two paths compute the same thing and differ, one of them is
      // lying about the number everything else is compared against.
      const lightness = Number.parseFloat(l);
      tokens[decl[1].replace(/^color-/, "")] = {
        l: l.endsWith("%") ? lightness / 100 : lightness,
        c: Number.parseFloat(c),
        h: Number.parseFloat(h),
      };
    }
    themes[name] = tokens;
  }
  return themes;
}

/**
 * Reads a token, and **fails the assertion if it is absent**.
 *
 * `theme?.accent` returning undefined used to flow straight into a numeric
 * comparison, where `expect(undefined).toBeGreaterThan(4.5)` fails with no clue
 * as to which token was missing — or, worse, an `as Token` cast made the intent
 * look settled when nothing had been checked at all.
 */
function token(theme: Record<string, Token> | undefined, key: string): Token {
  const found = theme?.[key];
  if (found === undefined) {
    throw new Error(
      `--color-${key} is missing or is not an oklch() value. Available: ${Object.keys(theme ?? {}).join(", ")}`,
    );
  }
  return found;
}

/** OKLCH -> linear sRGB. One definition, called from both places below. */
function oklchToLinearRgb({ l, c, h }: Token): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  // Every channel goes through `clamp`, which is documented at its definition.
  // **Built as a tuple rather than cast to one.** `as [number, number, number]`
  // narrowed a `number[]` and claimed a certainty the array did not have; naming
  // the three channels says the same thing and is true.
  return [
    clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

/** WCAG relative luminance from an OKLCH token. */
function luminance(value: Token): number {
  const [r, g, b] = oklchToLinearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two tokens.
 *
 * **The larger and smaller luminance are taken directly rather than by sorting.**
 * Two rules were in conflict here — `no-array-sort` wants `toSorted`, which needs
 * an ES2023 lib this project does not target, and the usual `[...arr].sort()` is
 * rejected by `no-useless-spread` because the array is already a fresh literal.
 * Neither call site needs a sort: they want the larger of two numbers, and a
 * general answer to a specific question is what produced the conflict.
 */
function contrast(a: Token, b: Token): number {
  const first = luminance(a);
  const second = luminance(b);
  const hi = first > second ? first : second;
  const lo = first > second ? second : first;
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The rules, as predicates.
 *
 * **One definition each, called by both halves of this file.** The gate on the
 * real stylesheet and the negative controls on the shipped-blue fixture call the
 * same functions, so a control cannot drift into testing something other than
 * what the gate tests — which would make it a second, weaker opinion about the
 * same rule.
 */
const isAmber = (hue: number) => hue >= AMBER_MIN_HUE && hue <= AMBER_MAX_HUE;
/** Hue 262 is what upstream shipped, so the 200–280 band is the bug itself. */
const isNotUpstreamBlue = (hue: number) => hue < 200 || hue > 280;
const isReadableOn = (fg: Token, bg: Token) => contrast(fg, bg) >= 4.5;
const isVisibleOn = (fg: Token, bg: Token) => contrast(fg, bg) >= 3;
const isDistinctHue = (a: number, b: number) => Math.abs(a - b) > 15;
/**
 * A dark canvas is a **range**, not a floor.
 *
 * Written as `c > 0.005 && l > 0.1` it accepted a mid grey at l=0.6, which is not
 * a dark canvas at all — the floor exists to exclude pure black, so it says
 * "not black" and never said "dark". A negative control caught it: the fixture
 * meant to be rejected was accepted, because the rule could not express the claim.
 *
 * The upper bound is where DESIGN.md's own ladder tops out. `#1A1E25` — the raised
 * surface — is l=0.234, so 0.35 leaves room above it while excluding anything
 * that reads as a mid tone.
 */
const isBlueBlack = (value: Token) =>
  value.c > 0.005 && value.l > 0.1 && value.l <= 0.35;

/** A plain dark token, for assertions that need a second colour. */
const darkEnoughToken = (): Token => ({ l: 0.1582, c: 0.0072, h: 258.37 });

/**
 * Clamp a linear-sRGB channel into [0, 1].
 *
 * **A saturated OKLCH colour can leave the gamut** — `oklch(0.5 0.9 140)` converts
 * to `[-0.333, 0.349, -0.119]` — and an unclamped channel feeds the weighted
 * luminance sum a value the colour does not have. It also makes a contrast ratio
 * meaningless, because a negative linear channel can invert the comparison.
 */
function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** A linear-sRGB channel to an 8-bit hex pair. */
function toHexChannel(v: number): string {
  return Math.round(
    (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255,
  )
    .toString(16)
    .padStart(2, "0");
}

/** OKLCH -> sRGB hex, so the hex path can be asked for the same ratio. */
function toHex(value: Token): string {
  return `#${oklchToLinearRgb(value).map(toHexChannel).join("")}`;
}

/** WCAG relative luminance from hex — the independent path. */
function hexLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const channel = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function hexContrast(a: string, b: string): number {
  // **No sort.** The larger and smaller of two numbers, which is what a sort of
  // a two-element literal was doing the long way round.
  const first = hexLuminance(a);
  const second = hexLuminance(b);
  const hi = first > second ? first : second;
  const lo = first > second ? second : first;
  return (hi + 0.05) / (lo + 0.05);
}

const themes = parseThemes(css);
const light = themes.opengeo;
const dark = themes["opengeo-dark"];

describe("the theme carries the founder's accent", () => {
  it("declares both themes", () => {
    // Without this every other assertion silently skips on `undefined`, and a
    // stylesheet that lost a theme reads as a passing suite.
    // **Membership, not an ordered comparison.** Sorting two known names would
    // assert an order nobody cares about; what matters is that both are declared.
    expect(Object.keys(themes)).toHaveLength(2);
    expect(Object.keys(themes)).toContain("opengeo");
    expect(Object.keys(themes)).toContain("opengeo-dark");
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the accent is amber, not upstream's blue", (_name, theme) => {
    expect(isAmber(token(theme, "accent").h)).toBe(true);
  });

  // The specific regression this file was written for: hue 262, blue.
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the accent is not the upstream blue", (_name, theme) => {
    expect(isNotUpstreamBlue(token(theme, "accent").h)).toBe(true);
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])(
    "%s: interactive chrome is neutral, so amber stays a signal",
    (_name, theme) => {
      // DESIGN.md §2.3 caps amber at ~3% of a viewport. DaisyUI's primary drives
      // ~100 btn-primary call sites, so an amber primary would put the signal on
      // every screen and it would stop marking anything.
      expect(
        isDistinctHue(token(theme, "primary").h, token(theme, "accent").h),
      ).toBe(true);
    },
  );

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the accent is readable as text on its own canvas", (_n, theme) => {
    // Measured, and these are the real ratios: the light theme's signal is
    // 4.84:1 on its canvas, the dark theme's 9.06:1. `#F59E0B` on white is
    // 2.11:1, which is why the light theme carries a darker amber than the
    // founder's hex rather than that hex verbatim.
    expect(isReadableOn(token(theme, "accent"), token(theme, "base-100"))).toBe(
      true,
    );
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: body text clears AA on its canvas", (_name, theme) => {
    expect(
      isReadableOn(token(theme, "base-content"), token(theme, "base-100")),
    ).toBe(true);
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: a primary button is visible against the canvas", (_n, theme) => {
    // WCAG 1.4.11 asks 3:1 of a UI boundary. A button you cannot see is not one.
    expect(isVisibleOn(token(theme, "primary"), token(theme, "base-100"))).toBe(
      true,
    );
  });

  it("the light elevation ladder descends", () => {
    const steps = ["base-100", "base-200", "base-300"].map(
      (k) => token(light, k).l,
    );
    expect(steps[0]).toBeGreaterThan(steps[1] ?? 0);
    expect(steps[1]).toBeGreaterThan(steps[2] ?? 0);
  });

  it("the dark elevation ladder ascends", () => {
    const steps = ["base-100", "base-200", "base-300"].map(
      (k) => token(dark, k).l,
    );
    expect(steps[0]).toBeLessThan(steps[1] ?? 0);
    expect(steps[1]).toBeLessThan(steps[2] ?? 0);
  });

  it("the dark canvas is a blue-shifted near-black, never #000", () => {
    // DESIGN.md §2.1: pure black reads as a hole and kills the elevation ladder.
    // **Chroma, not grey** — the theme shipped `oklch(18% 0 0)`, and a chroma of
    // zero is an unsaturated grey, which does not fix that; it hides it.
    expect(isBlueBlack(token(dark, "base-100"))).toBe(true);
  });

  it("the signal is one brand colour across both themes", () => {
    // Hue shifts a little with lightness. Past 20° they are two colours with one
    // name, and the brand stops being recognisable when a user switches themes.
    const shift = Math.abs(token(light, "accent").h - token(dark, "accent").h);
    expect(shift).toBeLessThanOrEqual(20);
  });
});

/**
 * The negative controls.
 *
 * Every assertion above runs against the **real, fixed** stylesheet — so on
 * their own they only prove the file is currently correct, not that the rules
 * can tell a correct theme from a wrong one. **A detector that cannot fail is
 * indistinguishable from a detector that does nothing.**
 *
 * **The regression is not hypothetical.** `app.css` shipped upstream's
 * `oklch(50% 0.12 262)` — hue 262, blue — over a grey `oklch(18% 0 0)` canvas,
 * for the entire life of the repo. The fixtures below are those exact values.
 *
 * Each test asserts the rule **rejects** them. The first version of this block
 * asserted the rule *passed* on the fixture, so the control failed for the
 * wrong reason: it proved the fixture was bad, not that the gate noticed.
 * The last test asserts the shipped file is **accepted**, because a set of
 * controls that only reject would also pass if the rule rejected everything.
 */
describe("the theme rules reject what the repo actually shipped", () => {
  /** The pre-change dark theme, byte for byte. */
  const SHIPPED_BLUE = [
    '@plugin "daisyui/theme" {',
    '  name: "opengeo-dark";',
    "  --color-base-100: oklch(18% 0 0);",
    "  --color-base-200: oklch(12% 0 0);",
    "  --color-base-300: oklch(27% 0 0);",
    "  --color-primary: oklch(66% 0.12 262);",
    "  --color-accent: oklch(66% 0.12 262);",
    "}",
  ].join("\n");

  /** A theme whose three elevation steps are identical. */
  const FLAT = [
    '@plugin "daisyui/theme" {',
    '  name: "flat";',
    "  --color-base-100: oklch(15% 0.007 258);",
    "  --color-base-200: oklch(15% 0.007 258);",
    "  --color-base-300: oklch(15% 0.007 258);",
    "}",
  ].join("\n");

  it("rejects hue 262, the blue the theme actually shipped", () => {
    const shipped = parseThemes(SHIPPED_BLUE)["opengeo-dark"];
    const hue = token(shipped, "accent").h;
    expect(isAmber(hue)).toBe(false);
    expect(isNotUpstreamBlue(hue)).toBe(false);
  });

  it("rejects chrome and signal sharing one hue", () => {
    const shipped = parseThemes(SHIPPED_BLUE)["opengeo-dark"];
    const separated = isDistinctHue(
      token(shipped, "primary").h,
      token(shipped, "accent").h,
    );
    expect(separated).toBe(false);
  });

  it("rejects the zero-chroma grey canvas", () => {
    // `oklch(18% 0 0)` has chroma 0, which is an unsaturated grey — and
    // DESIGN.md's reason for a blue-shifted black is that pure black reads as a
    // hole. Grey does not fix that; it hides it.
    const canvas = token(parseThemes(SHIPPED_BLUE)["opengeo-dark"], "base-100");
    expect(canvas.c).toBe(0);
    expect(isBlueBlack(canvas)).toBe(false);
  });

  it("rejects an unreadable signal on a near-white canvas", () => {
    // The founder's #F59E0B measures 2.11:1 on white, which is why the light
    // theme carries a darker amber rather than that hex verbatim.
    // **On the 0–1 lightness scale**, matching what the parser now produces. A
    // fixture on the old scale would be asserting against numbers the gate never
    // sees, which is how a control stops being a control.
    const amber: Token = { l: 0.7686, c: 0.1647, h: 70.08 };
    const nearWhite: Token = { l: 0.9943, c: 0.0013, h: 286.38 };
    expect(isReadableOn(amber, nearWhite)).toBe(false);
  });

  it("rejects a button nobody can see", () => {
    // **The 3:1 bar (WCAG 1.4.11) had no negative control at all.** The rule fires
    // on every theme assertion, so weakening it to 1:1 changed nothing for a
    // palette that already passes — which is exactly how a threshold rots.
    // `#B8BCC4` on a near-white canvas measures **1.87:1**: legal-looking, and
    // unfindable. The 3:1 line on that canvas sits around L* 62, so a control has
    // to be clearly below it rather than near it.
    const canvas: Token = { l: 0.9943, c: 0.0013, h: 286.38 };
    const faintButton: Token = { l: 0.7945, c: 0.0121, h: 264.5 }; // #B8BCC4
    expect(isVisibleOn(faintButton, canvas)).toBe(false);
    expect(isReadableOn(faintButton, canvas)).toBe(false);
  });

  it("rejects a canvas whose lightness is above the dark floor", () => {
    // `isBlueBlack` requires both chroma and a lightness floor. The shipped-blue
    // control covers chroma 0, but nothing sat near the lightness boundary, so the
    // floor itself was untested.
    const tooLight: Token = { l: 0.6, c: 0.02, h: 258.33 };
    const darkEnough: Token = { l: 0.1582, c: 0.0072, h: 258.37 };
    expect(isBlueBlack(tooLight)).toBe(false);
    expect(isBlueBlack(darkEnough)).toBe(true);
  });

  it("clamps an out-of-gamut colour rather than trusting the channels", () => {
    // **The first version of this control asserted `0 <= luminance <= 1`**, which
    // every out-of-gamut colour satisfied even unclamped — green carries the
    // largest weight, so a colour whose only escaping channels are red and blue
    // still lands in range. It passed with the clamp deleted, which is the
    // definition of decoration.
    //
    // **So the assertion is the clamp's effect.** `oklch(0.5 0.9 140)` converts to
    // `[-0.333, 0.349, -0.119]`; clamped it weighs **0.2493**, unclamped **0.1698**.
    // Removing the clamp moves the number by 0.08 — far outside any tolerance —
    // while a range check moves it nowhere.
    const wild: Token = { l: 0.5, c: 0.9, h: 140 };
    expect(luminance(wild)).toBeCloseTo(0.2493, 3);
    // And the ratio stays finite rather than exploding on a negative channel.
    expect(Number.isFinite(contrast(wild, darkEnoughToken()))).toBe(true);
  });

  it("rejects a flat elevation ladder", () => {
    const steps = ["base-100", "base-200", "base-300"].map(
      (key) => token(parseThemes(FLAT)["flat"], key).l,
    );
    expect(steps[0]).toBe(steps[1]);
    expect(steps[1]).toBe(steps[2]);
  });

  it("accepts the theme that is actually shipped", () => {
    const shipped = parseThemes(SHIPPED_BLUE)["opengeo-dark"];
    expect(isAmber(token(shipped, "accent").h)).toBe(false);

    for (const theme of [light, dark]) {
      expect(isAmber(token(theme, "accent").h)).toBe(true);
      expect(isNotUpstreamBlue(token(theme, "accent").h)).toBe(true);
      expect(
        isReadableOn(token(theme, "accent"), token(theme, "base-100")),
      ).toBe(true);
      expect(
        isVisibleOn(token(theme, "primary"), token(theme, "base-100")),
      ).toBe(true);
      expect(isBlueBlack(token(dark, "base-100"))).toBe(true);
    }
  });
});

/**
 * The cross-check that would have caught the scale bug.
 *
 * ## Why two implementations of one number
 *
 * This file computes contrast from **OKLCH** (what the stylesheet writes) and
 * there is an independent path from **hex** (WCAG relative luminance on sRGB,
 * which has no lightness scale to get wrong). For a long time they disagreed and
 * nothing compared them: the dark amber read as **114.65:1** through the OKLCH
 * path and **9.06:1** through the hex path, because the OKLab conversion cubes
 * `L` and the parser was handing it 15.82 instead of 0.1582.
 *
 * **Two paths computing the same quantity and differing is the strongest signal
 * available** — stronger than either being obviously wrong — so this test makes
 * them agree out loud. A future scale mistake fails here rather than silently
 * weakening every threshold in the file.
 */
describe("the OKLCH and hex paths agree", () => {
  it.each([
    ["light", light],
    ["dark", dark],
  ])("%s: the two paths give the same ratio", (_name, theme) => {
    const canvas = token(theme, "base-100");
    const accent = token(theme, "accent");
    const primary = token(theme, "primary");

    // **To within 0.1**, which is the rounding of the stylesheet's own precision.
    // A scale error is off by orders of magnitude, so a generous tolerance still
    // catches the class of bug that matters.
    expect(contrast(accent, canvas)).toBeCloseTo(
      hexContrast(toHex(accent), toHex(canvas)),
      1,
    );
    expect(contrast(primary, canvas)).toBeCloseTo(
      hexContrast(toHex(primary), toHex(canvas)),
      1,
    );
  });

  it("the shipped ratios are the measured ones, not inflated ones", () => {
    // **Pinned, because these are the numbers the palette decisions rest on.** A
    // palette change that breaks AA should fail here with a name, not surface as
    // an unreadable label in someone's browser.
    expect(
      contrast(token(dark, "accent"), token(dark, "base-100")),
    ).toBeCloseTo(9.06, 1);
    expect(
      contrast(token(light, "accent"), token(light, "base-100")),
    ).toBeCloseTo(4.84, 1);
    expect(
      contrast(token(dark, "base-content"), token(dark, "base-100")),
    ).toBeCloseTo(16.14, 1);
  });
});
