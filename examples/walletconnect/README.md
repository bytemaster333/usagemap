# WalletConnect (via Stellar Wallets Kit)

A vanilla Vite dApp that connects phone wallets over WalletConnect, through the Wallets Kit's WalletConnect module. Besides the wallet events, UsageMap gets the WalletConnect funnel: session proposed → approved or rejected, and each signing request approved or rejected. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#connect-failures-wallet-context-and-walletconnect-tracker-120).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY VITE_WALLETCONNECT_PROJECT_ID=<your Reown project id>` (portal: site → **Snippet**), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/walletconnect dev`, open http://localhost:5173, pick WalletConnect and scan the QR code with a Stellar wallet on testnet.

## The lines that add UsageMap

`src/main.ts`:

```ts
import { init } from "@usagemap/tracker";
import { attachWalletsKit, wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";
// …
// UsageMap: page views, wallet events and the WalletConnect funnel (session proposed → approved | rejected)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
StellarWalletsKit.init({
  modules: wrapWalletsKitModules([walletConnect]),
  network: Networks.TESTNET,
});
```

## What you'll see in the portal

Project → **Integrations** → **Stellar Wallets Kit**: status *Test received* within seconds. The first-event panel (site →
**Installation**) lists the page view and each wallet event as `dev` traffic for 24 hours; it is never counted. In
production the events feed **Wallets** (the wallet funnel: daily counts per wallet type and network, testnet apart
from mainnet). Sign and submit events are counted only, never attached to a visit. The WalletConnect funnel appears next to it (`walletconnect_session`, `walletconnect_request`).

## Test it without the app

Wallet integrations have no curl test of their own. The website test:

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

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): the real kit and WalletConnect module — opening the modal and picking WalletConnect sends `wallet_modal_opened`, `wallet_selected {wt: walletconnect}` and `walletconnect_session {ws: proposed, net: testnet}`. **Not run for real:** the relay (`wss://relay.walletconnect.org`) and a phone wallet are unreachable offline, so approval, rejection and `walletconnect_request` are not exercised here; the adapter's handling of them is covered by `tracker/test/wallets-kit.test.ts`. Only WalletConnect/Reown hosts and the kit's icon CDN are contacted besides the ingest hosts.
