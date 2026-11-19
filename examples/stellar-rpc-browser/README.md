# Stellar RPC from the browser

A vanilla Vite page that calls Stellar RPC with js-stellar-sdk 17.4.0 (`rpc.Server`). UsageMap keeps per-page counts by RPC method, outcome class and latency bucket and sends them as **one aggregate** when the page is hidden — no visitor, session, URL (provider API keys stay in the browser), address or time of call. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#browser-rpc--horizon-telemetry-aggregate-only).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY` (portal: site → **Snippet**), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/stellar-rpc-browser dev`, open http://localhost:5173, press **Check RPC health**, then switch tabs (the aggregate is sent when the page is hidden).

## The lines that add UsageMap

`src/main.ts`:

```ts
import { init } from "@usagemap/tracker";
import { attachRpcTelemetry } from "@usagemap/tracker/stellar-rpc";
// …
// UsageMap: page views, plus one daily aggregate of RPC calls (method, outcome class, latency bucket)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
attachRpcTelemetry(server, { network: "testnet" });
```

## What you'll see in the portal

Project → **Integrations** → **Stellar RPC and Horizon calls from the browser**: the first-event panel shows the page view as `dev` traffic; the `stellar_rpc` aggregate of a dev origin is checked and dropped in memory, never shown or stored (the card's test command sends one). In production the counts are stored only as per-site daily totals and shown next to your backend's Stellar RPC panel once your UsageMap host enables it.

## Test it without the app

The aggregate has no curl test of its own. The website test:

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

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): the real SDK against a JSON-RPC stand-in — `getHealth` twice and `getNetwork` once become exactly one `stellar_rpc` event on page hide with cells `[rpc, get_health, testnet, ok, lt100ms, 2]` and `[rpc, get_network, testnet, ok, lt100ms, 1]`; nothing before the page is hidden; the RPC URL is never sent.

## Notes

For Horizon use `attachHorizonTelemetry(horizonServer, { network: "testnet" })` from the same subpath.
