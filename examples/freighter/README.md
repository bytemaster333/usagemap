# Freighter (without Wallets Kit)

A vanilla Vite dApp that calls Freighter's own API (`@stellar/freighter-api` 6.0.0) directly. Every call made through the wrapped API becomes a wallet event (connect, sign requested/approved/rejected) with wallet type and network only. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#wallets-called-directly-freighter-albedo-xbull-lobstr-hana-hot).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY` (portal: site → **Snippet**), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/freighter dev`, open http://localhost:5173 in a browser with the Freighter extension on testnet.

## The lines that add UsageMap

`src/main.ts`:

```ts
import * as freighterApi from "@stellar/freighter-api";
import { init } from "@usagemap/tracker";
import { wrapFreighter } from "@usagemap/tracker/wallets";
// …
// UsageMap: page views, plus wallet events for every call made through the wrapped API
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
const freighter = wrapFreighter(freighterApi, {
  networkPassphrase: "Test SDF Network ; September 2015",
});
```

## What you'll see in the portal

Project → **Integrations** → **Freighter (and other wallets called directly)**: status *Test received* within seconds. The first-event panel (site →
**Installation**) lists the page view and each wallet event as `dev` traffic for 24 hours; it is never counted. In
production the events feed **Wallets** (the wallet funnel: daily counts per wallet type and network, testnet apart
from mainnet). Sign and submit events are counted only, never attached to a visit.

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

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): freighter-api 6.0.0 against an emulation of the Freighter extension's content-script protocol (`FREIGHTER_EXTERNAL_MSG_REQUEST` / `…_RESPONSE`) — connect, sign and a declined signature arrive as schema-v1 events with `wt: freighter`, `net: testnet`; no address or signature is sent; no other host is contacted.

## Notes

The same subpath has `wrapAlbedo`, `wrapXBull`, `wrapLobstr`, `wrapHana`, `wrapHot` and `wrapInjected`; swap the import and the wallet object.
