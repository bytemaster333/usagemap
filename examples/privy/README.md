# Privy embedded Stellar wallet

A Vite + React dApp with a Privy embedded wallet on Stellar (`@privy-io/react-auth` 3.51.4): log in, create a Stellar wallet, sign a transaction hash. The wrapped hooks report `wallet_connect`/`wallet_connect_failed`, `sign_*` (`sk: tx`) and `wallet_disconnect` with `wt: privy` — never the user, e-mail, wallet id, address, hash or signature. Guide: [Wallet events and adapters](../../docs/onboarding/wallets.md#privy-embedded-stellar-wallets).

## Run it

1. **Install:** `pnpm --dir tracker run build && pnpm --dir examples install` (from the repository root; the
   tracker comes from this repository's build until the npm package is published).
2. **Set your key:** `export VITE_USAGEMAP_SITE=YOUR_22_CHAR_SITE_KEY VITE_PRIVY_APP_ID=<your Privy app id>` (portal: site → **Snippet**), and add `localhost` as a
   dev origin (site → **Settings** → **Dev origins**) so test traffic shows up and is never counted.
3. **Run:** `pnpm --dir examples/privy dev`, open http://localhost:5173 (allow `http://localhost:5173` in your Privy dashboard), log in, then **Create Stellar wallet**.

## The lines that add UsageMap

`src/main.tsx`:

```tsx
import { init } from "@usagemap/tracker";
// …
// UsageMap: page views (wallet events come from the wrapped Privy hooks in App.tsx)
init({ site: import.meta.env.VITE_USAGEMAP_SITE ?? "" });
```

`src/App.tsx`:

```tsx
import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";
// …
  // UsageMap: the same hooks, wrapped; only calls with chainType "stellar" are counted
  const { createWallet } = wrapPrivyStellar(useCreateWallet(), { networkPassphrase });
  const { signRawHash } = wrapPrivyStellar(useSignRawHash(), { networkPassphrase });
  const { logout } = wrapPrivyStellar(usePrivy());
  const { login } = useLogin(
    privyLoginCallbacks({
      onComplete: () => setLog("login: ok"),
      onError: () => setLog("login: failed"),
    }),
  );
```

## What you'll see in the portal

Project → **Integrations** → **Privy embedded Stellar wallets**: status *Test received* within seconds. The first-event panel (site →
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

`tests/quickstarts/integrations/browser/integrations.spec.ts` (run: `tests/quickstarts/integrations/browser/run.sh`): the production build renders with the wrapped hooks, sends its page view, contacts only Privy's and WalletConnect's own hosts besides the ingest hosts, and sends no wallet event without a login. **Not run for real:** Privy's login needs Privy's service and a real app id, so login, wallet creation and signing are not exercised here; the wrapper's events on Privy-shaped hooks are covered by `tracker/test/connect-failed.test.ts`.

## Notes

Only calls with `chainType: "stellar"` are counted; EVM or Solana wallets in the same app pass through untouched.
