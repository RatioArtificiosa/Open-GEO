import { describe, expect, it } from "vitest";
import { mentionFromAnswer, type MentionEvidence } from "./mentionFromAnswer";

/**
 * Read one verdict, typed as the exported contract.
 *
 * The annotation is load-bearing rather than decorative: `MentionEvidence` is the
 * shape the reader consumes, and annotating here means the type is exercised by
 * a real consumer instead of being an export nothing imports. It also makes the
 * three fields impossible to read out of order by accident.
 */
function verdict(args: {
  source: string;
  answerText: string | null;
  domain: string;
  aliases?: readonly string[] | null;
}): MentionEvidence {
  return mentionFromAnswer(args);
}

/**
 * Was the brand named in this answer?
 *
 * This is the one genuinely new piece of judgement in the forecast, and it
 * carries a failure mode that no other part of the reader does: **a queued
 * answer exists whether or not the brand appears in it.** The Live endpoint
 * only returns prompts that named the brand, so for those the row's existence
 * is the answer. The queued endpoint returns the answer to a question we asked,
 * full stop.
 *
 * So the default assumption — that every stored answer is a mention — is true
 * for one source and catastrophically wrong for the other. Getting it wrong does
 * not produce a bug report; it produces a dashboard reading **100% visibility,
 * forever, for every customer**, which looks like a triumph.
 */
describe("mentionFromAnswer", () => {
  it("treats a live hit as a mention, because the vendor only returns hits", () => {
    // `mentions_search` answers are stored with no body at all (CL-205/CL-308
    // established that is the normal case). So the row existing *is* the
    // evidence, and the basis says so rather than implying we read the text.
    const result = verdict({
      source: "mentions_search",
      answerText: null,
      domain: "acme.com",
    });
    expect(result.mentioned).toBe(true);
    expect(result.basis).toBe("vendor-returned-hit");
  });

  it("finds the brand in a queued answer", () => {
    const result = verdict({
      source: "llm_responses",
      answerText: "For teams like yours, acme.com is a common choice.",
      domain: "acme.com",
    });
    expect(result.mentioned).toBe(true);
    expect(result.basis).toBe("brand-found-in-text");
  });

  it("reports a queued answer that never names the brand", () => {
    // **The case the default assumption gets catastrophically wrong.** This
    // answer is a perfectly good answer to our question, stored in the archive,
    // and the brand is not in it. Counting it as a mention is how a project
    // ends up permanently at 100%.
    const result = verdict({
      source: "llm_responses",
      answerText:
        "Salesforce and HubSpot are the usual choices for small teams.",
      domain: "acme.com",
    });
    expect(result.mentioned).toBe(false);
    expect(result.basis).toBe("brand-not-in-text");
  });

  it("says it does not know when the answer text is missing", () => {
    // A queued task that has not come back yet. `false` here would tell a
    // customer they lost a mention we never looked up — the defect CL-309c
    // refuses for alerting, and worse in a rate because the number is shown as
    // measured.
    const result = verdict({
      source: "llm_responses",
      answerText: null,
      domain: "acme.com",
    });
    expect(result.mentioned).toBeNull();
    expect(result.basis).toBe("no-text");
  });

  it("does not match a longer domain that merely contains ours", () => {
    // `notacme.com` and `acme.com.br` are different companies. A substring
    // match would report a competitor's or an unrelated site's name as our own
    // visibility, which inflates the number in the flattering direction.
    for (const text of [
      "I would suggest notacme.com for that.",
      "Try acme.com.br instead.",
      "Search acme.company today.",
    ]) {
      const result = verdict({
        source: "llm_responses",
        answerText: text,
        domain: "acme.com",
      });
      expect(result.mentioned).toBe(false);
    }
  });

  it("counts a domain however the answer happens to spell it", async () => {
    // Four shapes that are all the same mention and all used to be missed.
    //
    // Each is a **false negative**, which is the direction that under-reports:
    // a mention we failed to see. Nothing else in the pipeline can catch it —
    // the forecast's interval would just quietly get wider and a reader would
    // believe the brand was less visible than it is.
    //
    // - **Case.** The needle was lower-cased and the body never was, so
    //   `Acme.com` missed while `acme.com` matched.
    // - **A leading `www.`**, which is the same site as the one the needle
    //   already has stripped.
    // - **A trailing full stop**, because the boundary forbade `.` on the right
    //   as well as the left. The left has to forbid it to reject `acme.com.br`;
    //   the right must not, or every sentence-ending mention is lost.
    // - **Surrounding punctuation**, which the original boundary also refused.
    const shapes = [
      "Acme.com reviews",
      "Visit WWW.Acme.COM now.",
      "Email us at acme.com.",
      "(acme.com)",
      "See https://acme.com/pricing for details.",
    ];
    for (const answerText of shapes) {
      const result = verdict({
        source: "llm_responses",
        answerText,
        domain: "acme.com",
      });
      expect(result.mentioned).toBe(true);
    }
  });

  it("still refuses a different company that merely looks similar", async () => {
    // The positive controls above are worthless without this one: a rule that
    // matched loosely would pass all five and inflate every number. These are
    // the cases the tightened boundaries exist to reject.
    for (const answerText of [
      "I would suggest notacme.com for that.",
      "Try acme.com.br instead.",
      "Search acme.company today.",
      "We recommend acmeXcom for that use case.",
      "Go to acme.co instead.",
      "myacme.com is unrelated.",
    ]) {
      const result = verdict({
        source: "llm_responses",
        answerText,
        domain: "acme.com",
      });
      expect(result.mentioned).toBe(false);
    }
  });

  it("recognises the brand by a name the customer supplied", async () => {
    // `geo_targets` has always had `name` and `aliases`, and its own comment says
    // "Brands are often wider than a domain ('Acme' vs acme.com)" — yet nothing
    // read either. So an answer that named the brand in prose and never typed the
    // domain was a silent **false negative**, and a customer who told us the
    // brand's name was worse off for having done so.
    for (const answerText of [
      "Acme is the leader in this category.",
      "ACME Corp came up twice.",
      "I would ask about Acme.",
    ]) {
      const result = verdict({
        source: "llm_responses",
        answerText,
        domain: "acme.com",
        aliases: ["Acme", "ACME Corp"],
      });
      expect(result.mentioned).toBe(true);
    }
  });

  it("still needs boundaries around an alias, or a short one matches anything", async () => {
    // The negative control for the aliases above, and it earns its place.
    //
    // A brand whose alias is a short common word would, without boundaries, match
    // inside ordinary prose — "an **AI**-driven workflow", "ask the **IT** team"
    // used to count as mentions, which is a rate built on hyphenated compounds.
    // That is the same class of false positive as `notacme.com`, and it is *more*
    // likely for aliases than for a domain precisely because people choose short
    // ones.
    //
    // **Note what is deliberately absent:** "The AI model was asked" and "ask the
    // IT team" are *not* in this list, because for a brand actually called AI or IT
    // they are honest mentions. A word-bounded match should fire on them, and a
    // control that asserted otherwise would be asserting the bug.
    for (const answerText of [
      "An AI-driven workflow is common.",
      "An IT-related process.",
      "AIpowered tools are everywhere.",
    ]) {
      const result = verdict({
        source: "llm_responses",
        answerText,
        domain: "acme.com",
        aliases: ["AI", "IT"],
      });
      expect(result.mentioned).toBe(false);
    }
  });

  it("ignores a blank alias rather than matching every answer", async () => {
    // An empty needle is a wildcard. A stray blank in the aliases column would
    // turn every queued answer into a mention — 100% visibility, which is exactly
    // the failure this function exists to prevent.
    for (const aliases of [["", "  "], null, undefined, []]) {
      const result = verdict({
        source: "llm_responses",
        answerText: "Nothing about this brand at all.",
        domain: "acme.com",
        aliases,
      });
      expect(result.mentioned).toBe(false);
    }
  });

  it("matches at the edges of the text", () => {
    // A brand at the very start or end of an answer is mentioned as surely as
    // one in the middle, and a `^`/`$` bug would quietly under-count.
    for (const text of ["acme.com is a leader here.", "I recommend acme.com"]) {
      const result = verdict({
        source: "llm_responses",
        answerText: text,
        domain: "acme.com",
      });
      expect(result.mentioned).toBe(true);
    }
  });

  it("refuses to judge when the domain is empty", () => {
    // An empty needle would match everything, turning every queued answer into a
    // mention. It returns null rather than a verdict, which is the difference
    // between "we cannot say" and "yes, everywhere".
    const result = verdict({
      source: "llm_responses",
      answerText: "Anything at all.",
      domain: "",
    });
    expect(result.mentioned).toBeNull();
  });

  it("escapes the dots rather than treating the domain as a pattern", () => {
    // Without escaping, `acme.com` is a regex where `.` matches any character,
    // so `acmeXcom` would count as a mention. This is the test that fails if
    // someone "simplifies" the escaping away.
    const result = verdict({
      source: "llm_responses",
      answerText: "We recommend acmeXcom for that use case.",
      domain: "acme.com",
    });
    expect(result.mentioned).toBe(false);
  });
});
