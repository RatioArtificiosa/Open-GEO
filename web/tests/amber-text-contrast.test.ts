import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CL-317. The marketing site is light-only (`app.css` pins `.fd-light` and
 * states it), so amber is *always* text on a near-white canvas here. The raw
 * accent `#F59E0B` is 2.15:1 on that canvas — below WCAG AA's 4.5:1 — which
 * is why the design system carries a second token, `--color-brand-accent-text`
 * (`#A16207`, 4.84:1), for exactly this. This gate fails the build on the
 * defect rather than describing it, because a value not defined in `app.css`
 * is a defect, not a choice.
 *
 * The pattern matches the Tailwind class `text-[var(--color-brand-accent)]`
 * and deliberately nothing else: the `-text` token that fixes it, the `-hover`
 * token, and the `decoration-`/`bg-`/`accent-` uses of the raw accent (fills
 * and underlines, where `#F59E0B` is the signal colour the system intends) all
 * fail to match, because the closing `]` must follow `accent)` directly.
 */
const RAW_AMBER_TEXT = /text-\[var\(--color-brand-accent\)\]/;

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(tsx|ts|css)$/.test(entry)) yield path;
  }
}

describe("amber is never a text colour on the light marketing canvas", () => {
  it("uses --color-brand-accent-text for amber text, never the raw accent", () => {
    const violations: string[] = [];
    let files = 0;
    for (const file of walk(SRC)) {
      files += 1;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (RAW_AMBER_TEXT.test(line)) {
            violations.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    // A gate that reads nothing passes vacuously forever, so prove it read.
    expect(files).toBeGreaterThan(0);
    expect(
      violations,
      `raw amber (#F59E0B, 2.15:1) used as text on the light canvas — ` +
        `use the 4.84:1 token instead: text-[var(--color-brand-accent)] → ` +
        `text-[var(--color-brand-accent-text)]\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("tells the defect apart from the token that fixes it", () => {
    expect("text-[var(--color-brand-accent)]").toMatch(RAW_AMBER_TEXT);
    expect("hover:text-[var(--color-brand-accent)]").toMatch(RAW_AMBER_TEXT);
    expect("text-[var(--color-brand-accent-text)]").not.toMatch(RAW_AMBER_TEXT);
    expect("text-[var(--color-brand-accent-hover)]").not.toMatch(
      RAW_AMBER_TEXT,
    );
    expect("decoration-[var(--color-brand-accent)]").not.toMatch(
      RAW_AMBER_TEXT,
    );
    expect("bg-[var(--color-brand-accent)]").not.toMatch(RAW_AMBER_TEXT);
  });
});
