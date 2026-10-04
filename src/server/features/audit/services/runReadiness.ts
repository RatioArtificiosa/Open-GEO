import { fetchLlmsTxt, fetchRobotsTxtText } from "@/server/lib/audit/discovery";
import { runAudit } from "@/server/features/audit/services/runAudit";

/**
 * The seam: gather what the readiness report needs, then run it.
 *
 * ## Why this exists, and what it is careful about
 *
 * Three pure functions have all shipped and none had a caller. This is where they
 * meet — but the interesting work is entirely in **what it refuses to do**:
 *
 * **1. It never invents an input.** Every value that could not be obtained stays
 * `null`, and `runAudit` treats `null` as *not measured*. That is the whole
 * design: a run that quietly substituted an empty list would report "we checked
 * and found nothing" for a check that never ran, and *an empty finding list is
 * the one output a customer would read as good news.*
 *
 * **2. One failure does not discard the rest.** A site whose `/llms.txt` times
 * out still gets a crawler report, because every other check is independent of
 * it. The failure is recorded as a reason in `unavailable` so the report can say
 * what it did not look at — the same shape `GeoPatrol` uses for a platform that
 * fails mid-patrol.
 *
 * **3. It never fetches a URL the crawler would refuse.** Both fetches go
 * through the same guard the crawl uses, because a readiness report that will
 * fetch an internal address is a server-side request forgery with a scoring
 * function attached.
 *
 * ## What it deliberately does not do
 *
 * **No DataForSEO.** Every input here is either a customer HTTP fetch or a row
 * the crawl already produced. The `on_page/content_parsing` fetcher exists and is
 * metered, but reaching for it to obtain heading text or schema types would mean
 * paying a vendor a second time for data `analyzeHtml` extracted from bytes we
 * had already paid to download — and it would report the vendor's idea of the
 * page rather than the page the crawler actually fetched. **Two sources for one
 * field means a disagreement nobody would notice.**
 */
type ReadinessPageInput = {
  url: string;
  /** Heading text with levels, as `crawlPage` captured them. */
  headings: Array<{ level: number; title: string }> | null;
  /** Schema.org `@type` names, as `analyzeHtml` read them. */
  schemaTypes: string[] | null;
  /** Archived-answer measurements. All three null together — see below. */
  citationsObserved: number | null;
  answersObserved: number | null;
  competingPagesCited: number | null;
};

type ReadinessRunInput = {
  /** The audited site's origin, e.g. `https://acme.com`. */
  origin: string;
  /** Pages the crawl actually analysed. Pages that failed are omitted, not faked. */
  pages: ReadinessPageInput[];
  /**
   * How many pages the crawl attempted in total, including the ones that failed.
   *
   * **Kept so the report can say what it is missing.** A run over 3 of 50 crawled
   * pages would otherwise present those three as the site's whole structure, and
   * the difference between "we checked three pages" and "we checked the site" is
   * the difference between a finding and a sample.
   */
  pagesAttempted: number;
  /** Measured by the caller. Null means "not measured", never zero. */
  schemaCoverageRatio?: number | null;
};

/**
 * One line explaining why an input is missing, phrased for a customer.
 *
 * **Never a technical detail.** "fetch failed" tells a site owner nothing they
 * can act on; "we could not reach /llms.txt" tells them which file to look at.
 */
type ReadinessNote = {
  what: string;
  because: string;
};

type ReadinessResult = ReturnType<typeof runAudit> & {
  /** Everything the run could not check, with a reason the reader can act on. */
  notes: ReadinessNote[];
};

/**
 * Fetch the two site-level files, then produce the report.
 *
 * ## Concurrent, and why that is the right call here
 *
 * Both fetches have a 10-second timeout, so running them in sequence gives a slow
 * host a 20-second worst case for a report whose two halves are independent.
 * They go out together for the same reason the crawl's sitemap fetch fans out:
 * these are two paths on **one host we already have a connection to**, not a
 * probe of an unknown network — so the connection cost is one socket, not a
 * burst. **A sequence here would double the latency of every audit to save
 * nothing.**
 *
 * The comment this replaced said "sequential", which the code did not do. **A
 * comment describing a decision the code contradicts is worse than no comment**,
 * because the next reader trusts it and reasons about a design that is not there.
 */
export async function runReadiness(
  input: ReadinessRunInput,
): Promise<ReadinessResult> {
  const notes: ReadinessNote[] = [];

  const [robotsText, llmsTxt] = await Promise.all([
    // **Both are caught, and the catch is not redundant.** `fetchLlmsTxt` resolves
    // for every HTTP outcome it knows about, but a bug inside the reader — a
    // throwing `getReader`, say — would reject, and an unhandled rejection here
    // fails the whole audit over a file that is a nice-to-have. The catch converts
    // that into a gap, which is what it actually is.
    fetchRobotsTxtText(input.origin).catch((error: unknown) => {
      notes.push({
        what: "robots.txt",
        because: `we could not read it (${describe(error)})`,
      });
      return null;
    }),
    // **The tagged result carries the distinction**, so no catch is needed
    // here: a rejected promise would mean the fetcher itself broke, and that is
    // worth surfacing as a gap rather than as a finding about the site.
    fetchLlmsTxt(input.origin).catch((error: unknown) => ({
      status: "unreachable" as const,
      reason: describe(error),
    })),
  ]);

  if (
    robotsText === null &&
    !notes.some((note) => note.what === "robots.txt")
  ) {
    notes.push({
      what: "robots.txt",
      because: "the site did not serve one, or served an error",
    });
  }
  // **Three outcomes, three different sentences.** "Does not publish one" is a
  // finding the owner can fix. "We could not check" is a gap in our coverage and
  // claims nothing about their site. A third state that blurred the two would
  // report a passing network as a defect, which is the bug this shape exists to
  // prevent.
  if (llmsTxt.status === "absent") {
    notes.push({
      what: "/llms.txt",
      because:
        "the site does not publish one, which is a finding rather than a failure",
    });
  }
  if (llmsTxt.status === "unreachable") {
    notes.push({
      what: "/llms.txt",
      because: `we could not check it, so nothing is known about it (${llmsTxt.reason})`,
    });
  }

  // **`pagesAttempted` is required, with no default.** An earlier version fell
  // back to `pages.length`, which meant a caller that forgot to pass it reported
  // *all N pages analysed* — the gap silently closed and the reader is left
  // believing a three-page sample is a whole site. **A default that hides an
  // omission is worse than a type error**, and a mutation that deleted the
  // forward passed cleanly while this default existed.
  const attempted = input.pagesAttempted;
  if (input.pages.length < attempted) {
    notes.push({
      what: `${attempted - input.pages.length} of ${attempted} crawled pages`,
      because:
        "they could not be analysed, so nothing is known about their structure",
    });
  }

  const result = runAudit({
    origin: input.origin,
    robotsText,
    llmsTxtBody: llmsTxt.status === "found" ? llmsTxt.body : null,
    unavailable: notes.map((note) => `${note.what}: ${note.because}`),
    pages: input.pages,
  });

  return { ...result, notes };
}

/**
 * An error short enough to show a reader and free of anything a server echoed back.
 *
 * **Truncated, because this string reaches a customer-facing report.** An upstream
 * message can contain a hostname, a stack fragment, or a proxy's HTML — and
 * *"a control character can forge a second log line"* applies to a rendered
 * report too. Newlines are the specific risk here, so they go first.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const single = message.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "unknown error" : single.slice(0, 120);
}
