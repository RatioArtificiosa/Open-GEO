import { Link } from "@tanstack/react-router";
import { Container } from "@/components/landing-page";
import { SAMPLE_REPORT_HTML, SAMPLE_REPORT_TITLE } from "@/lib/sample-report";

/**
 * For agencies — the higher-value buyer, and the artifact they forward.
 *
 * `docs/design-research/marketing-strategy.md` §7, row 6. The job is not
 * "multi-client support in a list". It is the deliverable an agency is
 * judged on: the report a client opens, and the one a client forwards.
 *
 * **The report is the document, not a picture of it.** A screenshot is a
 * claim; the report itself is evidence. So the section renders the real
 * report the platform ships: the `seo-report` skill's own template, with a
 * template's byline and accent, live in a frame the reader can scroll. See
 * `web/src/lib/sample-report.ts` for why that document is a real report
 * and not a mockup.
 *
 * **The capability inventory is the argument.** Reports are templated,
 * agent-writable and publishable, and none of that was on the site before
 * this section. Each of the three is one line, because a reader who has
 * just scrolled the document needs to know it is repeatable, not a one-off.
 */
const PROPERTIES = [
  {
    label: "Templated",
    what: "Save a report as a template; the structure, the sections and the tone are reused across every client.",
  },
  {
    label: "Agent-writable",
    what: "Your agent writes and publishes the report through the same API you use for everything else.",
  },
  {
    label: "Publishable",
    what: "A share link for the team, a download for the client, and a print CSS that paginates.",
  },
] as const;

export function AgencyReport() {
  return (
    <section className="itc-claims itc-agency" id="agencies">
      <Container>
        <div className="itc-narrow">
          <p className="itc-eyebrow">For agencies</p>
          <h2 className="itc-display-md itc-claims-title">
            The report is the artifact.
          </h2>
          <p>
            An agency&rsquo;s deliverable is not a dashboard. It is the
            document a client opens, and the one a client forwards. Most tools
            render a chart and call it reporting. OpenGeo writes the document,
            with your byline and your accent, and the browser prints it to PDF.
          </p>
          <p>
            Below is the report itself, running. Not a picture of one. The
            byline and the accent are the two tokens a report template owns, and
            the export reads those same two out of the document.
          </p>

          <ul className="itc-agency-props">
            {PROPERTIES.map(({ label, what }) => (
              <li key={label}>
                <strong>{label}.</strong> {what}
              </li>
            ))}
          </ul>
        </div>

        {/* **The document, live.** The report is self-contained HTML with no
            scripts, so it renders in a frame exactly as it ships — its own
            CSS, its own print styles, unaffected by this page. The frame is
            sandboxed without scripts, which is the report&rsquo;s own
            guarantee in the platform: a deliverable that cannot execute
            anything. */}
        <div className="itc-agency-frame">
          <iframe
            sandbox="allow-popups"
            srcDoc={SAMPLE_REPORT_HTML}
            title={`A sample OpenGeo report: ${SAMPLE_REPORT_TITLE}`}
          />
        </div>

        <p className="itc-agency-caption">
          The report, as it ships. A template&rsquo;s byline and accent, a
          finding list, a table and a bar chart. Scroll it: it is the document,
          not a screenshot of one.{" "}
          <Link to="/capabilities" className="itc-agency-more">
            Reporting and delivery, in full
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </p>
      </Container>
    </section>
  );
}
