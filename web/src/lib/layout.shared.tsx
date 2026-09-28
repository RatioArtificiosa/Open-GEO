import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-semibold">OpenGeo</span>,
    },
    searchToggle: {
      enabled: false,
    },
    links: [
      {
        text: "Resources",
        url: "/blogs",
        items: [
          {
            text: "Blog",
            description: "SEO articles and guides.",
            url: "/blogs",
          },
          {
            text: "MCP",
            description: "Connect OpenGeo to AI clients.",
            url: "/docs/mcp",
          },
          {
            text: "Skills",
            description: "Focused OpenGeo workflows.",
            url: "/docs/skills",
          },
        ],
      },
      {
        text: "GitHub",
        url: "https://github.com/RatioArtificiosa/Open-GEO",
        external: true,
      },
    ],
  };
}
