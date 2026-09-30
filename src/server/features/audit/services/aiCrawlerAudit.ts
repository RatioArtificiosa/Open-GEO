import robotsParser from "robots-parser";

/**
 * Are AI crawlers allowed to read this site?
 *
 * ## Why this is the audit's most important check
 *
 * Everything else in the readiness audit is a quality judgement. This one is a
 * **switch**. A site that blocks GPTBot cannot be quoted by ChatGPT, discussed in
 * an AI Overview, or cited by a retrieval step, no matter how well-written it is —
 * the content is simply never read. So it belongs first in the fix list every
 * time, and it is the one finding where a customer can act in five minutes and see
 * the consequence.
 *
 * ## The crawlers, and why each is on the list
 *
 * These are the agents whose retrieval actually shapes answers, not an exhaustive
 * list of everything with "bot" in the name. Each is named because a reader
 * needs to know *which* one is blocked to act, and "an AI crawler is blocked"
 * sends them to the wrong file.
 *
 * - `GPTBot` — OpenAI's crawler, and the one behind ChatGPT browsing.
 * - `OAI-SearchBot` — the *search* index. Distinct from GPTBot on purpose:
 *   blocking it removes the brand from ChatGPT's search results while leaving
 *   training and browsing untouched, and plenty of sites have done exactly that
 *   without meaning to. They are reported separately for that reason.
 * - `ChatGPT-User` — the user-triggered fetch.
 * - `ClaudeBot` — Anthropic.
 * - `PerplexityBot` — a search engine in its own right, and the one most likely
 *   to be blocked deliberately.
 * - `Google-Extended` — controls Gemini/AI Overviews training. Note it does
 *   **not** control AI Overviews retrieval, which a lot of sites assume.
 * - `CCBot` — Common Crawl, which several vendors' retrieval stacks sit on.
 *
 * ## The three states, not two
 *
 * `blocked` · `allowed` · `unspecified`. The third is the one every naive
 * implementation loses, and it is a **finding, not a pass**: a robots.txt that
 * never names a crawler has said nothing about it, and a site that believes it
 * opted in when it opted out is exactly the customer this audit exists for.
 *
 * `robots-parser` resolves a missing rule to "allowed" — which is the HTTP
 * convention and almost certainly not what the owner intended, so the distinction
 * has to be recovered from the raw text rather than trusted from the parser.
 */

type AiCrawlerName =
  | "GPTBot"
  | "OAI-SearchBot"
  | "ChatGPT-User"
  | "ClaudeBot"
  | "PerplexityBot"
  | "Google-Extended"
  | "CCBot";

export const AI_CRAWLERS: readonly AiCrawlerName[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "CCBot",
];

type AiCrawlerStatus = "allowed" | "blocked" | "unspecified";

type AiCrawlerFinding = {
  crawler: AiCrawlerName;
  status: AiCrawlerStatus;
  /** The raw directive that decided it, verbatim. Null when none applied. */
  directive: string | null;
  /**
   * What to do, or null when nothing needs doing. A blocked crawler always has
   * one; an `unspecified` one has one too, because silence is a decision the
   * owner has to make on purpose.
   */
  fix: string | null;
};

type AiCrawlerReport = {
  /** False when robots.txt could not be read at all. A separate state. */
  robotsRead: boolean;
  findings: AiCrawlerFinding[];
  /** Crawlers that cannot read the site. The headline number. */
  blocked: AiCrawlerName[];
  /** Crawlers the file never mentions. Also a finding, not a pass. */
  unspecified: AiCrawlerName[];
  summary: string;
};

const FIX_BLOCKED =
  "Add a matching `Allow: /` line for this crawler, or remove the `Disallow` that blocks it. Until then this agent cannot read the site at all.";

const FIX_UNSPECIFIED =
  "robots.txt never names this crawler, so its access is decided by the default rather than by you. Say so explicitly — an unstated `Allow` is not the same as a stated one, and the difference matters if the default ever changes.";

/**
 * Judge every AI crawler against a robots.txt body.
 *
 * Pure and deterministic: same text in, same report out, with no network. That
 * is deliberate — the crawler workflow checkpoints the robots text as durable
 * step state and re-derives this on replay, and a fetch here would make replay
 * non-deterministic.
 */
export function auditAiCrawlers(robotsText: string | null): AiCrawlerReport {
  if (robotsText === null) {
    return {
      robotsRead: false,
      findings: [],
      blocked: [],
      unspecified: [],
      summary:
        "robots.txt could not be read, so AI crawler access is unknown. That is not a pass — it is the most common reason a site nobody can quote has a perfectly good robots.txt.",
    };
  }

  // A **full URL**, not a bare path. `robots-parser` matches rules against the
  // path component and returns `undefined` for `"/"`, which the first version
  // read as "allowed" — so every blocked crawler was reported as reachable. That
  // is the worst possible direction for this check: a site that blocks GPTBot was
  // being told it was fine.
  const PROBE_URL = "https://robots-probe.invalid/";

  const robots = robotsParser(`${PROBE_URL}robots.txt`, robotsText);
  const findings = AI_CRAWLERS.map((crawler) =>
    judge(robots, robotsText, crawler, PROBE_URL),
  );

  const blocked = findings
    .filter((f) => f.status === "blocked")
    .map((f) => f.crawler);
  const unspecified = findings
    .filter((f) => f.status === "unspecified")
    .map((f) => f.crawler);

  const report: AiCrawlerReport = {
    robotsRead: true,
    findings,
    blocked,
    unspecified,
    summary: "",
  };
  report.summary = describe(report);
  return report;
}

function judge(
  robots: ReturnType<typeof robotsParser>,
  rawText: string,
  crawler: AiCrawlerName,
  probeUrl: string,
): AiCrawlerFinding {
  const directive = findDirective(rawText, crawler);

  // The parser resolves "no rule" to allowed, so its answer is only meaningful
  // once we know a rule governs this crawler. Checking the raw text first is
  // what keeps `unspecified` from collapsing into a pass.
  //
  // **The wildcard counts.** The first version searched only for a line naming
  // the crawler, so `User-agent: *` + `Disallow: /` — the single most common real
  // cause of a site no AI can quote — read as *unspecified* on every agent. A
  // crawler inherits the wildcard group, so an absent name does not mean an
  // absent rule.
  if (directive === null && !hasWildcardGroup(rawText)) {
    return {
      crawler,
      status: "unspecified",
      directive: null,
      fix: FIX_UNSPECIFIED,
    };
  }
  const isAllowed = robots.isAllowed(probeUrl, crawler) ?? true;
  return {
    crawler,
    status: isAllowed ? "allowed" : "blocked",
    directive,
    fix: isAllowed ? null : FIX_BLOCKED,
  };
}

/**
 * Does the file contain a `User-agent: *` group?
 *
 * The wildcard is the group every un-named crawler falls into, so its presence
 * is what makes "this crawler is governed by a rule it never named" possible —
 * and that is the case a name-only search silently missed.
 *
 * `User-agent: *` is the one comma-separated form we can rely on, because
 * `robots-parser` recognises the bare wildcard. It does **not** recognise
 * `User-agent: GPTBot, ClaudeBot` — verified against the library, which reports
 * every agent as allowed when the only group is a comma-separated one. A file
 * that blocks two AI agents on a single line therefore reads as `unspecified`
 * for both: "we could not read the rule" rather than "they are allowed". That
 * errs toward investigation instead of a false all-clear, which is the right
 * direction for a check whose failure mode is otherwise invisible.
 */
function hasWildcardGroup(text: string): boolean {
  for (const line of text.split("\n")) {
    const match = /^user-agent\s*:\s*(.+)$/i.exec(line.trim());
    if (match === null) continue;
    const named = (match[1] ?? "").split(",").map((part) => part.trim());
    if (named.includes("*")) return true;
  }
  return false;
}

/**
 * The line that names this crawler, verbatim.
 *
 * Matched case-insensitively because `gptbot` and `GPTBot` both appear in the
 * wild and robots.txt user-agent matching is case-insensitive per the spec — a
 * case-sensitive search would report a real directive as *absent* and then call
 * the crawler unspecified.
 */
function findDirective(text: string, crawler: AiCrawlerName): string | null {
  const wanted = crawler.toLowerCase();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = /^user-agent\s*:\s*(.+)$/i.exec(trimmed);
    if (match === null) continue;
    const named = (match[1] ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase());
    if (named.includes(wanted)) return trimmed;
  }
  return null;
}

function describe(report: AiCrawlerReport): string {
  if (!report.robotsRead) return report.summary;

  const parts: string[] = [];
  if (report.blocked.length > 0) {
    parts.push(
      `${report.blocked.length} AI crawler${report.blocked.length === 1 ? " is" : "s are"} blocked from reading this site (${report.blocked.join(", ")}). Until that changes, nothing on it can be cited by those engines — this is not a ranking factor, it is a switch.`,
    );
  } else {
    parts.push("No AI crawler is blocked from reading this site.");
  }
  if (report.unspecified.length > 0) {
    parts.push(
      `${report.unspecified.length} (${report.unspecified.join(", ")}) ${report.unspecified.length === 1 ? "is" : "are"} never named in robots.txt, so access is decided by the default rather than by you.`,
    );
  }
  // Each part already ends in a full stop, so the join is the whole sentence. The
  // earlier version appended one unconditionally and then stripped a doubled
  // period with a regex, which is two steps to undo one mistake.
  return parts.join(" ");
}
