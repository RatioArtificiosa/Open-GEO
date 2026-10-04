import { useState } from "react";
import { FIELD_CLASS, SubmitButton, ToolForm } from "@/lib/free-tools/form";
import { UpsellCard } from "@/lib/free-tools/upsell-card";
import { useToolRun } from "@/lib/free-tools/use-tool-run";

const TOOL = "ask-the-ai";

type Link = { title: string; url: string };

type AskResult = {
  keyword: string;
  prompt: string;
  summary: string;
  links: Link[];
  uncited: boolean;
};

/** A hostname for display, without pretending we know how the model used it. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function AskTheAiTool() {
  const [keyword, setKeyword] = useState("");
  const [prompt, setPrompt] = useState("");
  const { status, errorMessage, result, run } = useToolRun<AskResult>(
    TOOL,
    "/api/ask-the-ai",
  );

  const loading = status === "loading";

  return (
    <div>
      <ToolForm
        onSubmit={run}
        input={{ keyword, prompt }}
        status={status}
        errorMessage={errorMessage}
        cacheDuration="24 hours"
      >
        <label htmlFor="ask-keyword" className="sr-only">
          Search term
        </label>
        <input
          id="ask-keyword"
          name="keyword"
          type="text"
          required
          maxLength={300}
          spellCheck={false}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="best crm for agencies"
          disabled={loading}
          className={FIELD_CLASS}
        />

        <label htmlFor="ask-prompt" className="mt-4 block text-sm font-medium">
          What do you want to know?
        </label>
        <textarea
          id="ask-prompt"
          name="prompt"
          rows={3}
          required
          maxLength={2000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Which of these do agencies actually pay for?"
          disabled={loading}
          className={`${FIELD_CLASS} mt-1.5 h-auto py-2.5`}
        />
        <p className="mt-2 text-xs text-[var(--color-brand-muted)]">
          The question has to be about the search term above — Google&rsquo;s
          answer is generated from that page, and an off-topic question is
          refused.
        </p>

        <div className="mt-3">
          <SubmitButton status={status} idleLabel="Ask Google's AI answer" />
        </div>
      </ToolForm>

      {status === "done" && result ? (
        <div className="mt-6">
          <div className="rounded-lg border border-[var(--color-border-subtle)] p-5">
            <h3 className="text-sm font-medium text-[var(--color-brand-muted)]">
              What Google&rsquo;s AI answer says about &ldquo;
              {result.keyword}&rdquo;
            </h3>
            {result.summary ? (
              // The model's own words, including where it placed its citations.
              // The link list below is the same citations, extracted — not a
              // second opinion.
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-800">
                {result.summary}
              </p>
            ) : (
              <p className="mt-3 text-sm text-neutral-600">
                Google returned no written answer for that question. That is an
                absence of data, not evidence that nothing is there.
              </p>
            )}
          </div>

          {result.links.length > 0 ? (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-[var(--color-brand-muted)]">
                Sources it used ({result.links.length})
              </h4>
              <ul className="mt-2 space-y-1.5">
                {result.links.map((link) => (
                  <li key={link.url} className="text-sm">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="text-neutral-900 underline underline-offset-2"
                    >
                      {link.title || hostOf(link.url)}
                    </a>{" "}
                    <span className="text-[var(--color-brand-muted)]">
                      {hostOf(link.url)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              It cited nothing. Read that answer as unsupported — nothing here
              traces back to a source you can check.
            </p>
          )}

          <p className="mt-4 text-xs leading-relaxed text-[var(--color-brand-muted)]">
            This is one model&rsquo;s reading of one search result page. Google
            does not say which model produced it, and it is not a ranking or a
            fact about the web — it is what one system concluded from the pages
            it was shown. The sources above are the part you can check.
          </p>

          <UpsellCard tool={TOOL} cta="Track how this changes">
            One answer is a snapshot. OpenGeo re-asks the same questions on a
            schedule, so you can see when your brand starts appearing — and when
            a competitor does.
          </UpsellCard>
        </div>
      ) : null}
    </div>
  );
}
