import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "@/components/landing-page";
import { buildPageSeo } from "@/lib/seo";

const homeTitle = "OpenGeo - Open Source SEO Platform";
const homeDescription =
  "OpenGeo is the alternative to Ahrefs and Semrush for AI search: see what ChatGPT, Gemini and Perplexity say about your brand, and keep every answer. Keyword research, backlinks, rank tracking and site audits from $10/month, with $0.50 free and no card.";

export const Route = createFileRoute("/_marketing/")({
  head: () => {
    const seo = buildPageSeo({
      title: homeTitle,
      description: homeDescription,
      path: "/",
      imageAlt: "OpenGeo keyword research dashboard preview",
    });

    return {
      ...seo,
      links: [
        ...(seo.links ?? []),
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossOrigin: "anonymous",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..600&family=JetBrains+Mono:wght@400;500&display=swap",
        },
      ],
    };
  },
  component: LandingPage,
});
