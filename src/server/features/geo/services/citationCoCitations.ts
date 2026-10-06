import { sortBy } from "remeda";
import { hostOf } from "./urlIdentity";

/**
 * Co-citation: which sources the AI engines reach for *together*.
 *
 * The graph needs edges, and the archive already holds them: `geo_answer_citations`
 * records the pages each answer cited, so "these two domains were cited in the
 * same answer" is a fact we observed rather than one we inferred. **That is the
 * whole reason this is a graph and not a decoration** — an edge here is a joint
 * citation, and its weight is how many archived answers made that pairing.
 *
 * ## Two decisions that keep the graph readable, and both are §14.4's
 *
 * §14.4 is explicit that the ranked list comes *first* and the force graph second:
 * *"Most teams won't read a hairball."* So this caps hard — the top
 * `maxDomains` by answer count, and the top `maxLinks` pairs. **A graph of every
 * domain a run touched is not a better graph; it is an unreadable one**, and the
 * cap is the difference between a picture of the field and a picture of nothing.
 *
 * ## Why the join happens here and not in SQL
 *
 * The pairs are derived in code from one flat read of (answer, domain) rows. A
 * self-join in SQL would need a table alias, this repository uses none, and the
 * pair-building loop is where the actual decisions live — the caps, the
 * tie-breaks, the de-duplication — so putting it in a pure function is what makes
 * those testable without a database. The read stays portable across both dialects
 * and stays an indexed `WHERE snapshot_id = ?`.
 *
 * ## The pair key is `|`, not a NUL
 *
 * A NUL is the conventional join character and it **put two NUL bytes into a
 * committed module once already** (see the ledger). A hostname cannot contain
 * `|`, so the separator is a character a diff can show and a reader can check.
 */

/**
 * One citation as the archive stores it. **Not exported** — it is the parameter
 * type of the one function below, and an exported type nothing imports is a claim
 * about the API surface that is not true (knip caught exactly that).
 */
type CoCitationRow = {
  /** The answer the citation came from — the grouping key for a pairing. */
  answerId: string;
  domain: string | null;
};

export type CoCitationNode = {
  domain: string;
  /** How many distinct archived answers cited this domain. */
  answers: number;
};

export type CoCitationLink = {
  /** The two domains, lexically ordered so a pair has one representation. */
  a: string;
  b: string;
  /** How many archived answers cited both. Never zero. */
  answers: number;
};

const SEP = "|";

export function buildCoCitations(
  rows: CoCitationRow[],
  options: { maxDomains?: number; maxLinks?: number } = {},
): { nodes: CoCitationNode[]; links: CoCitationLink[] } {
  const maxDomains = options.maxDomains ?? 24;
  const maxLinks = options.maxLinks ?? 120;

  // One answer, one mention of a domain — a page cited twice in the same answer
  // is one answer, not two. The composite primary key upstream already
  // de-duplicates by URL, and this de-duplicates by host on top of it.
  const domainsByAnswer = new Map<string, Set<string>>();
  for (const row of rows) {
    const domain = hostOf(row.domain);
    if (domain === null) continue;
    const set = domainsByAnswer.get(row.answerId) ?? new Set<string>();
    set.add(domain);
    domainsByAnswer.set(row.answerId, set);
  }

  const answerCount = new Map<string, number>();
  for (const domains of domainsByAnswer.values()) {
    for (const domain of domains) {
      answerCount.set(domain, (answerCount.get(domain) ?? 0) + 1);
    }
  }

  // Ties break on the domain name so the output is deterministic — an unstable
  // order would make both the test and the picture flicker between runs.
  const nodes = sortBy(
    [...answerCount.entries()].map(([domain, answers]) => ({
      domain,
      answers,
    })),
    [(node) => node.answers, "desc"],
    [(node) => node.domain, "asc"],
  ).slice(0, maxDomains);

  const kept = nodes.map((node) => node.domain);
  const pairCount = new Map<string, number>();
  for (const domains of domainsByAnswer.values()) {
    const present = kept.filter((domain) => domains.has(domain));
    // Only domains that survived the cap can form an edge. A pair whose partner
    // was cut is not a weaker edge — it is an edge to something not drawn.
    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const [a, b] =
          present[i] < present[j]
            ? [present[i], present[j]]
            : [present[j], present[i]];
        const key = `${a}${SEP}${b}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const links = sortBy(
    [...pairCount.entries()].map(([key, answers]) => {
      const [a, b] = key.split(SEP);
      return { a: a ?? "", b: b ?? "", answers };
    }),
    [(link) => link.answers, "desc"],
    [(link) => link.a, "asc"],
    [(link) => link.b, "asc"],
  ).slice(0, maxLinks);

  return { nodes, links };
}
