# Documentation sites: VitePress and Docusaurus

A documentation site is a static build with a client-side router: put the script tag (with its integrity hash) into
the site's configuration once, and every page carries it. Page changes inside the site happen through the History API;
the tracker follows them itself, so no route-change hook or plugin is needed. The steps around it (website, dev origin,
footprint, domain verification) are those of [plain HTML](web-html.md).

**Tested with** `vitepress@1.6.4` and `@docusaurus/core@3.10.2` (with `@docusaurus/preset-classic@3.10.2`), both with
their default themes. The files below are the example sites in the repository (`examples/vitepress`,
`examples/docusaurus`); the repository's browser tests build each in production mode, serve the static output and
check in a real browser that the first page load and every in-site navigation (nav link, back button) is counted
exactly once without reloading the page, the custom-event button sends one event, a deep link with a query string and
a fragment is counted once as its path, and nothing goes to any other host.

## The rule

1. Copy the snippet from the portal (site → **Snippet**, format *HTML*). It carries your site key and the current
   version's `integrity` hash.
2. Put its attributes, unchanged, into the configuration below. `integrity` and `crossorigin: "anonymous"` must stay:
   without `crossorigin` the browser cannot check the hash, and if the hash does not match, the browser does not run
   the file (analytics stops, the site keeps working).
3. Upgrading the tracker means changing the version **and** the `integrity` value; copy both from the portal.

Both examples read the site key from the build environment (`SCF_SITE=… pnpm build`); pasting the key as a string
works just as well, it is public.

## VitePress

`head` in `.vitepress/config.mts` (or `config.ts` / `config.js`) is rendered into every page:

```ts
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
```

A custom event from a Markdown page, through the script's `window.scf`:

```md
# Home

<!-- a custom event through the classic script's window.scf -->
<button type="button" onclick="window.scf && window.scf.track('signup', { plan: 'free' })">Sign up</button>
```

- `defer: ""` renders as a bare `defer` attribute. VitePress keeps the attribute order and values as written.
- With `cleanUrls: true` the paths are counted without `.html`; the example uses the default (`/about.html`).

## Docusaurus

`scripts` in `docusaurus.config.js` is rendered into the `<head>` of every page; any attribute is allowed on a script
object:

```js
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
```

A custom event from an MDX page:

```mdx
# Home

{/* a custom event through the classic script's window.scf */}
<button type="button" onClick={() => window.scf && window.scf.track("signup", { plan: "free" })}>Sign up</button>
```

- `scripts` is the configuration's place for external scripts (the tested one). Do not copy the file into `static/`
  or bundle it through a plugin: the browser must load the pinned file from the ingest host unchanged.
- Docusaurus prefetches pages on hover; prefetching is not a page view, and the test counts none.

## Check it

Open the deployed site, view the page source and find the tag as you pasted it. In the browser's developer tools the
console must show no integrity error for the tracker file, and the network panel shows requests to the ingest host
when you load a page and when you follow a link inside the site. The portal's Installation page shows the first page
view about a minute later ([troubleshooting](troubleshooting.md)).

## Where this comes from

- VitePress site config reference, `head` (vitepress.dev/reference/site-config#head) and Docusaurus `docusaurus.config.js`
  reference, `scripts` (docusaurus.io/docs/api/docusaurus-config#scripts), read 2026-11-19.
- Everything else on this page is run by the repository's browser tests against the two example sites.
