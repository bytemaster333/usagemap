# SvelteKit: the first 10 minutes

For a SvelteKit app with any adapter (Node, static, Vercel, Cloudflare). The tracker is an npm package with no
dependencies; the root layout starts it once.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, `localhost` as a dev origin |
| 2–4 | Install the package and start it in the root layout |
| 4–6 | `pnpm dev`: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `@sveltejs/kit@3.2.0`, `svelte@5.57.3`, `@sveltejs/adapter-node@6.0.2` (production build, server
rendering). The code below is the example app in the repository (`examples/sveltekit`); the repository's browser
tests build it and checks in a real browser that the server-rendered landing page, each client-side navigation, the
back button and a custom event are each counted exactly once, and that a deep link with a query string is counted
once, as its path.

## 1. Add the website

Portal: **Add a website** → production domain; site settings → **Dev origins** → `localhost`
([dev origins](dev-origins-and-debug.md)). Dev-origin events are shown to you but never counted.

## 2. Install and start the tracker

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

> **Not yet on npm (2026-11-19):** the package is published to the npm registry together with the public
> repository; until then use the plain script tag of [plain HTML](web-html.md), which the live ingest hosts serve.

The site key (portal: site → **Snippet**) is a public variable fixed at build time
(`PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm build`):

```ts
// src/env.ts — your site key (portal: site → Snippet), public and fixed at build time:
// PUBLIC_SCF_SITE=… pnpm build
import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({ PUBLIC_SCF_SITE: { public: true, static: true } });
```

```ts
// src/lib/analytics.ts
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"
import { PUBLIC_SCF_SITE } from "$app/env/public";

/** Starts the tracker in the browser, or returns the running one; undefined during server rendering. */
export const analytics = () => init({ site: PUBLIC_SCF_SITE });
```

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
import { onMount } from "svelte";
import { analytics } from "#lib/analytics.ts";

let { children } = $props();
onMount(() => {
  analytics(); // once, in the browser; client-side navigations are followed through the History API
});
</script>

<nav><a href="/">Home</a> <a href="/about">About</a></nav>
{@render children()}
```

SvelteKit 3 imports `$lib` modules as `#lib` (a `package.json` `imports` entry, `"#lib/*": "./src/lib/*"`). On
SvelteKit 2, write `$lib/analytics` and read the key from `$env/static/public` instead of `src/env.ts` and
`$app/env/public`; the tracker code is the same (SvelteKit 2 is not covered by the tests here).

- `onMount` runs only in the browser, once for the root layout. SvelteKit's client-side navigations use the History
  API, which the tracker follows; hydration adds no page view.
- For a strict site import from `@usagemap/tracker/strict`.

## 3. Custom events

```svelte
<!-- src/routes/+page.svelte — a custom event -->
<script lang="ts">
import { analytics } from "#lib/analytics.ts";
</script>

<main>
  <h1>Home</h1>
  <button type="button" onclick={() => analytics()?.track("signup", { plan: "free" })}>Sign up</button>
</main>
```

## 4. Run it locally

```sh
PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm dev
```

The portal's first-event panel (site → **Installation**) lists the events from `localhost` as `dev`. To see in the
browser why something was or was not sent, use the debug module ([dev origins and debug
mode](dev-origins-and-debug.md)).

## 5. Footprint, deploy, verify

1. Portal → **Footprint**: add your contracts or tick "no on-chain footprint" ([footprint](footprint.md)).
2. Build with `PUBLIC_SCF_SITE` set, deploy, verify the domain (site → **Domains**).
3. Open the production site in a browser without GPC or an ad blocker; the Installation page shows the first
   `verified` page view within about a minute.

**Content Security Policy** (SvelteKit's `csp` option or your host's headers):
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

Wallets: attach an adapter next to `init()` in `src/lib/analytics.ts` ([wallet adapters](wallets.md)).
