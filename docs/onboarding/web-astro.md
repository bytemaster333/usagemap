# Astro: the first 10 minutes

For an Astro site, static or server-rendered, with or without view transitions. You paste the script tag (with its
integrity hash) into the `<head>` of the layout every page uses; nothing to install.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, `localhost` as a dev origin |
| 2–4 | Paste the snippet into the layout |
| 4–6 | `pnpm dev`: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `astro@7.4.12` (static build, with `<ClientRouter />` view transitions). The code below is the
example site in the repository (`examples/astro`); the repository's browser tests build it and check in a real
browser that the landing page, each navigation through the view-transition router, the back button and a custom event
are each counted exactly once — the tracker is not started again when Astro swaps the page — and that a deep link
with a query string is counted once, as its path.

## 1. Add the website

Portal: **Add a website** → production domain; site settings → **Dev origins** → `localhost`
([dev origins](dev-origins-and-debug.md)). Dev-origin events are shown to you but never counted.

## 2. Paste the snippet into the layout

Copy the snippet from the portal (site → **Snippet**, format *Astro*): it carries your site key and the current
version's `integrity` hash. The tested layout reads the key from a public build variable
(`PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm build`); writing the key into the attribute directly works the same way.

```astro
---
// src/layouts/Base.astro — the snippet goes in the <head> of the layout every page uses
import { ClientRouter } from "astro:transitions";

// your site key (portal: site → Snippet), set at build time: PUBLIC_SCF_SITE=… pnpm build
const site = import.meta.env.PUBLIC_SCF_SITE;
---

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Example: Astro</title>
    <script
      is:inline
      src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
      integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
      crossorigin="anonymous"
      data-site={site}
      defer
    ></script>
    <ClientRouter />
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/about/">About</a></nav>
    <slot />
  </body>
</html>
```

- `is:inline` tells Astro to leave the tag exactly as written: the browser must load the pinned file from the
  ingest host, unchanged, or the `integrity` check fails. Never copy the file into your project to have it bundled.
- `integrity` and `crossorigin="anonymous"` are both required. If the hash does not match, the browser does not run
  the file: analytics stops, your site keeps working.
- With `<ClientRouter />` the tracker stays loaded across page swaps and counts each navigation through the History
  API. Without it every link loads a new page, and each page load is counted once (as on any
  [plain HTML site](web-html.md)).

## 3. Custom events

The script tag exposes the tracker as `window.scf`:

```astro
---
// src/pages/index.astro — a custom event through the classic script's window.scf
import Base from "../layouts/Base.astro";
---

<Base>
  <h1>Home</h1>
  <button type="button" onclick="window.scf && window.scf.track('signup', { plan: 'free' })">
    Sign up
  </button>
</Base>
```

## 4. Run it locally

```sh
PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm dev
```

The portal's first-event panel (site → **Installation**) lists the events from `localhost` as `dev`. Debug mode:
[dev origins and debug mode](dev-origins-and-debug.md).

## 5. Footprint, deploy, verify

1. Portal → **Footprint**: add your contracts or tick "no on-chain footprint" ([footprint](footprint.md)).
2. Deploy; verify the domain (site → **Domains**).
3. Open the production site in a browser without GPC or an ad blocker; the Installation page shows the first
   `verified` page view within about a minute.

**Content Security Policy**: `script-src https://ingest-a.example-analytics.org` and
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

Upgrading the tracker means changing the version **and** the `integrity` value in the layout; copy both from the
portal.
