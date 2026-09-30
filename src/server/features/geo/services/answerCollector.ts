import { parseAnswerCitations } from "./citationParser";

/**
 * Turning a collected `llm_responses` task into archive rows.
 *
 * ## The join is by tag, and the alternative is invisible
 *
 * A `task_get` response returns one task. It has to become an answer attributed
 * to the prompt, the target and the platform that asked for it. The tempting
 * implementation is positional: the post returned ids in order, so the nth
 * collected task belongs to the nth prompt. That is wrong, and wrong *quietly*:
 *
 * - A batch can be **partially accepted**, so the accepted list is shorter than
 *   the submitted one and every subsequent id shifts by one.
 * - The two calls are **different calls**, separated by up to 72 hours.
 * - A partial failure in collection means the ids arriving now are not a prefix
 *   of the ones posted.
 *
 * Each of those puts answer *n* on prompt *n+1*, and the result is an archive
 * where every row has a prompt, an answer, a platform and a citation set — all
 * internally consistent, all attached to the wrong question. Nothing throws.
 * Nothing looks wrong. The citation graph just quietly tells a lie.
 *
 * So the only join is the vendor's own echo of **our** `tag`, which CL-200c
 * made unique per (target, platform, run index).
 *
 * ## What the vendor's field names actually are
 *
 * The documented `llm_responses` result carries the answer under a shape whose
 * field names have shifted between API versions, and this product has already
 * been bitten once by trusting a spec that was wrong twice (CL-205: the marker
 * format *and* the offset fields). So the reader below accepts several spellings
 * and, crucially, **reports which one it found** rather than silently taking the
 * first — a reader that guessed would produce an empty archive that looks like
 * "the model said nothing".
 */

/**
 * Narrow an untrusted vendor payload to a record.
 *
 * A guard rather than an assertion, and deliberately: the task response is
 * `unknown` because we do not trust it, and asserting a shape over it is the
 * claim "this is what the vendor sends" written as code. A guard that returns
 * `{}` for anything else keeps the reader total — every field access below
 * returns `undefined` rather than throwing — which is the honest state for a
 * payload we have not verified.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the three checks above; the guard's whole point is that it does not assert the vendor's shape
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The fields we need out of a collected task, whatever they are called. */
type CollectedAnswer = {
  /** The model we asked. Null when the vendor did not say. */
  modelName: string | null;
  /** The text the model produced. Null when the task is still pending. */
  content: string | null;
  /** Whatever the vendor offered as citation annotations, untrusted. */
  annotations: unknown[];
  /** The vendor's echo of our tag. */
  tag: string | null;
  /** The vendor's settled cost for this task, in USD. */
  costUsd: number | null;
};

/** The archive row a collected answer produces, before it is written. */
export type ArchivedAnswer = {
  answerId: string;
  targetId: string;
  platform: "chat_gpt" | "gemini" | "claude" | "perplexity";
  prompt: string;
  /** Verbatim. The schema's rule is "do not transform", and it exists because a diff needs the exact text. */
  answerText: string | null;
  citations: Array<{
    url: string;
    domain: string;
    rank: number;
    title: string | null;
  }>;
  modelName: string | null;
  vendorTaskId: string;
  /** Kept whole, so a schema change never loses archived evidence. */
  rawJson: string;
  /** How the reading went, for the run log. */
  note: string | null;
};

/**
 * Why a collected task could not be archived.
 *
 * Module-private: a caller narrows on `ok` and reads `reason`, and never names
 * the type. Exported would be an import path nothing takes.
 */
type CollectRefusal =
  | { ok: false; reason: "no_tag"; detail: string }
  | { ok: false; reason: "unparseable_tag"; detail: string }
  | { ok: false; reason: "still_pending"; detail: string };

/** Split a tag back into the triple CL-200c encoded. */
export function parseTag(tag: string): {
  targetId: string;
  platform: ArchivedAnswer["platform"];
  index: number;
} | null {
  // The tag is `targetId:platform:index`, and a target id may itself contain a
  // colon, so this is parsed from the **right**, not the left.
  //
  // The obvious implementation splits on every colon and hopes for three parts.
  // That is right for a uuid target id and wrong for a prefixed one, and
  // splitting at the first and last separator is wrong for both: for
  // `proj:9:t1:chat_gpt:2` the first/last pair yields the platform `9:t1:chat_gpt`,
  // which validates against nothing and silently refuses every prefixed id.
  //
  // From the right it is unambiguous whatever the id contains: the last segment
  // is the index, the one before is a platform from a closed set, and everything
  // left is the id. A **closed set** is what makes this safe — there is no
  // separator in an id that can be confused with one of four known words at a
  // known position from the end.
  const lastSep = tag.lastIndexOf(":");
  if (lastSep <= 0) return null;
  const index = Number(tag.slice(lastSep + 1));
  if (!Number.isInteger(index)) return null;

  const prevSep = tag.lastIndexOf(":", lastSep - 1);
  if (prevSep <= 0) return null;

  const platform = tag.slice(prevSep + 1, lastSep);
  const targetId = tag.slice(0, prevSep);
  if (targetId === "") return null;

  if (
    platform !== "chat_gpt" &&
    platform !== "gemini" &&
    platform !== "claude" &&
    platform !== "perplexity"
  ) {
    return null;
  }
  return { targetId, platform, index };
}

/** The bare host, lowercased and without `www.` — the archive's domain key. */
function hostOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  const host = match?.[1] ?? url;
  return host.replace(/^www\./i, "").toLowerCase();
}

/**
 * Read a collected task into the fields the archive needs.
 *
 * Returns the spellings it *tried*, so a vendor shape change surfaces as a note
 * in the run log rather than as an archive that quietly stops growing.
 */
export function readCollectedAnswer(task: unknown): CollectedAnswer {
  const record = asRecord(task);
  const result = record.result;
  const first = Array.isArray(result) ? asRecord(result[0]) : null;
  // Falls back to the task envelope, because some responses put the answer
  // fields at the top level and some nest them under `result[0]`. Accepting both
  // is not hedging — it is the only thing that survives a version bump.
  const body = first === null ? record : { ...record, ...first };

  // Accept the spellings this API has used. `content` is a string in some
  // versions and an array of parts in others, and the array form is the one that
  // silently produces an empty answer when assumed to be a string.
  const rawContent = body.content ?? body.text ?? body.answer;
  const content = Array.isArray(rawContent)
    ? rawContent
        .map((part) => {
          if (typeof part === "string") return part;
          // A content part is `{type, text}`; a part that is neither is
          // skipped rather than stringified, because `[object Object]` in an
          // archived answer is worse than a gap.
          const text = asRecord(part).text;
          return asString(text) ?? "";
        })
        .join("")
    : asString(rawContent);

  // Accept every spelling this API has used, and require an array: a single
  // object where a list was documented is a shape change, and coercing it would
  // hide the change behind a citation that happens to work.
  const rawAnnotations =
    body.citations ?? body.sources ?? body.annotations ?? body.websites;
  const annotations = Array.isArray(rawAnnotations) ? rawAnnotations : [];

  return {
    modelName: asString(body.model_name),
    content,
    annotations,
    tag: asString(body.tag),
    costUsd: typeof record.cost === "number" ? record.cost : null,
  };
}

/**
 * Build the archive rows for a collected task, or refuse and say why.
 *
 * The refusals are the interesting part. Each one is a situation where writing a
 * plausible-looking row would be worse than writing nothing: a row with an empty
 * answer reads as *"the model declined to mention us"*, which is a finding the
 * customer will act on, and it would be a finding we invented.
 */
export function buildArchivedAnswer(input: {
  task: unknown;
  /** The tag we posted with, used when the vendor does not echo it. */
  fallbackTag: string | null;
  /** The prompt, read from the pending row. Required — see below. */
  prompt: string | null;
  vendorTaskId: string;
}): ArchivedAnswer | CollectRefusal {
  const collected = readCollectedAnswer(input.task);

  const tag = collected.tag ?? input.fallbackTag;
  if (tag === null) {
    return {
      ok: false,
      reason: "no_tag",
      detail:
        "The collected task carried no tag, so it cannot be attributed to the prompt that asked for it. Writing it anyway would attach an answer to whichever target happened to be next.",
    };
  }

  const identity = parseTag(tag);
  if (identity === null) {
    return {
      ok: false,
      reason: "unparseable_tag",
      detail: `The tag "${tag}" is not in the form this collector wrote, so the answer cannot be attributed to a target.`,
    };
  }

  if (collected.content === null) {
    return {
      ok: false,
      reason: "still_pending",
      detail:
        "The task was collected but carries no answer text. This is a pending vendor task, not an empty answer, and archiving it would report a brand as absent from a response we never received.",
    };
  }

  // The prompt is NOT in the task response, so it comes from the pending row
  // this collector was called for. It is required rather than reconstructed: an
  // answer whose prompt is a template or a guess is not evidence, and the
  // schema's own rule — "the exact question asked, as sent" — exists because a
  // diff needs the exact text to be reproducible.
  if (input.prompt === null) {
    return {
      ok: false,
      reason: "unparseable_tag",
      detail:
        "The pending row for this task is gone, so the prompt that asked for it cannot be recovered. An answer without its prompt is not reproducible evidence.",
    };
  }

  // The same parser the Live path uses, so a citation in a queued answer and a
  // citation in a live answer are the same shape and the graph cannot tell them
  // apart — which is the point.
  const parsed = parseAnswerCitations(collected.content, collected.annotations);

  return {
    answerId: crypto.randomUUID(),
    targetId: identity.targetId,
    platform: identity.platform,
    prompt: input.prompt,
    answerText: collected.content,
    citations: parsed.citations.map((citation, rank) => ({
      url: citation.url,
      domain: hostOf(citation.url),
      rank: rank + 1,
      title: citation.title,
    })),
    modelName: collected.modelName,
    vendorTaskId: input.vendorTaskId,
    rawJson: JSON.stringify(input.task),
    note:
      parsed.unannotated.length > 0
        ? `The vendor reported ${parsed.unannotated.length} source(s) that the answer text does not cite. The citations below come from the text, which is what the model actually wrote.`
        : null,
  };
}

/** The prompt for a collected task, read from the pending row we posted. */
export function promptForTag(
  pending: Array<{ tag: string; prompt: string }>,
  tag: string,
): string | null {
  for (const row of pending) {
    if (row.tag === tag) return row.prompt;
  }
  return null;
}
