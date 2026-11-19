# Stellar Wallets Kit

A vanilla Vite dApp on Stellar Wallets Kit 2.8.0: connect in the kit's modal, sign a message, disconnect. UsageMap counts the page view and the wallet funnel (modal, wallet picked, connect, sign requested/approved/rejected, disconnect) with wallet type and network only. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#stellar-wallets-kit).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY` (portal: site → **Snippet**), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/wallets-kit dev`, open http://localhost:5173, connect a wallet on testnet.

## The lines that add UsageMap

`src/main.ts`:

```ts
import { init } from "@usagemap/tracker";
import { attachWalletsKit, wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";
// …
// UsageMap: page views, plus wallet events from the kit (wallet type and network only, never the address)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
StellarWalletsKit.init({
  modules: wrapWalletsKitModules(defaultModules()),
  network: Networks.TESTNET,
});
```

## What you'll see in the portal

Project → **Integrations** → **Stellar Wallets Kit**: status *Test received* within seconds. The first-event panel (site →
**Installation**) lists the page view and each wallet event as `dev` traffic for 24 hours; it is never counted. In
production the events feed **Wallets** (the wallet funnel: daily counts per wallet type and network, testnet apart
from mainnet). Sign and submit events are counted only, never attached to a visit.

## Test it without the app

Wallet integrations have no curl test of their own (connect a wallet on `localhost` instead). The website test:

```sh
curl -sS -i 'https://e1.usagemap.dev/v1/e' \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"v":1,"s":"YOUR_22_CHAR_SITE_KEY","p":"standard","tv":"1.1.0","e":[{"id":"usagemap-test-event-01","k":"pv","u":"/usagemap-test"}]}'
```

`HTTP 202`, and the portal's first-event panel lists the page view as *would be rejected (`challenge_missing`)*:
expected, because curl does not solve the proof of work the tracker solves. It proves the site key, the edge and the
dev origin `localhost` are right.

## Tested by

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): the real kit against an emulated Hana extension — connect through the kit's modal, sign, a user rejection and disconnect arrive as exactly one schema-v1 event each (wrapper and adapter together never double count); no address, signature or XDR is sent; only the kit's icon CDN is contacted besides the ingest hosts.
