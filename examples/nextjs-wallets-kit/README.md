# Next.js dApp with Stellar Wallets Kit

The Next.js example plus Stellar Wallets Kit 2.8.0: `attachWalletsKit` turns the kit's connect, sign and disconnect into schema-v1 wallet events (wallet type and network only, never an address). Guide: [Next.js, wallets](../../docs/onboarding/web-nextjs.md#5-wallets-dapps) and [wallet adapters](../../docs/onboarding/wallets.md#stellar-wallets-kit).

## Run it

1. **Install:** from the repository root, `pnpm install && pnpm --filter @usagemap/tracker build && pnpm -C examples install --frozen-lockfile --filter ./nextjs-wallets-kit` (the tracker comes from this repository until its npm package is published).
2. **Set your key:** `export NEXT_PUBLIC_SCF_SITE=YOUR_22_CHAR_SITE_KEY` (portal: **Site → Snippet**).
3. **Run:** `pnpm -C examples/nextjs-wallets-kit dev`, open http://localhost:3000, connect a testnet wallet and sign a message.

## The lines that add UsageMap

`app/analytics.tsx`:

```tsx
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

## What you'll see in the portal

Portal → your website → **Integrations** → *Start live check*. Within seconds the first-event panel shows the
page view of `/` from `localhost` as `dev`, then `wallet_modal_opened`, `wallet_selected`, `wallet_connect` and the `sign_*` events (portal: **Wallets** for the funnel) (dev origins are never counted; add `localhost` under the site's
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

Wallet events have no curl test: run the app on `localhost`, connect a testnet wallet and sign once.

## Tested by

`tests/quickstarts/frameworks/frameworks.spec.ts` builds this app in production mode and runs the real Stellar Wallets Kit in Chromium against an emulated Hana wallet extension: connect in the kit's modal, sign through method references copied before the adapter attached, a user rejection and a disconnect arrive as exactly the expected schema-v1 events, and no address, signature or wallet text leaves the page. Run: `QS_FRAMEWORKS=nextjs-wallets-kit tests/quickstarts/frameworks/run.sh`.
