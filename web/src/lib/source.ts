import { loader } from "fumadocs-core/source";
// Keep this server runtime import explicit. In this app's SSR build, the
// public Vite runtime entry resolves to the browser variant for sourceAsync.
import { fromConfig } from "fumadocs-mdx/runtime/vite.server";
import { blog, docs, docsMeta } from "../../.source/index";
import type * as Config from "../../source.config";

const serverCreate = fromConfig<typeof Config>();

export const blogSource = loader({
  source: await serverCreate.sourceAsync(blog, {} as Record<string, never>),
  baseUrl: "/blogs",
});

export const docsSource = loader({
  source: await serverCreate.sourceAsync(docs, docsMeta),
  baseUrl: "/docs",
  plugins: [
    {
      transformPageTree: {
        folder(node, folderPath) {
          // Folders whose meta.json lists an explicit "[Overview](...)" link;
          // drop the index node so the folder title doesn't duplicate it.
          if (folderPath !== "skills" && folderPath !== "self-hosting")
            return node;

          return {
            ...node,
            index: undefined,
          };
        },
      },
    },
  ],
});
