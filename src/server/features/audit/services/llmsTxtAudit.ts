/**
 * Judging somebody else's `llms.txt`.
 *
 * ## Why this is not the same module as the renderer
 *
 * `llms-txt.ts` (CL-214) *emits* our own file. This one grades a customer's.
 * They share a format, not a job, and the temptation to reuse the renderer's
 * section list would be exactly backwards — a file that lists only the sections
 * *we* emit would be a valid file by construction and therefore grade nothing.
 *
 * So the rules here are the spec's, not our habits, and where the spec is silent
 * the check says so rather than inventing a standard.
 *
 * ## What is actually worth checking
 *
 * An `llms.txt` is a markdown outline. Three things make one useful and two
 * mistakes make it useless, and the checks are ordered by how much they change
 * whether an agent can use the file at all:
 *
 * 1. **It exists.** Everything below is moot otherwise.
 * 2. **It has an H1.** A file with no title has no subject, and an agent
 *    summarising it has to guess what it describes.
 * 3. **It has links.** A prose file with no links is documentation, not an
 *    outline — there is nothing to fetch.
 * 4. **Its links are absolute.** Relative links resolve against whatever base the
 *    agent happens to assume, which is the single most common way a correct-looking
 *    file silently does nothing.
 *
 * ## What this check deliberately does not do
 *
 * It does not measure "comprehensiveness" as a number. An earlier draft scored
 * the file out of 10 and called it comprehensive at 7, which is a claim with no
 * definition behind it and no way for a customer to act on. What it reports
 * instead is a set of **named, individually checkable defects** — because a
 * score tells someone they are mediocre and a list tells them what to change.
 */
type LlmsTxtIssue = {
  code: "missing" | "no_title" | "no_links" | "relative_links" | "not_markdown";
  /** What is wrong, in words. Never "invalid". */
  problem: string;
  /** What to change. Null when the issue is the file's absence itself. */
  fix: string | null;
  /** A copy-pasteable line, when one exists. */
  example: string | null;
};

type LlmsTxtReport = {
  /** False when the file could not be fetched at all. A separate state. */
  fetched: boolean;
  issues: LlmsTxtIssue[];
  /** How many `- [title](url)` entries we found. Diagnostics, not a score. */
  linkCount: number;
  byteLength: number;
  /** True only when `issues` is empty. Absence of a fetch is not a pass. */
  valid: boolean;
  summary: string;
};

const H1 = /^#\s+\S/m;
/** `- [title](url)` — the spec's entry form. */
const LINK = /^-\s*\[([^\]]*)\]\(([^)]+)\)/gm;

export function auditLlmsTxt(
  body: string | null,
  /**
   * The site's own origin, used to spell out what each relative link *resolves
   * to* — which is the whole point of the finding. "Use absolute URLs" is advice;
   * showing that `/docs` should be `${origin}/docs` is a fix the reader can check.
   */
  origin: string,
): LlmsTxtReport {
  if (body === null) {
    const report: LlmsTxtReport = {
      fetched: false,
      issues: [
        {
          code: "missing",
          problem:
            "No llms.txt was found at /llms.txt, so an agent onboarding here has nothing to read.",
          fix: 'Publish one at https://<your-domain>/llms.txt and link it from your homepage with rel="describedby".',
          example:
            "# Your Company\n\n> What you do, in one or two sentences.\n\n## Start here\n\n- [Homepage](https://example.com/): What this is.",
        },
      ],
      linkCount: 0,
      byteLength: 0,
      valid: false,
      summary: "",
    };
    report.summary = describe(report);
    return report;
  }

  const issues: LlmsTxtIssue[] = [];

  if (!H1.test(body)) {
    issues.push({
      code: "no_title",
      problem:
        "The file has no H1 title, so an agent has to infer what the site is before it can use anything in it.",
      fix: "Start the file with a single H1 naming the site.",
      example: "# Your Company",
    });
  }

  const links = [...body.matchAll(LINK)];
  const relativeUrls = links
    .filter((m) => !/^https?:\/\//i.test((m[2] ?? "").trim()))
    .map((m) => (m[2] ?? "").trim());

  if (links.length === 0) {
    issues.push({
      code: "no_links",
      problem:
        "The file contains no links, so it is a description rather than an outline — there is nothing for an agent to fetch.",
      fix: "Add `- [Title](https://absolute-url): what an agent gets there.` entries, grouped under H2 headings.",
      example:
        "## Documentation\n\n- [Getting started](https://example.com/docs/start): Install and first run.",
    });
  } else if (relativeUrls.length > 0) {
    const first = relativeUrls[0] ?? "";
    issues.push({
      code: "relative_links",
      // Two independent plural axes, and this file got both wrong at different
      // times: the noun follows the *total* ("1 of 2 links"), the verb follows
      // the *count being reported* ("is", because one link is relative). The
      // sentence reads as broken either way when they are swapped, which matters
      // on a page whose whole job is sounding precise.
      problem: `${relativeUrls.length} of ${links.length} link${links.length === 1 ? "" : "s"} ${relativeUrls.length === 1 ? "is" : "are"} relative, so they resolve against whatever base the agent assumes rather than against your site.`,
      fix: `Use absolute URLs. "${first}" should be "${origin}${first}" — a relative link that resolves wrongly fails silently: the agent reads a different page and reports it.`,
      example: `- [Pricing](${origin}/pricing): Plans and limits.`,
    });
  }

  const report: LlmsTxtReport = {
    fetched: true,
    issues,
    linkCount: links.length,
    byteLength: body.length,
    valid: issues.length === 0,
    summary: "",
  };
  report.summary = describe(report);
  return report;
}

function describe(report: LlmsTxtReport): string {
  if (!report.fetched) {
    return "No llms.txt was found. Agents that honour the convention will fall back to fetching your homepage and guessing, which is exactly the outcome the file exists to prevent.";
  }
  if (report.valid) {
    return `llms.txt looks sound: ${report.linkCount} absolute link${report.linkCount === 1 ? "" : "s"} under a titled outline, ${report.byteLength} bytes.`;
  }
  return `llms.txt has ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}: ${report.issues
    .map((i) => i.code)
    .join(
      ", ",
    )}. Each one is a named fix rather than a score, because a score says you are mediocre and a list says what to change.`;
}
