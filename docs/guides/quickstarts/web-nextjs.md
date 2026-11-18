# Web: Next.js (App Router)

**Status (docs.quickstarts-run, tracker.ssr-frameworks): run against Next.js.** The complete, maintained version of this recipe is the tenant
guide [`docs/onboarding/web-nextjs.md`](../../onboarding/web-nextjs.md), whose code is the example app
`examples/nextjs` (Next.js 16.4.6, App Router, `next start`). The framework browser suite
(`tests/quickstarts/frameworks/frameworks.spec.ts`) builds that app in production mode and checks in Chromium that the
prerendered and the per-request server-rendered route, every client-side navigation, the back button and a custom
event are each counted exactly once. Next.js lives only in the examples workspace (`examples/`, its own lockfile),
which is exempt from the licence gate because nothing in it is shipped (register C-135, decision D11); the product's
lockfile is unchanged. The snippet below is the portal's `nextjs` snippet, the same `init()` call.

## 1. Install

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

## 2. A client component, rendered once in the root layout

```tsx
// app/analytics.tsx — render <Analytics /> once in the root layout
"use client";
import { useEffect } from "react";
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict" for a strict site

export function Analytics() {
  useEffect(() => {
    init({ site: "YOUR_22_CHAR_SITE_KEY" });
  }, []);
  return null;
}
```

```tsx
// app/layout.tsx
import { Analytics } from "./analytics";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

Client-side navigations of the App Router use the History API, which the tracker follows; hydration of the
server-rendered page does not produce a second page view, and a second `init()` returns the running instance.

## 3. Content Security Policy

`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

## 4. Consent mode

Pass `consent: "required"` to `init()` and call `grantConsent()` / `revokeConsent()` on the returned object from your
consent tool — see [web-consent-mode.md](web-consent-mode.md).

For API analytics of a Next.js server, see [api-nextjs.md](api-nextjs.md).
