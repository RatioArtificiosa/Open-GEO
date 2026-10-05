/**
 * Was the brand named in an answer?
 *
 * ## Why this rule is its own module with no database import
 *
 * It is a **text judgement**, not a measurement, and it sits directly on the
 * forecast's numerator. Two things follow from that, and the second is the one
 * that bit:
 *
 * 1. The result has to say *how* it decided. A `mentions_search` row is a hit
 *    because the vendor returned it; a `llm_responses` row is a hit because we
 *    found the brand in the text. Those are different kinds of evidence and a
 *    reader is entitled to know which one produced a number.
 * 2. **It must be testable without a database.** The first version lived beside
 *    the reader that uses it, imported `@/db` transitively, and its test died at
 *    import with `Cannot find package 'cloudflare:workers'`. That is the rule
 *    CL-200d-drain wrote down: *a rule that cannot be tested without infrastructure is
 *    a rule that will not be tested.*
 *
 * So the rule is here, pure, and the reader imports it. No Worker environment, no
 * migrations, no in-memory SQLite — a string in and a verdict out.
 */

/** How a stored answer tells us whether the brand was named. */
export type MentionEvidence = {
  /** Null when the answer text is not available, so the answer is unknown. */
  mentioned: boolean | null;
  /** Which rule produced it, so a reader can see what was measured. */
  basis:
    | "vendor-returned-hit"
    | "brand-found-in-text"
    | "brand-not-in-text"
    | "no-text";
};

const NO_TEXT: MentionEvidence = { mentioned: null, basis: "no-text" };

/**
 * Lower-case, strip scheme, `www.`, and a trailing slash — the identity a target
 * row already has, repeated here as a **parameter default** rather than an
 * import so this module stays free of the database.
 *
 * The caller passes the already-normalised domain from the target row, which is
 * the authoritative one; this fallback only exists so the rule is usable on its
 * own.
 */
function canonical(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/**
 * Whether the brand is named in an answer.
 *
 * The match is on the **domain**, not a marketing name: the target is stored as
 * a domain, and a brand is named by its site far more reliably than by a name we
 * were never given. The match is word-bounded so `acme.com` does not fire on
 * `notacme.com` or on prose that merely contains the letters.
 *
 * **`null` is a real answer here.** A queued answer body can be absent while the
 * vendor task is still pending, and "we have not read it" is not "the brand was
 * not named". Collapsing the two lets a pending task read as a lost mention —
 * the defect CL-309c refuses for alerting, and worse here because a rate is
 * shown to a customer as if it were measured.
 */
export function mentionFromAnswer(row: {
  source: string;
  answerText: string | null;
  domain: string;
  /**
   * The brand's other names, so "Acme" is recognised when the customer said that
   * is what the brand is called.
   *
   * Optional rather than required, so a caller with no aliases is an ordinary case
   * rather than something to remember to pass `[]`.
   */
  aliases?: readonly string[] | null;
}): MentionEvidence {
  if (row.source === "mentions_search") {
    // The endpoint only returns prompts that mentioned the brand, so the row's
    // existence is the evidence. That is a *vendor* judgement about the brand,
    // recorded as such rather than as our own reading of the text.
    return { mentioned: true, basis: "vendor-returned-hit" };
  }
  if (row.answerText === null) return NO_TEXT;

  // A blank *domain* means we cannot judge at all, which is a different answer
  // from "looked and found nothing". The first version of the alias refactor
  // collapsed the two by letting an empty needle fall through to the loop and
  // return `false`, and the existing control caught it immediately — `0` and
  // `null` are the pair this whole feature exists to keep apart, and a blank
  // domain is the `null` case.
  if (canonical(row.domain).length === 0) return NO_TEXT;

  // **The target's other names are needles too.** `geo_targets` has always carried
  // `name` and `aliases` — its own comment says "Brands are often wider than a
  // domain ('Acme' vs acme.com)" — and both were written, validated at the wire,
  // and then read by nothing at all. So an answer that said "Acme is the leader"
  // and never typed the domain was recorded as a miss: a customer who told us the
  // brand's name was better served by not telling us.
  for (const candidate of [row.domain, ...(row.aliases ?? [])]) {
    if (mentionsName(row.answerText, candidate)) {
      return { mentioned: true, basis: "brand-found-in-text" };
    }
  }
  return { mentioned: false, basis: "brand-not-in-text" };
}

/**
 * Whether one needle for this brand appears in the answer.
 *
 * The boundaries are the same rules the domain has always used, applied unchanged
 * to every alias — which is what keeps a *short* alias from matching inside
 * ordinary prose. A brand whose alias is "AI" would otherwise match "the AI model
 * was asked" and "check the IT team", inflating a rate on a common noun. That is
 * the same class of false positive as `notacme.com`.
 */
function mentionsName(answerText: string, rawNeedle: string): boolean {
  const needle = canonical(rawNeedle);
  // An empty needle would match everything, turning every queued answer into a
  // mention — a 100% visibility reading produced by a missing input. A blank alias
  // is skipped rather than treated as a wildcard.
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /**
   * Word-bounded, and the boundary excludes `.` as well as word characters.
   *
   * The first version used `[^\w-]`, which is right for `notacme.com` and
   * **wrong for `acme.com.br`** — a period is not a word character, so the
   * boundary accepted it and a different company in another TLD counted as our own
   * visibility. The negative control caught it, which is the control earning its
   * place.
   *
   * A host name ends at a space, punctuation or a slash, and the separator
   * before a real continuation is a dot. So the dot has to be on the *inside* of
   * the forbidden set.
   *
   * ## The three cases the boundaries still got wrong
   *
   * Excluding `.` from the boundary is correct for the *left* edge — it is what
   * stops `acme.com.br` — but a domain is routinely followed by a full stop, so
   * forbidding it on the right meant **`"Email us at acme.com."` did not count as
   * a mention.** The two edges need opposite rules, so the pattern is asymmetric:
   * strict before, permissive after.
   *
   * The text is lower-cased before matching, because an answer says `Acme.com`
   * and `WWW.Acme.COM` at least as often as it says the canonical form. The
   * needle was already lower-cased and the body never was, so every one of those
   * answers was a silent false negative — a *lost* mention, which is the
   * direction that under-reports rather than flatters, so nothing else in the
   * pipeline would have caught it.
   *
   * A leading `www.` is stripped from the answer text too: `www.acme.com` is the
   * same site, and the needle already has its own `www.` removed.
   */
  const haystack = answerText.toLowerCase();
  // The needle may or may not carry a `www.`, and the answer may carry one
  // whichever way round, so both spellings are tried.
  //
  // The two lookaheads are what stop the match running on into a *different*
  // site, and they are deliberately different rules:
  //
  // - `(?![\w])` refuses a word character next, so `acmeXcom` and `myacme.com`
  //   are not mentions.
  // - `(?!\.\w)` refuses a dot **followed by more of a host**, so `acme.com.br`
  //   is not a mention — while a dot at the end of a sentence still is. Without
  //   the second clause a plain "not a dot" rule refuses `acme.com.` and a
  //   sentence-ending mention is lost; with a blanket dot rule `acme.com.br`
  //   counts and another company's visibility is reported as ours.
  const bare = escaped.replace(/^www\\./, "");
  // The right-hand boundary treats a hyphen as part of the word, so `AI-driven`
  // is not the brand `AI`. That was found by the alias negative control: with a
  // plain "not a word character" rule the hyphen ended the match and every
  // compound adjective counted as a mention.
  //
  // Hyphenation after a *domain* is vanishingly rare in a real citation — a URL
  // continues with `/`, not `-` — so refusing it costs almost nothing. Refusing it
  // for a short alias is the difference between a mention rate and a count of
  // hyphenated compounds.
  const pattern = new RegExp(
    `(^|[^\\w.-])(?:www\\.)?${bare}(?![\\w-])(?!\\.\\w)`,
  );
  return pattern.test(haystack);
}
