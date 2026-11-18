// SPDX-License-Identifier: Apache-2.0
// docs/.vitepress/config.mts — the snippet goes into `head`, so every page carries it
import { defineConfig } from "vitepress";

// your site key (portal: site → Snippet), set at build time: SCF_SITE=… pnpm build
const site = process.env.SCF_SITE ?? "";

export default defineConfig({
  title: "Example: VitePress",
  head: [
    [
      "script",
      {
        src: "https://ingest-a.example-analytics.org/lib/1.2.0/standard.js",
        integrity: "sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu",
        crossorigin: "anonymous",
        "data-site": site,
        defer: "",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "About", link: "/about" },
    ],
  },
});
