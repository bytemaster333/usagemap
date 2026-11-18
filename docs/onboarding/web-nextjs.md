# Next.js (App Router): the first 10 minutes

For a Next.js app, including one deployed on Vercel. The tracker is an npm package with no dependencies; you render
one client component in the root layout.

| Minute | Step |
|---|---|
| 0–2 | Add a website: production domain, plus `localhost` and your preview pattern as dev origins |
| 2–4 | Install the package and add the `<Analytics />` component |
| 4–6 | `pnpm dev` with debug mode: watch the first events arrive as `dev` |
| 6–7 | Register your footprint |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested with** `next@16.4.6`, `react@19.3.1` (App Router, production build, `next start`). The code below is the
complete example app in the repository (`examples/nextjs`); the repository's browser tests build it and check in a
real browser that the landing page, each client-side navigation, the back button and a custom event are each counted
exactly once.

## 1. Add the website and its dev origins

Portal: **Add a website** → production domain (for example `app.example.org`). In the site's settings add dev
origins: `localhost` and, for Vercel preview deployments, a pattern such as `myapp-*-myteam.vercel.app`. A bare
`*.vercel.app` is refused because it would admit every Vercel user ([dev origins](dev-origins-and-debug.md)).
Dev-origin events are shown to you but never counted.

## 2. Install and add the component

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

> **Not yet on npm (2026-11-19):** the package is published to the npm registry together with the public
> repository; until then use the plain script tag of [plain HTML](web-html.md), which the live ingest hosts serve.

Set your site key (portal: site → **Snippet**) as `NEXT_PUBLIC_SCF_SITE` in the build environment (on Vercel: the
project's environment variables; locally: `NEXT_PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY pnpm build`). The key is public
(it is in every page), so this is not a secret; a variable just lets staging and production report to different
sites.

```tsx
// app/analytics.tsx — render <Analytics /> once in the root layout
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

```tsx
// app/layout.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { Analytics } from "./analytics";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link> <Link href="/about">About</Link>
        </nav>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

- `init()` does nothing during server rendering and returns the running instance when it is called again (React
  StrictMode, fast refresh), so nothing is counted twice. App Router navigations (`<Link>`, `router.push`) are
  followed through the History API; hydration of a server-rendered or prerendered page does not produce a second page
  view. Both kinds of route are tested: `/` is prerendered, `/about` is rendered on every request.
- The debug module needs tracker 1.1.0 or later. With 1.0.0, call `init()` directly. It is loaded only in
  development, so production bundles do not contain it.
- Pin the version exactly (`--save-exact`). Upgrading is a deliberate change of the version.
- The npm package is the tested path for Next.js, and it needs no `script-src` exception in a Content Security
  Policy. A script tag in the root layout is not covered by the tests here.

## 3. Custom events

`init()` returns the running tracker, so any client component can send an event:

```tsx
// app/signup-button.tsx — a custom event from any client component
"use client";
import { init } from "@usagemap/tracker";
import { SITE } from "./analytics";

export function SignupButton() {
  // init() returns the running tracker (it never starts a second one)
  const signUp = () => init({ site: SITE })?.track("signup", { plan: "free" });
  return (
    <button type="button" onClick={signUp}>
      Sign up
    </button>
  );
}
```

## 4. Run it locally

```sh
pnpm dev
```

Open `http://localhost:3000`. The browser console (and a small panel on the page) shows each event the tracker
sends, or why it sent nothing. The portal's first-event panel (site → **Installation**) lists the events from
`localhost` as `dev`, with the verdict they would have had in production. Brave users: Global Privacy Control is on
by default and the tracker then sends nothing; debug mode says so ([troubleshooting](troubleshooting.md)).

## 5. Wallets (dApps)

If the app uses Stellar Wallets Kit, Freighter or a passkey wallet, attach the matching adapter next to `init()`; see
[wallet adapters](wallets.md). For Wallets Kit:

```tsx
// app/analytics.tsx — with the Wallets Kit adapter
"use client";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { useEffect } from "react";

// your site key (portal: site → Snippet), set in the build environment
const SITE = process.env.NEXT_PUBLIC_SCF_SITE ?? "";

export function Analytics() {
  useEffect(() => {
    init({ site: SITE });
    return attachWalletsKit(StellarWalletsKit); // returns detach; nothing is counted twice
  }, []);
  return null;
}
```

Wallet events are names and enum values only (`wallet_connect`, `sign_approved`, …); no address ever leaves the
browser. The repository's `examples/nextjs-wallets-kit` is a complete Next.js dApp with this component and
`@creit.tech/stellar-wallets-kit@2.8.0`: the browser test connects a wallet through the kit's own modal, signs, has
the user reject a second signature and disconnects, and checks that exactly these events arrive —
`wallet_modal_opened`, `wallet_selected`, `wallet_connect`, `wallet_modal_closed`, `sign_requested`, `sign_approved`,
`sign_requested`, `sign_rejected` (`user_rejected`), `wallet_disconnect` — and that the wallet's address and
signature appear in nothing the tracker sends. (The wallet in that test is an emulated browser extension; the kit,
the adapter and the app are the real ones.)

## 6. Register your footprint

Portal: **Footprint** → add the contracts your app calls that your project deployed, or tick "no on-chain footprint".
See [footprint](footprint.md).

## 7. Deploy and verify

Deploy to production, then verify the domain (portal: site → **Domains**). The Installation page shows the first
`verified` page view within about a minute. Preview deployments that match your dev pattern appear as `dev`.

**Content Security Policy** (if you set one in `next.config` headers):
`connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

## Next

- API telemetry from route handlers: [Next.js API](api-nextjs.md).
- Nothing arrives: [troubleshooting](troubleshooting.md).
