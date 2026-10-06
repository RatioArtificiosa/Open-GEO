import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CL-806 — the DESIGN.md §5 chart rules, enforced as a scan rather than a
 * paragraph.
 *
 * The note that shipped with CL-806 said *"the charts themselves do not exist
 * yet"*. Nine Recharts components did exist, and the audit that corrected the
 * note found five of them carrying off-system colour literals, two rendering a
 * `<Legend />`, and axes drawn without tabular figures. A rule that lives only
 * in a document is a comment; four of these are the ones a source scan can hold
 * without crying wolf, and each one is the shape of a defect that shipped here.
 *
 * Four rules:
 *  1. **No legends.** A legend separates a name from its line; every chart here
 *     is single-series, axis-labelled, or chipped in place. (§5.3)
 *  2. **Colours come from the system.** A colour literal in a presentation
 *     position must be a DESIGN.md §5.1 series colour, a §5.2 platform colour,
 *     a §2.4 status colour, or a `var(--…)`/`currentColor`. `#7c3aed` (the
 *     purple SaaS default) and `#888` shipped; neither is in the system.
 *  3. **Numbers are tabular.** A value axis that can change over time renders in
 *     tabular figures, so a value that updates does not shift a pixel. (§3.2)
 *  4. **The ETV boundary stays drawn.** The one chart that plots an ETV series
 *     carries the labelled rule at `ETV_CUTOVER_DATE`; it is the product's
 *     signature claim ("most tools' charts break silently on 2026-11-01").
 */

const FEATURES = fileURLToPath(new URL(".", import.meta.url));
const SRC_CLIENT = fileURLToPath(new URL("..", import.meta.url));
const APP_CSS = join(SRC_CLIENT, "styles", "app.css");

/** DESIGN.md §5.1 series + §5.2 platform identity + §2.4 status. */
const PALETTE = [
  "#f59e0b", // §5.1 slot 1 — the accent, and Google AI Overviews
  "#34d399", // §5.1 slot 2 / §2.4 positive
  "#60a5fa", // §5.1 slot 3
  "#a78bfa", // §5.1 slot 4
  "#fbbf24", // §5.1 slot 5 / §2.4 caution
  "#f472b6", // §5.1 slot 6
  "#10a37f", // §5.2 ChatGPT
  "#4285f4", // §5.2 Gemini
  "#20808d", // §5.2 Perplexity
  "#f87171", // §2.4 negative
  "#6b7280", // §2.4 neutral
];

/**
 * A brand mark is the vendor's colour, not ours — a logo is not a palette.
 * Exempt by path **with the reason beside it**, because a bare path is
 * indistinguishable from laziness.
 */
const BRAND_MARK_FILES = new Map<string, string>([
  ["auth/AuthPage.tsx", "the Google sign-in mark"],
  ["integrations/GoogleProductLogos.tsx", "Google product marks"],
  ["gsc/GoogleGlyph.tsx", "the Google mark"],
]);

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\bhsl\(|\brgba?\(|\boklch\(/g;
/** A line that puts a colour somewhere a chart can render it. */
const PRESENTATION =
  /(?:stroke|fill|stopColor|cursor|backgroundColor|color)\s*[:=]|\bbg-\[|\btext-\[|\bstroke-\[/;

function walk(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, suffix));
    else if (entry.endsWith(suffix)) out.push(path);
  }
  return out;
}

function idOf(path: string): string {
  return relative(FEATURES, path).split(sep).join("/");
}

function isChart(source: string): boolean {
  return /from "recharts"/.test(source);
}

function literalsIn(line: string): string[] {
  return line.match(COLOR_LITERAL) ?? [];
}

function onSystem(literal: string): boolean {
  return PALETTE.includes(literal.toLowerCase());
}

/** The prop text of each `<YAxis …>` element, up to its own closing bracket. */
function yAxisBlocks(source: string): string[] {
  const blocks: string[] = [];
  const parts = source.split("<YAxis");
  for (const part of parts.slice(1)) {
    const end = part.search(/\n\s*\/>|\/>/);
    if (end >= 0) blocks.push(part.slice(0, end + 2));
  }
  return blocks;
}

const TSX = walk(FEATURES, ".tsx");
const SOURCES = new Map(
  TSX.map((path) => [idOf(path), readFileSync(path, "utf8")]),
);

describe("DESIGN.md §5 — the chart rules hold across the app", () => {
  it("is scanning a real tree, not an empty one", () => {
    // A gate that reads nothing passes vacuously forever.
    expect(TSX.length).toBeGreaterThan(20);
    const charts = [...SOURCES.values()].filter(isChart).length;
    expect(charts).toBeGreaterThanOrEqual(9);
  });

  it("does not use a legend to label a series", () => {
    const violations: string[] = [];
    for (const [id, source] of SOURCES) {
      if (!isChart(source)) continue;
      source.split("\n").forEach((line, index) => {
        if (/<Legend[\s/>]/.test(line)) {
          violations.push(`${id}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      violations,
      `use axis labels or an in-place chip row:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("renders every chart colour from the design system", () => {
    const violations: string[] = [];
    for (const [id, source] of SOURCES) {
      if (BRAND_MARK_FILES.has(id)) continue;
      source.split("\n").forEach((line, index) => {
        if (!PRESENTATION.test(line)) return;
        for (const literal of literalsIn(line)) {
          if (!onSystem(literal)) {
            violations.push(`${id}:${index + 1}: ${literal} — ${line.trim()}`);
          }
        }
      });
    }
    expect(
      violations,
      `a colour outside DESIGN.md §5.1/§5.2/§2.4 ships a second design system:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("sets every value axis in tabular figures", () => {
    const violations: string[] = [];
    for (const [id, source] of SOURCES) {
      if (!isChart(source)) continue;
      for (const block of yAxisBlocks(source)) {
        if (/\bhide\b/.test(block)) continue;
        if (!block.includes("tabular-nums")) {
          violations.push(
            `${id}: YAxis without tabular-nums — ${block.replace(/\s+/g, " ").trim()}`,
          );
        }
      }
    }
    expect(
      violations,
      `DESIGN.md §3.2 — a value that shifts a pixel reads as a different value:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the ETV boundary rule wired to the chart that plots it", () => {
    const chart = SOURCES.get("geo/EtvBoundaryChart.tsx");
    expect(
      chart,
      "geo/EtvBoundaryChart.tsx is the only ETV series chart",
    ).toBeTruthy();
    // §5.3.2 — the boundary is drawn *on the chart* when a series crosses it.
    expect(chart).toContain("ETV_CUTOVER_DATE");
    expect(chart).toContain("ReferenceLine");
  });

  it("references no undefined --og-* token", () => {
    // `--og-accent` was never defined: `var(--og-accent, #F59E0B)` always fell
    // back to the raw accent, which is 2.11:1 on the light canvas. A fallback
    // standing in for a token is a contrast bug that looks like a choice.
    const css = readFileSync(APP_CSS, "utf8");
    const defined = new Set(css.match(/--og-[a-z-]+(?=\s*:)/g) ?? []);
    const violations: string[] = [];
    for (const path of walk(SRC_CLIENT, ".tsx")) {
      const id = idOf(path);
      if (id.endsWith(".test.tsx")) continue;
      for (const used of readFileSync(path, "utf8").match(/--og-[a-z-]+/g) ??
        []) {
        if (!defined.has(used)) violations.push(`${id}: ${used}`);
      }
    }
    expect(
      defined.size,
      "the walk found app.css's --og-* definitions",
    ).toBeGreaterThan(0);
    expect(
      violations,
      `undefined design token:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("each chart rule can fail — the negative controls", () => {
  it("distinguishes a legend from an axis label", () => {
    expect(/<Legend[\s/>]/.test("<Legend />")).toBe(true);
    expect(/<Legend[\s/>]/.test('<Legend verticalAlign="top" />')).toBe(true);
    expect(
      /<Legend[\s/>]/.test('<YAxis label={{ value: "Backlinks" }} />'),
    ).toBe(false);
  });

  it("distinguishes a system colour from the purple that shipped", () => {
    // The exact literal BillingUsageChart rendered.
    expect(onSystem("#7c3aed")).toBe(false);
    expect(onSystem("#888")).toBe(false);
    expect(onSystem("#2563eb")).toBe(false);
    expect(onSystem("#F59E0B")).toBe(true);
    expect(onSystem("#34d399")).toBe(true);
  });

  it("matches a colour in a presentation position, and only there", () => {
    expect(PRESENTATION.test('stroke="#7c3aed"')).toBe(true);
    expect(PRESENTATION.test('tick={{ fontSize: 10, fill: "#888" }}')).toBe(
      true,
    );
    expect(
      PRESENTATION.test('cursor={{ stroke: "rgba(150,150,150,0.3)" }}'),
    ).toBe(true);
    expect(
      PRESENTATION.test('className="h-full rounded-full bg-[#7c3aed]"'),
    ).toBe(true);
    // A colour named in prose is not a rendered colour.
    expect(PRESENTATION.test("Accent: #1C4ED8`;")).toBe(false);
  });

  it("distinguishes a tabular axis from one that shifts", () => {
    expect(yAxisBlocks("<YAxis width={60} />")).toHaveLength(1);
    expect(yAxisBlocks("<YAxis width={60} />")[0]).not.toContain(
      "tabular-nums",
    );
    expect(
      yAxisBlocks(
        '<YAxis style={{ fontVariantNumeric: "tabular-nums" }} />',
      )[0],
    ).toContain("tabular-nums");
    // A hidden axis has no ticks to shift.
    expect(/\bhide\b/.test("<YAxis hide />")).toBe(true);
  });
});
