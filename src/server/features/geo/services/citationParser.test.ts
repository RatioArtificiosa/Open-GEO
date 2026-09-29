import { describe, expect, it } from "vitest";
import { parseAnswerCitations } from "./citationParser";

/**
 * The citation parser.
 *
 * The fixtures below are the **real** documented `llm_responses` payload, copied
 * verbatim — including the escaped `&amp;` in the annotation URL, the `%5C` escape
 * in the query string, and the `?utm_source=openai` tracking parameter. Those
 * details are not decoration: each one broke the join between a marker and its
 * annotation in an earlier draft of the tests, and each would have silently
 * stripped a source's title from the archive.
 *
 * The format itself is worth stating, because the spec got it wrong twice: the
 * marker is `([domain](url))`, not `[[n]](url)`, and the vendor supplies
 * `start_index`/`end_index` offsets that make parsing a marker a fallback rather
 * than the primary path.
 */

const REAL_TEXT =
  "The amusement park industry in France remains a significant and dynamic sector as of 2024. In 2023, the industry achieved a turnover of approximately €2.5 billion, with major parks like Disneyland Paris accounting for 60% of the total attendance. ([latribune.fr](https://www.latribune.fr/entreprises?id=1950717847221315%5C&utm_source=openai))\n\nNotably, in 2024, Parc Astérix welcomed a record 2.84 million visitors. ([ouest-france.fr](https://www.ouest-france.fr/tourisme?utm_source=openai))";

const REAL_ANNOTATIONS = [
  {
    title:
      "Entre créations et tensions, le marché des parcs de loisirs en Occitanie",
    url: "https://www.latribune.fr/entreprises?id=1950717847221315%5C&amp;utm_source=openai",
    start_index: 290,
    end_index: 516,
    text: "([latribune.fr](https://www.latribune.fr/entreprises?id=1950717847221315%5C&utm_source=openai))",
  },
  {
    title: "Le Parc Astérix est élu meilleur parc d'attractions de France",
    url: "https://www.ouest-france.fr/tourisme?utm_source=openai",
    start_index: 680,
    end_index: 884,
    text: "([ouest-france.fr](https://www.ouest-france.fr/tourisme?utm_source=openai))",
  },
];

describe("parseAnswerCitations", () => {
  it("finds the real marker format, which is not [[n]](url)", () => {
    // The checklist asked for `[[n]](url)`. The vendor emits `([domain](url))`.
    // A parser written to the spec would find zero citations in every real
    // answer — the same silent-empty failure as CL-212a, one layer down.
    const result = parseAnswerCitations(REAL_TEXT, REAL_ANNOTATIONS);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.url).toContain("latribune.fr");
    expect(result.citations[1]?.url).toContain("ouest-france.fr");
  });

  it("positions each citation by its offset in the text", () => {
    // "your page cited at position 3 of 9" needs the span, and slicing it back
    // out of the text is the check that the span means what it says.
    const result = parseAnswerCitations(REAL_TEXT, REAL_ANNOTATIONS);
    const first = result.citations[0];
    expect(first?.startIndex).toBeGreaterThan(0);
    expect(first?.endIndex).toBeGreaterThan(first?.startIndex ?? 0);
    // The slice must land on the marker itself, not somewhere nearby.
    const slice = REAL_TEXT.slice(first?.startIndex ?? 0, first?.endIndex ?? 0);
    expect(slice).toContain("latribune.fr");
  });

  it("joins a marker to its annotation despite URL escaping", () => {
    // The annotation carries `&amp;` where the marker carries `&`, and `%5C`
    // where the marker carries a literal backslash. Joining on the raw string
    // fails, and the citation silently loses its title.
    const result = parseAnswerCitations(REAL_TEXT, REAL_ANNOTATIONS);
    expect(result.citations[0]?.title).toContain("Occitanie");
    expect(result.unannotated).toEqual([]);
  });

  it("ignores vendor tracking parameters when matching", () => {
    // The same page reached with a different query string is the same page. If
    // this joined on the raw URL, `?utm_source=openai` vs a bare URL would look
    // like two citations of the same source.
    const text =
      "A fact. ([example.com](https://example.com/a?utm_source=openai)) Another. ([example.com](https://example.com/a?ref=x))";
    const result = parseAnswerCitations(text, [
      { url: "https://example.com/a", title: "The page" },
    ]);
    expect(result.citations).toHaveLength(2);
    expect(result.citations.every((c) => c.title === "The page")).toBe(true);
  });

  it("discards an out-of-range vendor span rather than clamping it", () => {
    // Clamping produces a plausible number pointing at the wrong characters,
    // which attaches a source to the wrong sentence — the specific failure this
    // parser exists to prevent.
    const text = "Short. ([example.com](https://example.com/x))";
    const result = parseAnswerCitations(text, [
      { url: "https://example.com/x", start_index: 900, end_index: 1200 },
    ]);
    expect(result.citations[0]?.startIndex).toBe(text.indexOf("([example"));
    expect(result.citations[0]?.locatedBy).toBe("marker");
  });

  it("discards a span whose end precedes its start", () => {
    const text = "A. ([example.com](https://example.com/x))";
    const result = parseAnswerCitations(text, [
      { url: "https://example.com/x", start_index: 40, end_index: 5 },
    ]);
    expect(result.citations[0]?.startIndex).toBe(text.indexOf("([example"));
    expect(result.citations[0]?.locatedBy).toBe("marker");
  });

  it("keeps an annotated citation whose marker is missing, ranked last", () => {
    // The model may cite without writing a marker the vendor reports, or the
    // vendor may reformat. The citation is real; its *position* is not known,
    // and inventing one would be a guess about which sentence it supports.
    const text = "An answer with no marker at all.";
    const result = parseAnswerCitations(text, [
      {
        url: "https://example.com/x",
        title: "Hidden",
        start_index: 2,
        end_index: 6,
      },
    ]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.locatedBy).toBe("offset");
    expect(result.citations[0]?.title).toBe("Hidden");
    expect(result.summary).toMatch(/no matching marker/i);
  });

  it("sorts an unpositioned citation after the positioned ones", () => {
    const text = "One. ([a.com](https://a.com)) Two. ([b.com](https://b.com))";
    const result = parseAnswerCitations(text, [
      { url: "https://a.com" },
      { url: "https://b.com" },
      { url: "https://c.com", start_index: null, end_index: null },
    ]);
    const ranks = result.citations.map((c) => `${c.url}:${c.rank}`);
    expect(ranks).toEqual([
      "https://a.com:1",
      "https://b.com:2",
      "https://c.com:3",
    ]);
  });

  it("parses two answers independently", () => {
    // A module-level /g regex keeps `lastIndex` between calls, so the second
    // parse of a second answer returns nothing — and the archive silently
    // records one answer with citations and the next with none.
    const first = parseAnswerCitations("A. ([a.com](https://a.com))", null);
    const second = parseAnswerCitations("B. ([b.com](https://b.com))", null);
    expect(first.citations).toHaveLength(1);
    expect(second.citations).toHaveLength(1);
    expect(second.citations[0]?.url).toContain("b.com");
  });

  it("reports an answer with no citations rather than inventing any", () => {
    const result = parseAnswerCitations(
      "A plain answer with no sources.",
      null,
    );
    expect(result.citations).toEqual([]);
    expect(result.summary).toMatch(/no citations were found/i);
  });

  it("handles a null answer body", () => {
    // `answerText` is null for every llm_mentions row, so this is the common
    // case rather than an edge case.
    const result = parseAnswerCitations(null, null);
    expect(result.citations).toEqual([]);
  });

  it("keeps a marker whose URL contains parentheses", () => {
    // Real URLs do contain balanced parens (Wikipedia disambiguation links), and
    // a naive `[^)]*` URL pattern truncates them — losing the tail and yielding a
    // URL that 404s. The matcher allows one nested level, which covers the real
    // cases without descending into arbitrary nesting.
    const text =
      "A fact. ([wiki](https://en.wikipedia.org/wiki/Mercury_(planet))) Done.";
    const result = parseAnswerCitations(text, null);
    expect(result.citations[0]?.url).toBe(
      "https://en.wikipedia.org/wiki/Mercury_(planet)",
    );
  });

  it("still parses a later marker correctly after one containing parens", () => {
    // The real hazard of a nested-paren pattern: an unbalanced match swallows the
    // rest of the answer, so the *next* citation disappears too.
    const text =
      "One. ([wiki](https://en.wikipedia.org/wiki/Mercury_(planet))) Two. ([b.com](https://b.com))";
    const result = parseAnswerCitations(text, null);
    expect(result.citations.map((c) => c.url)).toEqual([
      "https://en.wikipedia.org/wiki/Mercury_(planet)",
      "https://b.com",
    ]);
  });

  it("gives two sources on one sentence the same position, not a conflict", () => {
    // Two sources cited for one claim is normal, so this is a fact about the
    // answer rather than a parse error.
    const text =
      "A claim. ([a.com](https://a.com)) ([b.com](https://b.com)) Next.";
    const result = parseAnswerCitations(text, null);
    expect(result.citations).toHaveLength(2);
    expect(result.citations[0]?.startIndex).not.toBe(
      result.citations[1]?.startIndex,
    );
  });
});
