// SPDX-License-Identifier: Apache-2.0
// docusaurus.config.js — the snippet goes into `scripts`, which Docusaurus puts in the <head> of every page

// your site key (portal: site → Snippet), set at build time: SCF_SITE=… pnpm build
const site = process.env.SCF_SITE ?? "";

export default {
  title: "Example: Docusaurus",
  url: "https://docs.example.org",
  baseUrl: "/",
  scripts: [
    {
      src: "https://ingest-a.example-analytics.org/lib/1.2.0/standard.js",
      integrity: "sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu",
      crossorigin: "anonymous",
      "data-site": site,
      defer: true,
    },
  ],
  presets: [["classic", { docs: false, blog: false }]],
  themeConfig: {
    navbar: {
      items: [
        { to: "/", label: "Home", position: "left", activeBaseRegex: "^/$" },
        { to: "/about", label: "About", position: "left" },
      ],
    },
  },
};
