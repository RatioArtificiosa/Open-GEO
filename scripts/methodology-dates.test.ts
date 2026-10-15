import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every metric published on the methodology page carries the date it was
 * measured, and the ETV-derived ones name the era they were measured in.
 *
 * ## Why this exists, and why it is a source scan
 *
 * A methodology page is a claim about what a number *means*, and a claim without
 * a date stops being true the day the vendor changes the model. The cost of that
 * is not a wrong number — it is a right number read against the wrong model,
 * which is the failure the ETV versioning rule exists for.
 *
 * The deadline makes it concrete. **DataForSEO's ETV formula becomes the default
 * on 2026-11-01**, and the historical endpoints are excluded from the new model,
 * so a figure measured today cannot be restated tomorrow. After that date this
 * page becomes a liability the moment any metric moves — not because the page is
 * wrong, but because nothing on it says which era it describes. A date is the
 * fix, and it cannot be remembered into existence; it is either in the file or it
 * is absent.
 *
 * ## What counts as a date
 *
 * An ISO date, `2026-10-12`, in the section that describes the metric. Not the
 * file's own mtime, and not a year in prose — a date a reader can check against
 * the vendor's own changelog, on the day the number is read.
 *
 * ## What counts as "names the era"
 *
 * For the ETV-dependent metrics: the section says either that it is pre-cutover,
 * post-cutover, or that it spans the boundary. A metric that depends on a
 * formula that changed must say which formula produced it — the whole rule of
 * the version stamp, asserted at the one place a reader goes to interpret the
 * number.
 */

const PAGE = join(process.cwd(), "docs/METHODOLOGY.md");

/** A section of the metric reference, as its heading and its body. */
function metricSections(): { metric: string; body: string }[] {
  const source = readFileSync(PAGE, "utf8");
  const sections: { metric: string; body: string }[] = [];
  let inMetricReference = false;
  let current: { metric: string; lines: string[] } | null = null;

  const flush = () => {
    if (current)
      sections.push({ metric: current.metric, body: current.lines.join("\n") });
    current = null;
  };

  for (const line of source.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      // Only the metric reference is what this gate governs. A `## Cost
      // transparency` section is a pointer to the price book, not a metric, and
      // dating it would be dating a link.
      inMetricReference = line.trim() === "## Metric reference";
      continue;
    }
    if (line.startsWith("### ") && inMetricReference) {
      flush();
      current = { metric: line.slice(4).trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return sections;
}

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/**
 * The metrics whose values are a function of the ETV formula, directly or
 * through `estimated_paid_traffic_cost`.
 *
 * Named rather than inferred, because the dependency is not visible in the
 * metric's name: `estimated_paid_traffic_cost` derives from organic ETV and CPC,
 * so it moves when the formula moves, and a reader would not guess it.
 */
const ETV_DEPENDENT = [
  "Estimated Traffic Volume (ETV)",
  "AI Visibility Score (0–100)",
];

const sections = metricSections();
const undated = sections.filter((s) => !ISO_DATE.test(s.body));
const undatedEtv = sections.filter(
  (s) => ETV_DEPENDENT.includes(s.metric) && !ISO_DATE.test(s.body),
);
const eraLess = sections.filter(
  (s) =>
    ETV_DEPENDENT.includes(s.metric) &&
    ISO_DATE.test(s.body) &&
    !/2026-11-01|pre-cutover|post-cutover|formula version|etv_formula_version/i.test(
      s.body,
    ),
);

describe("the methodology page dates every metric it publishes", () => {
  it("reads a real number of metrics", () => {
    // The vacuity guard: a page restructured into no sections would pass every
    // assertion below by finding nothing to check.
    expect(sections.length).toBeGreaterThan(5);
    expect(sections.map((s) => s.metric)).toContain(
      "Estimated Traffic Volume (ETV)",
    );
  });

  it("carries an ISO date in every metric section", () => {
    expect(undated.map((s) => s.metric)).toEqual([]);
  });

  it("names the ETV era in the metrics that depend on it", () => {
    // Both directions: dated, because a date without an era still leaves the
    // ambiguous case, and undated for the same reason.
    expect(undatedEtv.map((s) => s.metric)).toEqual([]);
    expect(eraLess.map((s) => s.metric)).toEqual([]);
  });

  it("names the cutover, because that is the era boundary", () => {
    // 2026-11-01 is not a detail in a warning box; it is the date the two eras
    // divide at, and the page a reader consults to interpret a step in a traffic
    // line has to name it.
    const etv = sections.find(
      (s) => s.metric === "Estimated Traffic Volume (ETV)",
    );
    expect(etv?.body).toContain("2026-11-01");
  });

  it("would catch the metric that lost its date", () => {
    // The negative control, and it is the shape of the defect: a section that
    // reads well, is believed, and does not say when it was measured.
    //
    // Built as an array of lines because that is what a section body is, and
    // because the gate's job is to find a *section* with no date in it — not to
    // ask whether a lone string contains one, which a regex does by itself.
    const withDate = [
      "### Mentions",
      "",
      "A count of matching AI answer records. Measured 2026-10-12 against the",
      "vendor's own output.",
    ].join("\n");
    const without = [
      "### Mentions",
      "",
      "A count of matching AI answer records, measured against the vendor's own",
      "output.",
    ].join("\n");

    expect(ISO_DATE.test(withDate)).toBe(true);
    expect(ISO_DATE.test(without)).toBe(false);
    expect(eraLess.some((s) => ISO_DATE.test(s.body))).toBe(false);
  });
});
