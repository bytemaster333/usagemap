# Wallet events and adapters

A dApp's real usage happens at the wallet: a connect, a signature, a submitted transaction. The tracker records these
moments as **events with closed names and closed values**, the same vocabulary for every project (the Stellar event
schema, version 1), so that your numbers can be compared with other projects' without anyone seeing an address.

**What never leaves the browser:** addresses (`G…`, `C…`, `M…`), transaction hashes, XDR, signatures, signed
messages, memos, amounts, network passphrases and error messages. Each adapter reads only what it needs to pick an
enum value and keeps nothing.

Adapters need tracker **1.1.0 or later**. They work with both profiles; with the `strict` profile, wallet events are
sent only when you attach an adapter.

**Availability:** the adapters ship in the npm package `@usagemap/tracker`. The module-level observation described
below is in the repository's code and tests; check that the package version you install carries it.

## Stellar Wallets Kit

```ts
import { init } from "@usagemap/tracker";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";

init({ site: "YOUR_22_CHAR_SITE_KEY" });
const detach = attachWalletsKit(StellarWalletsKit); // call detach() to undo
```

- Works with the kit's 2.x static API (tested against 2.8.0, the current release). The kit is your dependency; the
  tracker never installs it.
- The adapter subscribes to the kit's own events and observes sign calls on the **selected wallet module** (the kit's
  `selectedModule`, through which every 2.x method delegates at call time) transparently: same arguments, same result
  or error, nothing awaited before your call reaches the wallet. You can attach at any time: method references your
  app copied off the kit before attaching (Scaffold Stellar's `wallet.ts` exports `StellarWalletsKit.signTransaction`
  at load), modules passed to a later `init()` and WalletConnect's `signAndSubmitTransaction` are all counted;
  `detach()` restores the kit exactly. Use the adapter subpath only (`@usagemap/tracker/wallets-kit`); it never
  imports or bundles the kit.
- If your app also calls a kit wallet module itself, outside the kit, wrap the modules where you construct them:
  pass `wrapWalletsKitModules(defaultModules())` as the `modules` option of the kit's own `StellarWalletsKit.init`
  call. With `attachWalletsKit` as well, every event is still counted once.
- A session the kit restores on page load is reported as `wallet_connect` with `ck: "restored"`, never as a new
  connection.
- Without the adapter, the `standard` profile still records the wallet modal opening and closing and the wallet
  picked (from the kit's page elements, no wallet access).

## Wallets called directly (Freighter, Albedo, xBull, LOBSTR, Hana, HOT)

If your app calls a wallet's own API without Wallets Kit, wrap it once and call the wrapped object instead:

```ts
import * as freighterApi from "@stellar/freighter-api";
import { wrapFreighter } from "@usagemap/tracker/wallets";

export const freighter = wrapFreighter(freighterApi);
// use freighter.requestAccess(), freighter.signTransaction(...) exactly as before
```

- The same subpath has `wrapAlbedo`, `wrapXBull`, `wrapLobstr`, `wrapHana`, `wrapHot`, and `wrapInjected` for any
  other injected SEP-43-style provider.
- None of these wallets emits events of its own, so only calls made through the wrapper are seen. The wrapper returns
  a wrapped view; the wallet object itself is never modified, calls are passed on synchronously with the same
  arguments (pop-ups still open inside the user's click), and the result is exactly the wallet's.
- Pass `{ networkPassphrase }` as the second argument when the wallet calls do not carry one, so that `net` is right.

## Your own transaction submission

`tx_submitted` comes from the call that submits. Wallets Kit's `signAndSubmitTransaction` is covered by its adapter.
If your app submits itself with the Stellar SDK, attach the server object once:

```ts
import { rpc } from "@stellar/stellar-sdk";
import { attachRpcServer } from "@usagemap/tracker/wallets";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
attachRpcServer(server); // or attachHorizonServer(horizonServer) for Horizon submissions
```

The adapter makes no request of its own. It reads the submission's status (and, for RPC, waits for your app's own
poll of that submission to see success or failure); the transaction hash is held in memory only to match the poll and
is never sent.

## Passkey wallets and smart accounts

```ts
import { attachPasskeyKit } from "@usagemap/tracker/passkey";

attachPasskeyKit(passkeyKit); // your PasskeyKit instance (passkey-kit 0.20.0)
```

```ts
import { attachSmartAccountKit } from "@usagemap/tracker/passkey";

attachSmartAccountKit(smartAccountKit); // your SmartAccountKit instance (smart-account-kit 0.10.0)
```

These report `smart_wallet_created` when a contract account is deployed for the user and `passkey_used` for each
WebAuthn ceremony (`po`: `register`, `authenticate` or `sign`). The payloads of these libraries carry the user's
`C…` address; the adapter reads only the event name. Both libraries declare a few events they never fire; the adapter
does not invent them.

## The events

| Event | Fields sent | When |
|---|---|---|
| `wallet_modal_opened` | — | the wallet picker is shown |
| `wallet_modal_closed` | `out` (`connected`, `dismissed`, `error`); `wt` when connected | the picker closes |
| `wallet_selected` | `wt` | the user picks a wallet |
| `wallet_connect` | `wt`, `net`, `ck` (`new`, `restored`) | an address became available to the app |
| `wallet_disconnect` | `wt`; `net` optional | the user disconnects |
| `sign_requested` | `wt`, `net`, `sk` (`tx`, `auth_entry`, `message`, `tx_submit`) | the app asks the wallet to sign |
| `sign_approved` | `wt`, `net`, `sk`, `dur` (`lt5s`, `5_30s`, `gt30s`) | the wallet returned a signature |
| `sign_rejected` | `wt`, `net`, `sk`, `dur`, `ec` | the wallet returned an error |
| `tx_submitted` | `rc` (`success`, `failed`, `pending`, `try_again_later`, `error`), `net`; `wt` optional | a submission through an attached kit or server settled |
| `smart_wallet_created` | `net`; `wt` optional (usually `passkey`) | a smart wallet was deployed for the user |
| `passkey_used` | `po`, `net` | a passkey ceremony completed |

- **Wallet type `wt`:** `freighter`, `albedo`, `xbull`, `lobstr`, `hana`, `hot`, `rabet`, `walletconnect`, `ledger`,
  `trezor`, `fordefi`, `klever`, `onekey`, `bitget`, `cactuslink`, `dcent`, `scopuly`, `metamask`, `ghostsig`,
  `passkey`, `privy` (1.2.0), `injected_other`, `unknown`.
- **Network `net`:** `mainnet`, `testnet`, `futurenet`, `local`, `unknown` — decided in the browser from the network
  passphrase, which is never sent.
- **Error class `ec`** (the wallet's SEP-43 error code, never its message): `user_rejected`, `invalid_request`,
  `external_service`, `internal`, `timeout`, `unsupported`, `unknown`.

What one request body looks like (this is everything the server receives about these two moments):

```json
{"v":1,"s":"YOUR_22_CHAR_SITE_KEY","p":"standard","tv":"1.1.0","t":"<challenge token>","c":417,
 "e":[{"id":"c3L1a6zUo9wX2bS5dMy4rK","k":"wl","sv":1,"u":"/swap","n":"sign_rejected","wt":"freighter","net":"mainnet","sk":"tx","dur":"lt5s","ec":"user_rejected"},
      {"id":"d4M2b7aVp0xY3cT6eNz5sL","k":"wl","sv":1,"u":"/swap","n":"tx_submitted","wt":"freighter","net":"testnet","rc":"try_again_later"}]}
```

## Counted-only events

`sign_requested`, `sign_approved`, `sign_rejected`, `tx_submitted`, `smart_wallet_created` and `passkey_used` are
**counted only**: they go into daily totals per event, network and value, and nowhere else. They are never attached
to a visit, never stored with a page, a time of day or a device, and they do not count towards your daily event quota.

Why: each of these moments can coincide with a public transaction on the ledger. On a contract with little traffic, a
visit record that said "signed at 14:03:07 from a phone in Portugal" next to a ledger transaction at 14:03:09 would tie
a public account to a browser session. Keeping these events as day-level counts makes that impossible, and loses
nothing for your funnel: the wallet funnel is computed from the daily counts.

The other wallet events (`wallet_modal_opened`, `wallet_modal_closed`, `wallet_selected`, `wallet_connect`,
`wallet_disconnect`) have no ledger counterpart and appear in your dashboard like custom events: they also make the
visit a non-bounce.

**What this means for your numbers:**

- The wallet funnel (portal: **Wallets**) shows daily counts per wallet type and network, with a mainnet/testnet
  switch. Your own view is exact.
- Anything that leaves your project (SCF operator views, public pages, cohorts, snapshots) omits any daily count
  below 10.
- Testnet activity is counted separately from mainnet and never mixed into mainnet figures.

## Custom events are separate

`track("wallet_connect")` is a custom event, not a wallet event: it is never counted in the wallet funnel. Use the
adapters for wallet moments and `track()` for your own product events.

## Checking that it works

With the [debug module](dev-origins-and-debug.md#tracker-debug-mode-why-nothing-was-sent) on, the console shows each
event the tracker sends, by kind and name, for example `wallet_connect`. Events from
`localhost` appear in the portal's first-event panel as `dev` and are never counted. See
[dev origins and debug mode](dev-origins-and-debug.md).

### Connect failures, wallet context and WalletConnect (tracker 1.2.0)

Every adapter now also reports **`wallet_connect_failed`** when an explicit connect does not give the app a usable
connection, with one closed reason: `user_rejected`, `wallet_not_installed`, `wallet_locked` (the wallet answered
without an address), `network_mismatch` (pass `networkPassphrase` so the adapter can compare it with the wallet's
own network), `timeout` or `error_other`. Silent session restores that find nothing are not failures.
`wallet_connect`, `wallet_connect_failed` and `walletconnect_session` carry **`wc`**, whether the page runs inside a
wallet's in-app browser (`varial_inapp`, `dcent_inapp`, `scopuly_inapp`, `other_inapp`, `none`, `unknown`). It is read
from the documented `window.stellar` / `window.scopuly` sentinels only — never the wallet version or the User-Agent.

With the Wallets Kit's WalletConnect module you also get the **WalletConnect funnel**: `walletconnect_session`
(`proposed` → `approved` | `rejected`, network of the proposal) and `walletconnect_request` (`sign_xdr`,
`sign_submit_xdr`, `sign_message`, `sign_auth_entry`; `approved` | `rejected`). Nothing to configure: it comes with
`attachWalletsKit` / `wrapWalletsKitModules`.

### Privy (embedded Stellar wallets)

    import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
    import { useLogin, usePrivy } from "@privy-io/react-auth";
    import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";

    const { createWallet } = wrapPrivyStellar(useCreateWallet(), { networkPassphrase });
    const { signRawHash } = wrapPrivyStellar(useSignRawHash(), { networkPassphrase });
    const { logout } = wrapPrivyStellar(usePrivy());
    const { login } = useLogin(privyLoginCallbacks({ onComplete: yourOnComplete }));

Only calls with `chainType: "stellar"` are counted (`wallet_connect`/`wallet_connect_failed`, `sign_*` with
`sk: tx`, `wallet_disconnect`, `wt: privy`). The user object, e-mail, wallet id, address, hash and signature are
never read.

### Browser RPC / Horizon telemetry (aggregate only)

    import { attachRpcTelemetry, attachHorizonTelemetry } from "@usagemap/tracker/stellar-rpc";
    attachRpcTelemetry(server, { network: "testnet" });     // rpc.Server, js-stellar-sdk 14.3.1–17.x
    attachRpcTelemetry(rpc);                                // js-stellar-sdk 13.x–14.3.0: the rpc namespace

The tracker keeps per-page counts by RPC method or Horizon route, outcome class and latency bucket and sends them
as one aggregate when the page is hidden. They are stored as per-site daily totals only: no visitor, session, page,
time of call, URL (provider API keys stay in the browser) or address. Shown in the portal next to your backend's
Stellar RPC panel once your UsageMap host enables it.
