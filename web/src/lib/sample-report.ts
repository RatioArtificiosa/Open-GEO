/**
 * A real report document, rendered on the homepage as the artifact an
 * agency forwards.
 *
 * ## Why this is a document and not a mockup
 *
 * `docs/design-research/marketing-strategy.md` §7, row 6, asks the
 * homepage to show "a report with a real byline and the real accent —
 * the artifact they forward", and CL-819b corrects it: **built from the
 * report the platform actually ships, not a picture of one.** A
 * screenshot is a claim; the report itself is evidence.
 *
 * So this is the document the `seo-report` skill writes — the same
 * template, the same CSS, the same primitives (a header with a byline,
 * a sticky contents rail, finding lists, a note, a table, a bar chart,
 * the closing "how this report was made", a footer). It is stored here
 * as the HTML string and rendered live in an iframe, so the reader
 * scrolls the real document rather than a render of it.
 *
 * ## The two white-label tokens, carried for real
 *
 * There is no branding column anywhere in the reports schema
 * (`src/server/features/reports/printableReport.ts`): the only
 * white-labelling in the system lives *inside* the document — the
 * `--accent` custom property, which the skill calls "the one token a
 * report template may change", and the `.byline`. This document sets
 * both, exactly as a templated report does, so it is a genuine
 * white-labelled document and not a bare one.
 *
 * **The content is representative, not measured.** The figures are a
 * worked example for a fictional client, so a reader can see the form;
 * the report's own "how this report was made" section says which tools
 * a real run reports, and the closing link points at the real skill.
 * Nothing here is offered as a measurement of any live site.
 */

/** The document, as the `seo-report` skill emits it. */
export const SAMPLE_REPORT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Competitive Landscape — October 6, 2026</title>
<style>
/* One light look, on screen and on paper. The report is read inside the app,
   which has its own theme toggle, and a saved document has no way to hear about
   it: a report that follows the OS scheme alone shows a black panel inside a
   light app for anyone whose two settings disagree. */
:root{--bg:#fff;--fg:#0a0a0a;--fg-2:#454545;--fg-3:#8f8f8f;--rule:#ebebeb;--rule-2:#dcdcdc;--sunk:#fafafa;
  /* The one token a report template may change. Left as the text color, so a
     report with no template looks exactly as it did before. */
  --accent:#1C4ED8}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--fg);margin:0;padding:0 24px 120px;font-size:18px;line-height:1.65;letter-spacing:-.003em;
  font-family:Geist,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.shell{max-width:1100px;margin:0 auto}
header{padding:40px 0 0;max-width:660px}
h1{font-size:clamp(34px,6vw,56px);font-weight:700;line-height:1.03;letter-spacing:-.035em;margin:0;text-wrap:balance}
.byline{margin:24px 0 0;font-size:16px;color:var(--fg-2)}
.body{display:grid;grid-template-columns:minmax(0,660px) 1fr;gap:0 64px;margin:48px 0 0}
article{grid-column:1;grid-row:1;min-width:0}
.rail{grid-column:2;grid-row:1;font-size:14px;color:var(--fg-3);padding-top:6px}
.rail .sticky{position:sticky;top:40px}
.toc-label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-3);margin:0 0 10px}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{margin:0 0 7px}
.toc a{color:var(--fg-2);text-decoration:none}
.toc a:hover{color:var(--fg)}
@media (max-width:900px){.body{grid-template-columns:1fr}.rail{display:none}}
article p{margin:0 0 26px;text-wrap:pretty}
h2{font-size:30px;font-weight:600;letter-spacing:-.025em;line-height:1.2;margin:60px 0 22px;text-wrap:balance}
h3{font-size:20px;font-weight:600;letter-spacing:-.015em;margin:38px 0 14px}
.finding{list-style:none;padding:0;margin:0 0 26px}
.finding li{margin:0 0 8px;color:var(--fg-2)}
.finding b{color:var(--accent);font-weight:600}
a{color:var(--fg);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--rule-2)}
strong{font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;background:var(--sunk);border:1px solid var(--rule);padding:1px 5px;border-radius:4px}
ul,ol{margin:0 0 26px;padding-left:22px}li{margin:0 0 11px}li::marker{color:var(--fg-3)}
.note{border-left:2px solid var(--fg);padding:2px 0 2px 22px;margin:0 0 26px}
.note p{margin:0;color:var(--fg-2)}
.note p+p{margin-top:14px}
.tw{overflow-x:auto;margin:0 0 30px}
table{border-collapse:collapse;width:100%;font-size:15.5px;min-width:440px}
th{text-align:left;font-weight:500;color:var(--fg-3);padding:0 20px 10px 0;border-bottom:1px solid var(--rule-2);white-space:nowrap}
td{padding:13px 20px 13px 0;border-bottom:1px solid var(--rule);vertical-align:top;color:var(--fg-2)}
td:first-child{color:var(--fg)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td:last-child,th:last-child{padding-right:0}
tr:last-child td{border-bottom:none}
figure{margin:0 0 30px}
figcaption{font-size:14px;color:var(--fg-3);margin-top:8px}
.bars{display:grid;grid-template-columns:minmax(90px,170px) 1fr auto;gap:10px 12px;align-items:center;font-size:14px}
.bars .label{color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bars .track{display:block;height:20px;background:var(--sunk)}
.bars .bar{display:block;height:100%;background:var(--accent);opacity:.16}
.bars .value{font-variant-numeric:tabular-nums;min-width:3ch;text-align:right}
svg{display:block;max-width:100%;height:auto}
hr{border:none;border-top:1px solid var(--rule);margin:60px 0}
footer{max-width:660px;margin:64px 0 0;padding:26px 0 0;border-top:1px solid var(--rule);font-size:15px;color:var(--fg-3)}
@media print{
  @page{margin:0 0 12mm 0;@bottom-center{content:counter(page) " of " counter(pages);font:10px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#8f8f8f}}
  body{background:#fff;color:#111;padding:14mm 16mm 6mm;font-size:11pt}
  .shell,.body{display:block;max-width:none}
  header{padding:0;max-width:none}
  h1{font-size:26pt}
  h2{font-size:15pt;margin:22pt 0 10pt}
  h3{font-size:12pt;margin:14pt 0 6pt}
  article,footer{max-width:none}
  .rail{display:none}
  h1,h2,h3{break-after:avoid}
  table,figure,.note,svg{break-inside:avoid}
  tr,td,th{break-inside:avoid}
  p,li{orphans:3;widows:3}
  thead{display:table-header-group}
  .tw{overflow:visible}
  table{font-size:10pt;min-width:0}
  .byline,footer,figcaption{font-size:9.5pt}
  svg,.bars .bar,.bars .track{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  a{text-decoration:none}
}
</style></head>
<body><div class="shell">

<header>
  <h1>Competitive Landscape — October 6, 2026</h1>
  <p class="byline">Prepared for Northwind · October 6, 2026</p>
</header>

<div class="body">
  <aside class="rail"><div class="sticky">
    <p class="toc-label">Contents</p>
    <nav class="toc" aria-label="Contents">
      <ol>
        <li><a href="#the-verdict">The verdict</a></li>
        <li><a href="#where-the-citations-point">Where the citations point</a></li>
        <li><a href="#the-two-engine-gap">The two-engine gap</a></li>
        <li><a href="#what-to-do-next">What to do next</a></li>
        <li><a href="#how-this-report-was-made">How this report was made</a></li>
      </ol>
    </nav>
  </div></aside>
  <article>

    <h2 id="the-verdict">The verdict</h2>
    <p>Northwind is cited in thirty of forty-one answers about the category, but the citations point to the blog and not the pricing page — the page a buyer reaches for last. The gap is concentrated in two engines, which makes it a fix rather than a trend.</p>

    <h2 id="where-the-citations-point">Where the citations point</h2>
    <h3>The click lands on the page that describes, not the one that sells</h3>
    <ul class="finding">
      <li><b>Problem:</b> Of the 30 answers that cited Northwind, 27 linked the blog and 3 linked the pricing page. The page a buyer is sent to is not the page that closes.</li>
      <li><b>Change:</b> Add the pricing page as a citation target for the twelve highest-volume prompts — the category-definition and comparison prompts where Northwind already wins the mention.</li>
      <li><b>Expected effect:</b> The click lands on the page that sells. A three-citation gap on 41 answers is small; the value is which page it moves, not the count.</li>
    </ul>

    <div class="tw">
      <table>
        <thead><tr><th>Prompt</th><th class="n">Citations</th><th class="n">To pricing</th></tr></thead>
        <tbody>
          <tr><td>best seo platform for agencies</td><td class="n">12</td><td class="n">1</td></tr>
          <tr><td>seo platform comparison</td><td class="n">9</td><td class="n">1</td></tr>
          <tr><td>what is generative engine optimization</td><td class="n">10</td><td class="n">1</td></tr>
        </tbody>
      </table>
    </div>

    <figure>
      <div class="bars" role="img" aria-label="Citations by engine: ChatGPT 14, Gemini 9, Perplexity 5, Google AI Overviews 2">
        <span class="label">ChatGPT</span><span class="track"><span class="bar" style="width:100%"></span></span><span class="value">14</span>
        <span class="label">Gemini</span><span class="track"><span class="bar" style="width:64%"></span></span><span class="value">9</span>
        <span class="label">Perplexity</span><span class="track"><span class="bar" style="width:36%"></span></span><span class="value">5</span>
        <span class="label">Google AI Overviews</span><span class="track"><span class="bar" style="width:14%"></span></span><span class="value">2</span>
      </div>
      <figcaption>One row per engine; the widest bar is 100% and the rest are scaled to it. Thirty citations in total.</figcaption>
    </figure>

    <div class="note"><p>Volumes here are a worked example, not a measurement. In a real run the citation split is read from the stored answers and the demand figures are estimates, and the report says which is which.</p></div>

    <h2 id="the-two-engine-gap">The two-engine gap</h2>
    <h3>The gap is an instruction list, so the work is bounded</h3>
    <ul class="finding">
      <li><b>Problem:</b> The gap is concentrated in Perplexity and Google AI Overviews, which cited Northwind 7 of 21 times; ChatGPT and Gemini cited it 23 of 20.</li>
      <li><b>Change:</b> Run the citation-gap report for the two weak engines. It returns the exact pages the models retrieved and did not cite — an instruction list, not a chart.</li>
      <li><b>Expected effect:</b> Two engines carry the gap, so a fix is one sprint rather than a quarter, and the list tells you which pages to change.</li>
    </ul>

    <hr>
    <h2 id="what-to-do-next">What to do next</h2>
    <ol><li>Add the pricing page as a citation target for the twelve highest-volume prompts, then re-run the brand-visibility monitor to confirm the click lands on the page that sells.</li></ol>

    <h2 id="how-this-report-was-made">How this report was made</h2>
    <p>Generated by the <a href="https://opengeo.so/docs/skills/competitor-analysis" target="_blank" rel="noopener">OpenGeo competitor-analysis skill</a>, run by an OpenGeo agent on October 6, 2026.</p>
    <ul class="finding">
      <li><b>Tools:</b> Brand visibility across the four engines reported the mentions and citations; the citation gap reported the pages retrieved and not cited.</li>
      <li><b>Verified:</b> In a real run the citation split is read from the stored answers rather than estimated. This example is a demonstration of the form, not a measurement of a live site.</li>
    </ul>

  </article>
</div>

<footer>Prepared with OpenGeo. Data as of October 6, 2026.</footer>
</div></body></html>`;

/** The document's title, for the frame's accessible name. */
export const SAMPLE_REPORT_TITLE = "Competitive Landscape — October 6, 2026";
