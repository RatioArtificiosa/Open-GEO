import type { ContentFormat } from "@/server/features/content/intent-format";
import type { BuildRecommendation } from "@/server/features/content/whatToBuild";

/**
 * Machine content briefs (CL-725 core, vendor-free half).
 *
 * A brief is assembled FROM a what-to-build recommendation — its formats,
 * its score with the version attached, its reason, its competitor domains —
 * so the brief never contradicts the diagnosis it was built from. Every
 * section names its source: a format rule, a competitor gap, or SERP
 * evidence. A section that cannot name a source is not written, because an
 * unsourced section is the brief inventing strategy.
 *
 * The machine outline slot (`subTopics`) is null until the funding-day
 * `generate_sub_topics` call populates it ($0.0001/task, Content Generation
 * family, currently 50304 on this account). Null here is the documented
 * absence the vendor half fills — not an empty outline pretending the work
 * was done, and never a fabricated list of sub-topics.
 */

export const CONTENT_BRIEF_VERSION = "1.0.0-machine";

type BriefSectionSource = "format-rule" | "competitor-gap" | "serp-evidence";

type BriefSection = {
  heading: string;
  source: BriefSectionSource;
  /** Why this section exists, in the recommendation's own terms. */
  rationale: string;
};

export type ContentBrief = {
  briefVersion: string;
  keyword: string;
  /** Eligible formats, winner first — the recommendation's order, kept. */
  formats: ContentFormat[];
  score: number;
  scoreVersion: string;
  /** The recommendation's reason, verbatim: the diagnosis travels with the brief. */
  diagnosis: string;
  sections: BriefSection[];
  competitorDomains: string[];
  /**
   * Machine outline from `generate_sub_topics`. Null until the vendor half
   * runs — the slot is the contract, not the content.
   */
  subTopics: string[] | null;
};

function formatSection(
  format: ContentFormat,
  recommendation: BuildRecommendation,
): BriefSection {
  return {
    heading: `${recommendation.keyword}: ${format}`,
    source: "format-rule",
    rationale:
      `The ${format} format is eligible for this keyword's intent, ` +
      `per the intent-format table (score ${recommendation.score}, ${recommendation.scoreVersion}).`,
  };
}

/**
 * Assemble a brief from a recommendation. Pure: no I/O, no clock, no vendor
 * call — the vendor reads arrived as the recommendation's arguments, which
 * is where the metering already lives.
 */
export function buildContentBrief(
  recommendation: BuildRecommendation,
): ContentBrief {
  const sections: BriefSection[] = recommendation.formats.map((format) =>
    formatSection(format, recommendation),
  );
  if (recommendation.serpEvidence !== null) {
    sections.push({
      heading: `Mirror what the SERP already cites: ${recommendation.serpEvidence}`,
      source: "serp-evidence",
      rationale:
        `The SERP shows ${recommendation.serpEvidence}, which the intent ` +
        `table does not bless for this keyword — kept as evidence to mirror, ` +
        `not as a format to build.`,
    });
  }
  for (const domain of recommendation.competitorDomains) {
    sections.push({
      heading: `Cover what ${domain} covers, and say what it omits`,
      source: "competitor-gap",
      rationale:
        `${domain} already ranks for this keyword; the brief earns its ` +
        `existence by naming what that coverage leaves out.`,
    });
  }
  return {
    briefVersion: CONTENT_BRIEF_VERSION,
    keyword: recommendation.keyword,
    formats: [...recommendation.formats],
    score: recommendation.score,
    scoreVersion: recommendation.scoreVersion,
    diagnosis: recommendation.reason,
    sections,
    competitorDomains: [...recommendation.competitorDomains],
    subTopics: null,
  };
}
