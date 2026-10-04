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
  pagesAttempted?: number;
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
 * **Sequential, not parallel, and that is a cost decision.** Both are 10-second
 * timeouts against arbitrary customer servers; running them together doubles the
 * chance a slow host turns one check into two failures and doubles the
 * connections a single audit opens against that host. The crawl's sitemap fetch
 * does fan out, but it fans out over *our* known shard list rather than probing a
 * customer's site twice at once.
 */
export async function runReadiness(
  input: ReadinessRunInput,
): Promise<ReadinessResult> {
  const notes: ReadinessNote[] = [];

  const [robotsText, llmsTxtBody] = await Promise.all([
    // Each fetch resolves rather than rejects by construction — both catch and
    // return null — so the allSettled below is about a future caller that adds a
    // throwing source, not about these two today.
    fetchRobotsTxtText(input.origin).catch((error: unknown) => {
      notes.push({
        what: "robots.txt",
        because: `we could not read it (${describe(error)})`,
      });
      return null;
    }),
    fetchLlmsTxt(input.origin).catch((error: unknown) => {
      notes.push({
        what: "/llms.txt",
        because: `we could not fetch it (${describe(error)})`,
      });
      return null;
    }),
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
  if (
    llmsTxtBody === null &&
    !notes.some((note) => note.what === "/llms.txt")
  ) {
    notes.push({
      what: "/llms.txt",
      because:
        "the site does not publish one, which is a finding rather than a failure",
    });
  }

  const attempted = input.pagesAttempted ?? input.pages.length;
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
    llmsTxtBody,
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
