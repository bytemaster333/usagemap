# Passkey smart account (smart-account-kit)

A vanilla Vite dApp with a passkey smart wallet on testnet (`smart-account-kit` 0.10.0): create a wallet, connect to it. UsageMap counts passkey ceremonies (`passkey_used`: register, authenticate, sign), smart-wallet creation, connects and signatures — never the `C…` address, credential id or hashes. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#passkey-wallets-and-smart-accounts).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY VITE_WEBAUTHN_VERIFIER=<testnet WebAuthn verifier C…>` (portal: site → **Snippet**; the verifier address is in smart-account-kit's testnet deployments list), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/passkey dev`, open http://localhost:5173, press **Create wallet** (your browser asks for a passkey).

## The lines that add UsageMap

`src/main.ts`:

```ts
import { init } from "@usagemap/tracker";
import { attachSmartAccountKit } from "@usagemap/tracker/passkey";
// …
// UsageMap: page views, plus passkey ceremonies, smart-wallet creation, connects and signatures (never the C… address)
init({ site: env.VITE_USAGEMAP_SITE ?? "" });
attachSmartAccountKit(kit);
```

## What you'll see in the portal

Project → **Integrations** → **Passkey wallets and smart accounts**: status *Test received* within seconds. The first-event panel (site →
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

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): the real smart-account-kit with Chromium's virtual WebAuthn authenticator — the registration ceremony is counted as `passkey_used {po: register, net: testnet}`, and a prompted connect without a deployed account as `wallet_connect_failed {wt: passkey, fr: error_other}`; the configured verifier address and every StrKey stay out of what is sent. **Not run for real:** deploying the contract account needs testnet ledger state, which the offline RPC stand-in does not have, so `smart_wallet_created`, `wallet_connect` and signatures are covered by `tracker/test/passkey.test.ts` instead.

## Notes

For `passkey-kit` 0.20.0 use `attachPasskeyKit(kit)` from the same subpath.
