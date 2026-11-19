// SPDX-License-Identifier: Apache-2.0
import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { docsRoute, origins } from "./shared";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [lucideIconsPlugin()],
});

/** llms.txt, llms-full.txt and one Markdown file per page, for AI coding assistants. */
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText("processed")}`,
  // absolute links: llms.txt is read outside the site
  renderUrl: (item) =>
    `${origins.docs}${/^\/.*\.(md|txt)$/.test(item.url) ? `/llms.mdx${item.url}` : item.url}`,
});
