/**
 * The AI Citability Score: how likely is this page to be cited by an AI answer?
 *
 * Five factors, per §8.2. The interesting decision is not what they are but how
 * they are allowed to combine, because four of the five are *heuristics we wrote*
 * and the fifth is a *measurement*.
 *
 * ## A heuristic is not a measurement, and the score must not blur them
 *
 * "Answer-first structure" and "schema coverage" are our own opinions about what
 * makes a page quotable. They are defensible, they are what the product's edge is
 * built on, and **we have no way to check them against a real answer.** A score
 * that blends them with a measured factor and reports one number is claiming a
 * precision it does not have — the same failure as the 198× cross-platform sum,
 * one level up.
 *
 * So each factor reports on its own, and the headline carries its **own** coverage:
 * how much of the score is heuristic and how much is measured. A page we have
 * archived answers for is a finding; a page we have only opinions about is a
 * checklist. Both are useful. Presenting the second as though it were the first is
 * how a customer ends up rewriting a page that was never going to be cited.
 *
 * ## No zero-filling
 *
 * A factor we could not evaluate is **absent**, not zero. The crawl may not have
 * fetched robots.txt, the schema may be unparseable, the archive may hold no
 * answers for this URL. Absent means "we do not know", and averaging an unknown in
 * as a zero is the single most common way a composite score becomes a lie: it
 * makes a page we could not measure look bad, which is both wrong and the fastest
 * way to lose a customer's trust in the number.
 *
 * ## Weights
 *
 * The weights are **our opinion, and they sum to 1** so a renormalised coverage
 * is meaningful. They are also printed with the score, because a weight table
 * nobody can see is how a "0–100" becomes unfalsifiable. The competitive-density
 * weight is deliberately the largest, since it is the only factor derived from
 * observed behaviour rather than from a rubric.
 */

type CitabilityFactorId =
  | "entity_definition"
  | "answer_first"
  | "question_headers"
  | "schema_coverage"
  | "crawlable"
  | "competitive_density";

type FactorVerdict = {
  id: CitabilityFactorId;
  /** 0–1, or null when the factor could not be evaluated. */
  score: number | null;
  /** Heuristic factors are our opinion; measured ones come from the archive. */
  basis: "heuristic" | "measured";
  weight: number;
  /** The one thing to change, in words. Null when the factor passed. */
  fix: string | null;
  /** What we could not check, when `score` is null. */
  unavailable: string | null;
};

type CitabilityResult = {
  /** 0–100 over the factors that *were* evaluated, or null if none were. */
  score: number | null;
  /** Share of the total weight that was actually evaluated, 0–1. */
  coverage: number;
  /** The share of evaluated weight that is heuristic rather than measured. */
  heuristicShare: number | null;
  factors: FactorVerdict[];
  /** A sentence saying what this number is, and what it is not. */
  summary: string;
  /** The one change with the most weight behind it, or null. */
  topFix: FactorVerdict | null;
};

/**
 * Our rubric, stated so it can be argued with. Sums to 1.
 *
 * `competitive_density` carries the most weight because it is the only factor
 * derived from observed behaviour rather than from a rubric — the `basis` on each
 * factor says so per-factor, and a test asserts the score can *report* an
 * all-heuristic result, so a table and a per-factor literal cannot drift apart
 * without one of them failing.
 */
export const WEIGHTS: Record<CitabilityFactorId, number> = {
  // The only factor derived from observed behaviour rather than a rubric.
  competitive_density: 0.35,
  answer_first: 0.2,
  entity_definition: 0.15,
  crawlable: 0.12,
  question_headers: 0.1,
  schema_coverage: 0.08,
};

const BASIS: Record<CitabilityFactorId, "heuristic" | "measured"> = {
  competitive_density: "measured",
  answer_first: "heuristic",
  entity_definition: "heuristic",
  crawlable: "heuristic",
  question_headers: "heuristic",
  schema_coverage: "heuristic",
};

/** What the crawler and the archive actually found. Everything is nullable. */
export type CitabilityInput = {
  /** Did the page define its subject unambiguously? 0–1, or null if not analysed. */
  entityDefinition: number | null;
  /** Does the page lead with the answer? 0–1, or null. */
  answerFirst: number | null;
  /** Fraction of `h2`/`h3` headings that are questions. 0–1, or null. */
  questionHeaderRatio: number | null;
  /** Schema.org types found on the page. Null when the parser did not run. */
  schemaTypes: string[] | null;
  /** Can GPTBot read it? null when robots.txt was not fetched. */
  aiCrawlerAllowed: boolean | null;
  /**
   * How often this URL was cited, over how many archived answers it appeared in.
   * Both nullable: no archived answers for this URL means *no measurement*, which
   * is different from a measurement of zero.
   */
  citationsObserved: number | null;
  answersObserved: number | null;
  /**
   * How many *other* pages were cited in those same answers. This is the
   * denominator that makes competitive density a share rather than a count — a
   * page cited 3 times in an answer that cited nothing else is a different
   * finding from one cited 3 times in an answer that cited nine others.
   */
  competingPagesCited: number | null;
};

export function scoreCitability(input: CitabilityInput): CitabilityResult {
  const factors: FactorVerdict[] = [
    heuristic(
      "entity_definition",
      input.entityDefinition,
      WEIGHTS.entity_definition,
      [
        "Say what this page is about, for whom, in the first paragraph. A model quoting you needs a noun phrase to attach the quote to.",
      ],
    ),
    heuristic("answer_first", input.answerFirst, WEIGHTS.answer_first, [
      "Lead with the answer, then the reasoning. A model quotes the first complete claim it finds, not the best one on the page.",
    ]),
    heuristic(
      "question_headers",
      input.questionHeaderRatio,
      WEIGHTS.question_headers,
      [
        "Phrase headings as the questions people actually ask. A quoted answer is nearly always a response to a question, and a heading that is not a question is invisible to that match.",
      ],
    ),
    schemaFactor(input),
    crawlableFactor(input),
    densityFactor(input),
  ];

  const evaluated = factors.filter((f) => f.score !== null);
  const evaluatedWeight = evaluated.reduce((sum, f) => sum + f.weight, 0);
  const heuristicWeight = evaluated
    .filter((f) => f.basis === "heuristic")
    .reduce((sum, f) => sum + f.weight, 0);

  const weighted = evaluated.reduce((sum, f) => sum + f.score! * f.weight, 0);
  const score =
    evaluated.length === 0
      ? null
      : Math.round((weighted / evaluatedWeight) * 100);

  const result: CitabilityResult = {
    score,
    coverage: evaluatedWeight,
    heuristicShare:
      evaluatedWeight === 0 ? null : heuristicWeight / evaluatedWeight,
    factors,
    summary: "",
    topFix: null,
  };
  result.summary = describe(result);
  // The biggest available win: the failing factor with the most weight behind it.
  // Weight, not score, because a low-weight factor is not worth the customer's
  // afternoon however easy it is to fix.
  let best: FactorVerdict | null = null;
  for (const factor of evaluated) {
    if (factor.score === null || factor.score >= 0.8) continue;
    if (best === null || factor.weight > best.weight) best = factor;
  }
  result.topFix = best;
  return result;
}

function heuristic(
  id: CitabilityFactorId,
  score: number | null,
  weight: number,
  fixes: string[],
): FactorVerdict {
  const checked = score !== null;
  return {
    id,
    score,
    basis: BASIS[id],
    weight,
    fix: !checked || (score ?? 0) >= 0.8 ? null : (fixes[0] ?? null),
    unavailable: checked ? null : "This page was not analysed for this factor.",
  };
}

function schemaFactor(input: CitabilityInput): FactorVerdict {
  const weight = WEIGHTS.schema_coverage;
  if (input.schemaTypes === null) {
    return {
      id: "schema_coverage",
      score: null,
      basis: "heuristic",
      weight,
      fix: null,
      unavailable: "Schema.org markup was not parsed for this page.",
    };
  }
  // Presence is most of it. Rich result coverage is a search feature; a model
  // reading the page benefits from a type and an entity name, and we have no
  // evidence that the full rich-result vocabulary changes what gets quoted.
  const score =
    input.schemaTypes.length === 0
      ? 0
      : Math.min(1, 0.5 + input.schemaTypes.length * 0.25);
  return {
    id: "schema_coverage",
    score,
    basis: BASIS.schema_coverage,
    weight,
    fix:
      score >= 0.8
        ? null
        : "Add one schema.org type that describes what the page is (Article, FAQPage, Product, Organization).",
    unavailable: null,
  };
}

function crawlableFactor(input: CitabilityInput): FactorVerdict {
  const weight = WEIGHTS.crawlable;
  if (input.aiCrawlerAllowed === null) {
    return {
      id: "crawlable",
      score: null,
      basis: "heuristic",
      weight,
      fix: null,
      unavailable: "robots.txt was not fetched, so crawler access is unknown.",
    };
  }
  return {
    id: "crawlable",
    score: input.aiCrawlerAllowed ? 1 : 0,
    basis: "heuristic",
    weight,
    // A blocked crawler is not a content problem, and telling someone to rewrite
    // their page would be the wrong advice entirely.
    fix: input.aiCrawlerAllowed
      ? null
      : "GPTBot is blocked in robots.txt. Nothing on this page can be cited until that changes, and no content edit will help.",
    unavailable: null,
  };
}

/**
 * Competitive density — the one measured factor.
 *
 * It is a *share* of the citations seen in the answers this page appeared in, not
 * a count, because a count without a denominator is not a finding. And it is null
 * rather than zero when we have no answers, because "never observed" and
 * "observed and not chosen" are the two findings a customer acts on differently.
 */
function densityFactor(input: CitabilityInput): FactorVerdict {
  const weight = WEIGHTS.competitive_density;
  const id: CitabilityFactorId = "competitive_density";

  if (input.answersObserved === null) {
    return {
      id,
      score: null,
      basis: "measured",
      weight,
      fix: null,
      unavailable:
        "No archived answers mention this page, so there is nothing to measure against.",
    };
  }
  if (input.answersObserved === 0) {
    return {
      id,
      score: null,
      basis: "measured",
      weight,
      // Its own fix, because "never retrieved" is a *reachability* finding and
      // the generic "be more quotable" advice would be useless here. Telling
      // someone to rewrite a page the models have never seen is the same
      // mistake as telling someone to edit copy when their crawler is blocked.
      fix: "This page has never been retrieved in an archived answer, so it has not had the chance to be cited. Check crawlability and whether the topic is asked at all before rewriting anything.",
      unavailable:
        "This page has never been retrieved in an archived answer, so it has not had the chance to be cited.",
    };
  }
  if (input.citationsObserved === null || input.competingPagesCited === null) {
    return {
      id,
      score: null,
      basis: "measured",
      weight,
      fix: null,
      unavailable:
        "The page was retrieved but the citation set for those answers was not recorded.",
    };
  }

  // Share of the total citation slots this page took. `+1` on the denominator is
  // Laplace smoothing: a page cited once out of one slot is 50%, not 100%, and
  // the reason is that one observation is one observation.
  const share = (input.citationsObserved + 1) / (input.competingPagesCited + 2);
  const score = Math.min(1, share);

  return {
    id,
    score,
    basis: "measured",
    weight,
    fix:
      score >= 0.8
        ? null
        : `This page was cited in ${input.citationsObserved} of ${input.answersObserved} archived answers that cited ${input.competingPagesCited} pages. Being retrieved is not the problem; being chosen is.`,
    unavailable: null,
  };
}

function describe(result: CitabilityResult): string {
  if (result.score === null) {
    return "Nothing could be evaluated for this page, so there is no citability score. That is not a zero.";
  }
  const parts = [`Citability ${result.score}/100`];
  parts.push(`based on ${Math.round(result.coverage * 100)}% of the rubric`);
  if (result.coverage < 0.6) {
    parts.push(
      "which is too little of it to call a measurement — treat this as a checklist, not a finding",
    );
  } else if (result.heuristicShare !== null && result.heuristicShare === 1) {
    parts.push(
      "and all of it is our rubric rather than observed behaviour, so it says nothing about whether AI actually cites this page",
    );
  } else {
    parts.push(
      `${Math.round((1 - (result.heuristicShare ?? 0)) * 100)}% of which is observed behaviour rather than our opinion`,
    );
  }
  return `${parts.join(", ")}.`;
}
