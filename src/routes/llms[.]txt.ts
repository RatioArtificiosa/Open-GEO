import { createFileRoute } from "@tanstack/react-router";
import { llmsLinkHeaders, renderLlmsTxt } from "@/shared/llms-txt";

// Public by design: the point is that an agent can discover OpenGeo without an
// account, an API key, or a human. Nothing here is project data.
export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(renderLlmsTxt(), {
          headers: llmsLinkHeaders("/index.md"),
        }),
    },
  },
});
