# Nuxt: the first 10 minutes

For a Nuxt app (server-rendered, statically generated or a single-page app). The tracker is an npm package with no
dependencies; one client-only plugin starts it.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, `localhost` as a dev origin |
| 2–4 | Install the package and add the plugin |
| 4–6 | `pnpm dev`: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `nuxt@4.6.4`, `vue@3.5.45` (production build, served by the built Nitro server). The code below is
the example app in the repository (`examples/nuxt`); the repository's browser tests build it and check in a real
browser that the server-rendered landing page, each client-side navigation (`<NuxtLink>`), the back button and a
custom event are each counted exactly once, and that a deep link with a query string is counted once, as its path.

## 1. Add the website

Portal: **Add a website** → production domain; site settings → **Dev origins** → `localhost`
([dev origins](dev-origins-and-debug.md)). Dev-origin events are shown to you but never counted.

## 2. Install and add the plugin

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

> **Not yet on npm (2026-11-19):** the package is published to the npm registry together with the public
> repository; until then use the plain script tag of [plain HTML](web-html.md), which the live ingest hosts serve.

Declare the site key as public runtime configuration:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  telemetry: false,
  devtools: { enabled: false },
  // your site key (portal: site → Snippet); set NUXT_PUBLIC_SCF_SITE in the server's environment
  runtimeConfig: { public: { scfSite: "" } },
});
```

The value comes from the server's environment when it starts: `NUXT_PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY`
(portal: site → **Snippet**). The key is public; it is sent to the browser in the page. The tested app is built
without the variable and gets it only at start, so one build can serve staging and production with different sites.

```ts
// app/plugins/scf-analytics.client.ts — `.client`: runs in the browser only, once per page load
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"

export default defineNuxtPlugin(() => {
  const scf = init({ site: useRuntimeConfig().public.scfSite });
  // available as useNuxtApp().$scf in components (undefined if the tracker did not start)
  return { provide: { scf } };
});
```

- The `.client` suffix keeps the plugin out of server rendering; it runs once per page load in the browser.
  Navigations of the Vue Router are followed through the History API; hydration adds no page view.
- On Nuxt 3 the directory is `plugins/` at the project root instead of `app/plugins/`; the code is the same (not
  covered by the tests here).
- For a strict site import from `@usagemap/tracker/strict`.

## 3. Custom events

```vue
<!-- app/pages/index.vue — a custom event -->
<script setup lang="ts">
const { $scf } = useNuxtApp();
const signUp = () => $scf?.track("signup", { plan: "free" });
</script>

<template>
  <main>
    <h1>Home</h1>
    <button type="button" @click="signUp">Sign up</button>
  </main>
</template>
```

## 4. Run it locally

```sh
NUXT_PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm dev
```

The portal's first-event panel (site → **Installation**) lists the events from `localhost` as `dev`, with the verdict
they would have had in production. To see in the browser why something was or was not sent, use the debug module
([dev origins and debug mode](dev-origins-and-debug.md)).

## 5. Footprint, deploy, verify

1. Portal → **Footprint**: add your contracts or tick "no on-chain footprint" ([footprint](footprint.md)).
2. Deploy with `NUXT_PUBLIC_SCF_SITE` set in the production environment; verify the domain (site → **Domains**).
3. Open the production site in a browser without GPC or an ad blocker; the Installation page shows the first
   `verified` page view within about a minute.

**Content Security Policy**:
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

Wallets: attach an adapter in the same plugin, right after `init()` ([wallet adapters](wallets.md)).
