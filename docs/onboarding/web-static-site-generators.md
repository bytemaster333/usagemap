# Static site generators: Eleventy, Hugo, Jekyll

A generated site is plain HTML: paste the script tag (with its integrity hash) into the `<head>` template that every
page uses, rebuild, deploy. Nothing to install. The steps around it (website, dev origin, footprint, domain
verification) are those of [plain HTML](web-html.md).

**Tested with** `@11ty/eleventy@3.1.8`. The Eleventy layout below is the example site in the repository
(`examples/eleventy`); the repository's browser tests build it and check in a real browser that each page load is
counted exactly once, the custom-event button sends one event, and a deep link with a query string is counted once,
as its path. The Hugo and Jekyll recipes put the same tag in the same place; they are not run by the tests.
Documentation sites (VitePress, Docusaurus) have their own, tested page: [documentation sites](web-docs-sites.md).

## The rule for every generator

1. Copy the snippet from the portal (site → **Snippet**, format *HTML*). It carries your site key and the current
   version's `integrity` hash.
2. Put it in the `<head>` of the base layout, exactly as copied. `integrity` and `crossorigin="anonymous"` must stay:
   without `crossorigin` the browser cannot check the hash, and if the hash does not match, the browser does not run
   the file (analytics stops, the page keeps working).
3. Do not let an asset pipeline fingerprint, minify, bundle or self-host the file: the browser must load the pinned
   file from the ingest host unchanged.
4. Upgrading the tracker means changing the version **and** the `integrity` value; copy both from the portal.

## Eleventy (tested)

```njk
{# src/_includes/base.njk — the snippet goes in the <head> of the layout every page uses #}
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{ title }}</title>
    <script
      src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
      integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
      crossorigin="anonymous"
      data-site="{{ scf.site }}"
      defer
    ></script>
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/about/">About</a></nav>
    {{ content | safe }}
  </body>
</html>
```

The site key comes from a global data file, so staging and production builds can use different sites
(`SCF_SITE=YOUR_22_CHAR_SITE_KEY npx @11ty/eleventy`); writing the key into the attribute directly works the same
way:

```js
// src/_data/scf.js — your site key (portal: site → Snippet), set at build time: SCF_SITE=… npx @11ty/eleventy
export default { site: process.env.SCF_SITE ?? "" };
```

Custom events go through `window.scf`, which the script tag sets:

```njk
---
layout: base.njk
title: Home
---
<h1>Home</h1>
<button type="button" onclick="window.scf && window.scf.track('signup', { plan: 'free' })">Sign up</button>
```

## Hugo

Put the tag into the partial your theme renders inside `<head>`. To change a theme's template without editing the
theme, create a file with the same name in the same directory under your project's `layouts/` (current Hugo keeps
partials in `layouts/_partials/`; older themes use `layouts/partials/`). Copy the theme's head partial there and add
the snippet before its closing line.

## Jekyll

Copy your theme's `_includes/head.html` (the Minima theme has one) into your site's `_includes/` directory and add
the snippet inside it. Your copy replaces the theme's file; theme updates to that file no longer reach you.

## Docusaurus

See [documentation sites](web-docs-sites.md#docusaurus): `scripts` in `docusaurus.config.js`, tested with the
default theme.

## Check it

Open the deployed page, view its source and find the tag as you pasted it. In the browser's developer tools, the
console must show no integrity error for the tracker file, and the network panel shows requests to the ingest host.
The portal's Installation page shows the first page view about a minute later
([troubleshooting](troubleshooting.md)).
