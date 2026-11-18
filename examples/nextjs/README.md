# Next.js (App Router)

A Next.js App Router app with one client component, `<Analytics />`, rendered once in the root layout. Guide: [Next.js in 10 minutes](../../docs/onboarding/web-nextjs.md).

## Run it

1. **Install:** from the repository root, `pnpm install && pnpm --filter @usagemap/tracker build && pnpm -C examples install --frozen-lockfile --filter ./nextjs` (the tracker comes from this repository until its npm package is published).
2. **Set your key:** `export NEXT_PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY` (portal: **Site → Snippet**; on Vercel: Environment Variables).
3. **Run:** `pnpm -C examples/nextjs dev`, open http://localhost:3000.

## The lines that add UsageMap

`app/analytics.tsx`:

```tsx
"use client";
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict" for a strict site
import { useEffect } from "react";

// your site key (portal: site → Snippet), set in the build environment, e.g. Vercel → Environment Variables
export const SITE = process.env.NEXT_PUBLIC_SCF_SITE ?? "";

export function Analytics() {
  useEffect(() => {
    const start = () => init({ site: SITE });
    if (process.env.NODE_ENV === "production") return void start();
    // development: the debug module explains why something was (not) sent; start it before the tracker
    void import("@usagemap/tracker/debug").then(({ debug }) => debug()).finally(start);
  }, []);
  return null;
}
```

`app/layout.tsx`:

```tsx
        <Analytics />
```

## What you'll see in the portal

Portal → your website → **Integrations** → *Start live check*. Within seconds the first-event panel shows the
page view of `/` from `localhost` as `dev`, then the custom event `signup` (dev origins are never counted; add `localhost` under the site's
**Dev origins** first). Deployed on your declared domain, the status turns to **Live data seen** and the pages appear
in the dashboard.

## Test it without the app

```sh
curl -sS -i 'https://<INGEST_HOST>/v1/e' \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"v":1,"s":"YOUR_22_CHAR_SITE_KEY","p":"standard","tv":"1.1.0","e":[{"id":"usagemap-test-event-01","k":"pv","u":"/usagemap-test"}]}'
```

`HTTP 202`; the first-event panel lists the page view as *would be rejected (`challenge_missing`)*, which is expected:
curl does not solve the tracker's proof of work. It proves the site key, the edge and your dev origin are right
([how the website test works](../../docs/onboarding/integrations.md#how-the-website-test-works)).

## Tested by

`tests/quickstarts/frameworks/frameworks.spec.ts` builds this app in production mode, serves it with its own server and
drives it in Chromium against a mock of the ingest protocol: one page view per route (client-side navigations and the
back button included), the custom event `signup {plan: "free"}` exactly once, a deep link with a query string counted
once as its path, and no request to any other host. `tests/quickstarts/frameworks.test.ts` checks that the guide shows
this app's files and versions. Run: `QS_FRAMEWORKS=nextjs tests/quickstarts/frameworks/run.sh`.
