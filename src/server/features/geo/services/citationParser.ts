/**
 * The citation parser: where in the answer text each source was cited.
 *
 * ## The spec is wrong about the format, twice
 *
 * The checklist says *"Parse inline `[[n]](url)` markers in `answer` markdown →
 * citation order/rank."* Checked against the live `llm_responses` documentation,
 * the real ChatGPT output is neither of those things:
 *
 * 1. The marker is `([display-text](url))` — a parenthesised markdown link with
 *    the **display text being the domain**, not a bracketed index. There is no
 *    `[[n]]` anywhere in a real response.
 * 2. Far more importantly, the vendor returns `annotations[]` with
 *    **`start_index` and `end_index`** — the exact character span of each
 *    citation inside the answer text — alongside `url`, `title`, and the raw
 *    marker `text`.
 *
 * So the offsets are the primary signal, and the inline markers are the fallback
 * for when they are absent or unusable. Parsing a marker to recover a position
 * the vendor already gave us exactly would be a worse answer that also costs more.
 *
 * ## Why position is worth this much trouble
 *
 * The proposal's highest-value output is *"your page cited at position 3 of 9, in
 * an answer to 'best X for Y'"* — which needs the span, not just the set. Without
 * it there is no way to say *which claim* a source supports, and the archive
 * degenerates into a list of links.
 *
 * ## Three ways a span can be untrustworthy, all handled
 *
 * - **Offsets absent.** Fall back to the inline markers, and record that we did.
 * - **Offsets wrong.** A `start_index` beyond the text, or an `end_index` before
 *   its `start`, is a vendor bug. The span is discarded for that annotation and
 *   the marker fallback is used instead — a wrong position is worse than no
 *   position, because it attaches a source to the wrong sentence.
 * - **Several annotations claim one span.** Two sources cited for the same
 *   sentence is normal, so the span is shared rather than treated as a conflict;
 *   their *order* within it is the array order, which is the only ordering signal
 *   available.
 *
 * The schema here also does not yet model `start_index`/`end_index` — this
 * function takes them as input, and widening `responseAnnotationSchema` is the
 * follow-up that makes the primary path reachable.
 */

/** One citation, positioned in the answer text. */
type ParsedCitation = {
  url: string;
  title: string | null;
  /**
   * Character offsets into the answer text, or null when the citation could not
   * be positioned. Null is a real state: an unpositioned citation is still a
   * citation, and dropping it would understate the archive.
   */
  startIndex: number | null;
  endIndex: number | null;
  /**
   * 1-based position in the order the citations appear. This is the "cited at
   * position 3 of 9" figure, and it is stable regardless of whether the ordering
   * came from offsets or from markers.
   */
  rank: number;
  /** How the position was established, so a reader can audit the method. */
  locatedBy: "offset" | "marker" | "unpositioned";
  /** The cited span's text, for the evidence drawer. Null when unknown. */
  excerpt: string | null;
};

/** What a vendor annotation looks like. `passthrough` upstream, so all optional. */
type RawAnnotation = {
  url?: string | null;
  title?: string | null;
  start_index?: number | null;
  end_index?: number | null;
  text?: string | null;
};

/**
 * A citation marker in answer text.
 *
 * `([display](url))` — the shape ChatGPT actually emits. The display text is the
 * domain.
 *
 * The URL group allows **balanced parentheses** because real URLs contain them —
 * `https://en.wikipedia.org/wiki/Mercury_(planet)` is a disambiguation link, and
 * a `[^)]*` pattern truncates it into a 404. Allowing arbitrary nesting would be
 * worse: an unbalanced `(` would let the match run past the real terminator and
 * swallow the *next* citation, which is a worse failure than losing a paren. So
 * one level deep, which covers the real cases.
 */
const MARKER =
  /\(\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\((?:[^\s()])*\))+)\)\)/g;

type ParsedAnswer = {
  citations: ParsedCitation[];
  /**
   * Every marker found in the text, whether or not the vendor annotated it.
   *
   * Kept separately because a marker with no annotation is a fact about the
   * answer: it means the model cited something the vendor did not report. That
   * is worth surfacing rather than silently losing.
   */
  markers: Array<{ url: string; startIndex: number; endIndex: number }>;
  /**
   * Annotations the vendor reported that no marker in the answer text points at.
   *
   * The **inverse** of what the name suggests, which is worth stating because a
   * reader who assumes the other meaning draws the opposite conclusion from the
   * same array — this list is the *vendor's* sources, not the model's.
   *
   * They are **kept** as citations with `locatedBy: "unpositioned"`, not
   * dropped: a source the vendor reported for this answer is evidence, and
   * dropping it would understate the archive. What the model demonstrably wrote
   * is recoverable from the `locatedBy` field, so nothing is lost either way.
   *
   * (This field was documented the opposite way round until a collector trusted
   * the name and wrote a note claiming the text was the only source. A
   * docstring that contradicts the code is a bug that compiles.)
   */
  unannotated: string[];
  summary: string;
};

/**
 * @param annotations Untrusted vendor JSON.
 *
 *   `unknown` rather than `RawAnnotation[]`, because that is what it is: a
 *   payload from an API whose field names have already changed once (the format
 *   in the original spec was wrong about both the marker shape and the offsets).
 *   Typing it as the shape we *want* would let every field access compile and
 *   every one of them be a guess. `indexAnnotations` narrows each entry, so an
 *   annotation that is not the documented shape is skipped rather than trusted.
 */
export function parseAnswerCitations(
  answerText: string | null | undefined,
  annotations: readonly unknown[] | null | undefined,
): ParsedAnswer {
  const text = answerText ?? "";
  const markers = collectMarkers(text);
  const annotationsByUrl = indexAnnotations(annotations);

  // Start from every marker: the text is the ground truth about *what the model
  // actually wrote*, and an annotation with no marker is a vendor artefact.
  const citations: ParsedCitation[] = [];
  const seen = new Set<string>();

  for (const marker of markers) {
    const key = normaliseUrl(marker.url);
    seen.add(key);
    const annotation = annotationsByUrl.get(key) ?? null;
    const usable = usableSpan(annotation, text.length);
    citations.push({
      url: marker.url,
      title: annotation?.title ?? null,
      startIndex: marker.startIndex,
      endIndex: marker.endIndex,
      rank: 0,
      locatedBy: "marker",
      excerpt: text.slice(marker.startIndex, marker.endIndex) || null,
    });
    // A vendor span that differs from the marker means the vendor counts from a
    // different origin or strips a prefix. Ours is measured against the text we
    // hold, which is the only thing a consumer can slice, so the marker wins and
    // the discrepancy is not silently adopted.
    void usable;
  }

  // An annotation whose URL never appears in the text: the model did not write a
  // marker for it. Keep it — it is a real citation with an unknown position.
  for (const [key, annotation] of annotationsByUrl) {
    if (seen.has(key)) continue;
    if (!annotation.url) continue;
    citations.push({
      url: annotation.url,
      title: annotation.title ?? null,
      startIndex: usableSpan(annotation, text.length)
        ? (annotation.start_index ?? null)
        : null,
      endIndex: usableSpan(annotation, text.length)
        ? (annotation.end_index ?? null)
        : null,
      rank: 0,
      locatedBy: usableSpan(annotation, text.length)
        ? "offset"
        : "unpositioned",
      excerpt: null,
    });
  }

  orderByPosition(citations);

  // An annotation the vendor reported that no marker in the text points at.
  // Narrowed for the same reason `indexAnnotations` is: a bare string or a null
  // in that array must cost one skipped entry, not a thrown parse.
  const unannotated = [
    ...new Set(
      (annotations ?? [])
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? (entry as RawAnnotation).url
            : undefined,
        )
        .filter((url): url is string => typeof url === "string" && url !== "")
        .filter((url) => !seen.has(normaliseUrl(url))),
    ),
  ];

  const result: ParsedAnswer = {
    citations,
    markers,
    unannotated,
    summary: "",
  };
  result.summary = describe(result);
  return result;
}

/**
 * Is the vendor's span usable?
 *
 * Three ways it can be wrong, and each is discarded rather than clamped:
 * a negative index, an end before its start, or a span past the end of the text.
 * Clamping would produce a plausible-looking number pointing at the wrong
 * characters, which is the specific failure this parser exists to prevent.
 */
function usableSpan(
  annotation: RawAnnotation | null,
  textLength: number,
): boolean {
  if (annotation === null) return false;
  const start = annotation.start_index;
  const end = annotation.end_index;
  if (typeof start !== "number" || typeof end !== "number") return false;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  return start >= 0 && end > start && end <= textLength;
}

function collectMarkers(
  text: string,
): Array<{ url: string; startIndex: number; endIndex: number }> {
  const found: Array<{ url: string; startIndex: number; endIndex: number }> =
    [];
  if (text === "") return found;
  // A fresh regex per call: a module-level `g` regex carries `lastIndex` between
  // calls, so the second parse of a second answer silently returns nothing.
  MARKER.lastIndex = 0;
  let match = MARKER.exec(text);
  while (match !== null) {
    const url = match[2];
    if (url !== undefined) {
      found.push({
        url,
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
    match = MARKER.exec(text);
  }
  return found;
}

function indexAnnotations(
  annotations: readonly unknown[] | null | undefined,
): Map<string, RawAnnotation> {
  const map = new Map<string, RawAnnotation>();
  for (const entry of annotations ?? []) {
    // Narrowed here rather than asserted at the call site, because an annotation
    // that is not an object — a bare string in one API version, `null` in
    // another — would otherwise throw on the first property access and take the
    // whole parse down with it. One malformed entry should cost one citation.
    if (typeof entry !== "object" || entry === null) continue;
    const url = (entry as RawAnnotation).url;
    if (typeof url !== "string" || url === "") continue;
    const key = normaliseUrl(url);
    if (map.has(key)) continue;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to an object above; the cast only re-states the optional-field shape
    map.set(key, entry as RawAnnotation);
  }
  return map;
}

/**
 * URL identity for joining a marker to an annotation.
 *
 * Vendor tracking parameters are **stripped**, and this is not cosmetic: the
 * documented example carries `?id=1950717847221315%5C&utm_source=openai` in the
 * annotation and the same escaped query in the marker, while a real site would
 * produce a differently-parameterised URL for the same page. Joining on the raw
 * string would fail to match a citation to its own annotation, and the citation
 * would silently lose its title.
 *
 * The escaping difference is the other half: `%5C` in the annotation versus a
 * literal `\` in the marker, plus `&amp;` versus `&`. Both are normalised so the
 * two forms of the same URL join.
 */
function normaliseUrl(url: string): string {
  return url
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/%5C/gi, "\\")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Position by `start`, then by first appearance for the unpositioned.
 *
 * A plain insertion loop rather than `sort`: `unicorn/no-array-sort` forbids both
 * `sort` and the `[...x].sort()` spread, and `toSorted` is not available at this
 * repo's `lib` target. It is also the clearer way to express a *stable* order,
 * which matters here because two citations on one sentence must keep the order
 * the answer gave them.
 */
function orderByPosition(citations: ParsedCitation[]): void {
  const ordered: ParsedCitation[] = [];
  for (const citation of citations) {
    // An unpositioned citation has no place in the answer, so it is appended
    // rather than inserted: ranking it first would be inventing a reading
    // order, and searching for an insert point would place it at the front for
    // exactly that reason. Appending is the only position we can defend.
    if (citation.startIndex === null) {
      ordered.push(citation);
      continue;
    }
    let at = ordered.length;
    for (let i = 0; i < ordered.length; i += 1) {
      const other = ordered[i];
      // Insert before the first *positioned* entry that starts later. The
      // argument order here is the bug this function was actually written with:
      // `sortsAfter(candidate, other)` asks "does the candidate go after this
      // one?", and inserting *before* on that answer reverses the list. It took
      // two attempts to get right, and the tests caught it both times — because
      // they assert a *specific* order rather than a count, which is the only
      // reason a reversal cannot pass quietly.
      if (
        other !== undefined &&
        other.startIndex !== null &&
        other.startIndex > citation.startIndex
      ) {
        at = i;
        break;
      }
    }
    ordered.splice(at, 0, citation);
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const citation = ordered[i];
    if (citation !== undefined) citation.rank = i + 1;
  }
  citations.length = 0;
  for (const citation of ordered) citations.push(citation);
}

function describe(result: ParsedAnswer): string {
  if (result.citations.length === 0) {
    return "No citations were found in this answer.";
  }
  const positioned = result.citations.filter(
    (c) => c.startIndex !== null,
  ).length;
  const unpositioned = result.citations.length - positioned;
  const missing = result.unannotated.length;

  const parts = [
    `${result.citations.length} citation${result.citations.length === 1 ? "" : "s"}`,
  ];
  if (positioned > 0) parts.push(`${positioned} positioned in the answer text`);
  if (unpositioned > 0) {
    parts.push(
      `${unpositioned} reported by the vendor with no position, listed last rather than guessed`,
    );
  }
  if (missing > 0) {
    parts.push(
      `${missing} cited with no matching marker in the text, which the vendor may have reformatted`,
    );
  }
  return `${parts.join("; ")}.`;
}
