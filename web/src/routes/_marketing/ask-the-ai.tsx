import { createFileRoute } from "@tanstack/react-router";
import { AskTheAiTool } from "@/components/ask-the-ai-tool";
import { ToolFrame } from "@/lib/free-tools/tool-frame";
import { freeTools } from "@/lib/free-tools/tool-pages";
import { buildPageSeo } from "@/lib/seo";

const TOOL = freeTools["ask-the-ai"];

export const Route = createFileRoute("/_marketing/ask-the-ai")({
  head: () =>
    buildPageSeo({
      title: "Ask the AI: What Does Google's AI Answer Say About Your Topic?",
      description:
        "Ask a question about any search term and read what Google's AI answer says, with the sources it used. Free, no signup, no email.",
      path: TOOL.path,
      titleSuffix: "OpenGeo",
      imageAlt: "OpenGeo free Ask the AI tool showing a Google AI answer",
    }),
  component: AskTheAiPage,
});

const FAQS = [
  {
    question: "What model is this?",
    answer:
      "Nobody knows — Google does not say which model generates these answers, and neither can we. Treat it as one system's reading rather than as Google's position, and check the sources it names.",
  },
  {
    question: "Is this Google's official answer?",
    answer:
      "It is one answer, generated for one search, at one moment. It changes with the query, the location, and the pages Google happened to show. Run it twice on different days and you may get different answers.",
  },
  {
    question: "Why does it sometimes cite nothing?",
    answer:
      "Sometimes the model answers from the results themselves without using page content, so there is nothing to attribute. We say so on the page rather than showing you an unsourced answer as though it were a sourced one.",
  },
  {
    question: "Why does my question have to match the search term?",
    answer:
      "Google generates the answer from that search result page, so an unrelated question has no answer to be generated from. The provider rejects it rather than inventing something — which would also cost you a paid request.",
  },
  {
    question: "Do I need an account?",
    answer: `No. Each question costs two provider calls, so there is a daily limit that applies to everyone equally — ${"200"} calls a day, or roughly 100 questions. Signing up removes the limit.`,
  },
];

const HIGHLIGHTS = [
  {
    title: "The answer, in its own words",
    description:
      "The model's text as Google generated it, including where it placed its citations.",
  },
  {
    title: "The sources, separated out",
    description:
      "Every page the answer used, extracted — so you can read what it actually based that on.",
  },
  {
    title: "Unsourced means unsourced",
    description:
      "When it cites nothing we say so, instead of letting the answer read as though it were researched.",
  },
];

function AskTheAiPage() {
  return (
    <ToolFrame
      tool={TOOL}
      heading="Ask the AI"
      subhead="Ask a question about any search term and read what Google's AI answer says — with the sources it used, so you can tell a claim from a citation."
      highlights={HIGHLIGHTS}
      faqs={FAQS}
      cta={{
        heading: "Ask this again next week and see what changed",
        body: "OpenGeo re-asks your questions on a schedule and shows you when the answer starts naming your brand — or a competitor's. Start with free trial credits.",
        featureLabel: "Learn about GEO monitoring",
      }}
    >
      <AskTheAiTool />
    </ToolFrame>
  );
}
