# `@usagemap/tracker` — the pinned browser tracker

A small, dependency-free browser script that records page views and custom events for the UsageMap web analytics
platform and sends them to the platform's ingest gateway (protocol `v1`, `docs/contracts/wire-formats.md` §a, §b).
Decisions: ADR-0004 (tracker), ADR-0008 (anti-inflation), ADR-0029 (Wallets Kit); register C-13, C-32, C-33, C-35,
C-37, C-45, C-52, C-55, C-65, C-75, C-89, C-93, C-135, C-136, C-137. Current version **1.2.0** (adds
`wallet_connect_failed`, the wallet context `wc`, the WalletConnect funnel, the Privy adapter and the browser RPC
aggregate `/stellar-rpc`); **1.1.0** (Stellar event schema v1, the wallet adapters, the debug module) and **1.0.0** stay
served byte-identical (`releases/1.1.0/`, `releases/1.0.0/`). The script-tag examples pin 1.2.0 (it is in
`infra/compose/tracker-releases.json`); a host that has not deployed this release yet serves only 1.1.0 and 1.0.0.

> `example-analytics.org` / `example-analytics.net` in examples are placeholder domains. Production host names must
> also pass the ad-blocker filter-list check (web.adblock-safe-script-name).

## Two profiles, one version, immutable files

| Profile | What it sends besides the page path | Use it when |
|---|---|---|
| `standard` | referrer **host** (cross-site, first page view only), screen-width class (`s`/`m`/`l`/`x`), primary language subtag (`en`), Wallets Kit presence (`wk`), client signal booleans (`webdriver`, visibility, user activation) | the French/Spanish/Italian audience-measurement criteria apply |
| `strict` | nothing — no referrer, no screen, no language, no client signals, no Wallets Kit probe | Germany/Belgium-style readings; see `docs/privacy/jurisdictions.md` |

Both profiles fetch a challenge and solve the proof-of-work before the first event, so `strict` traffic can still be
`verified` (C-33). Each released version is served at an immutable URL `/lib/<semver>/<profile>.js`; there is no
`latest` alias. Upgrading means changing the version **and** the integrity hash in your snippet.

## Embedding

### Static HTML (script tag with SRI)

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

`strict` profile:

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/strict.js"
  integrity="sha384-7Me6KspzAO7mUrsBqZriNmfNQJjj3yY1rYsACRveyWKFan6CBJtl763gwtKaEETu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

The hashes above are those of the current tree built with the placeholder hosts. The authoritative values for a
release are in `dist/<semver>/manifest.json` (and in the snippet the portal generates). `integrity` and
`crossorigin="anonymous"` are both required: without `crossorigin` the browser cannot check the hash. If the hash
does not match, the browser refuses to run the file — analytics stops, your page keeps working.

### Consent-gated mode (C-55)

Where the visitor's opt-in is required, add `data-consent="required"`. The tracker then sends nothing — not even the
challenge request — until your consent tool calls `grantConsent()`, and stops on `revokeConsent()`:

```html
<script>
  // Calls made before the tracker has loaded are queued and replayed in order.
  window.scf = window.scf || [];
</script>
<script src="…/lib/1.2.0/standard.js" integrity="sha384-…" crossorigin="anonymous"
        data-site="YOUR_22_CHAR_SITE_KEY" data-consent="required" defer></script>
<script>
  function onConsentGiven() {
    Array.isArray(window.scf) ? window.scf.push(["grantConsent"]) : window.scf.grantConsent();
  }
  function onConsentWithdrawn() {
    Array.isArray(window.scf) ? window.scf.push(["revokeConsent"]) : window.scf.revokeConsent();
  }
</script>
```

On `grantConsent()` the current page view is counted. Consent state is held in memory only; your consent tool keeps
its own record and must call `grantConsent()` again on each page load.

### npm (bundled into your app — the strongest delivery mode)

```sh
pnpm add --save-exact @usagemap/tracker
```

```ts
import { init } from "@usagemap/tracker";          // standard profile
// import { init } from "@usagemap/tracker/strict"; // strict profile

const scf = init({ site: "YOUR_22_CHAR_SITE_KEY" });     // { consent: "required" } for consent-gated mode
scf?.track("signup", { plan: "free" });
```

`init()` returns `undefined` during server-side rendering, so it is safe to call from shared code; call it once on
the client (e.g. in a root layout effect). Calling it again — React StrictMode, hot reload, or a script tag on the
same page — returns the running instance, so nothing is counted twice. Wallet adapters and the debug module are
separate entries (`/wallets-kit`, `/wallets`, `/passkey`, `/debug`), see "Stellar wallet events" and "Debug mode"
below.

### Content Security Policy

- Script tag: `script-src https://ingest-a.example-analytics.org` (or a nonce on the tag) and
  `connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.
- npm / self-hosted: only the `connect-src` entry.
- No `worker-src`, `blob:` or `'unsafe-eval'` is needed, and the tracker uses no DOM-XSS sinks, so it runs under
  `require-trusted-types-for 'script'` (covered by the browser smoke test).

## API

| Call | Effect |
|---|---|
| `track(name, props?)` | Custom event. `name`: 1–50 chars `[A-Za-z0-9][A-Za-z0-9_.:-]*`. `props`: ≤ 10 keys `[a-z][a-z0-9_]{0,31}`, values string ≤ 100 chars, finite number with \|n\| ≤ 10¹⁵, or boolean. Returns `false` (and sends nothing) if anything is out of shape, if a name or value looks like an e-mail address (also `%40`), a JWT, any run of ≥ 32 base64/hex characters — which covers every Stellar StrKey (G…, C…, M…, S…) and hashes —, an IPv4 or IPv6 literal (also a time like `10:30:00`, which has the same shape), a phone number (`+`, a digit and six more digits or separators) or a federation address (`name*domain.tld`) — or if sending is blocked. The gateway drops the same shapes (`drop/prop_redacted`). |
| `optOut()` | Stores `scf_optout=1` in `localStorage` (the only storage the tracker ever writes) and stops sending. |
| `optIn()` | Removes the flag. |
| `grantConsent()` / `revokeConsent()` | Consent-gated mode, see above. |
| `destroy()` | Removes listeners and restores `history.pushState`/`replaceState`. |
| `stellar(name, fields?)` | Stellar event schema v1 (below). Called by the adapters, which map everything to the closed lists; the core re-checks the JSON shape (a lower-case name, only the nine schema keys, string values of ≤ 16 `[a-z0-9_]` characters), so no StrKey, hash, amount or free text can pass. Returns `false` if refused. |

Classic-script builds expose the same object as `window.scf`. Apart from the page view, nothing fires automatically
(C-75).

## Stellar wallet events — event schema v1 (`scf-stellar-events/1`)

A versioned, **address-free** vocabulary, the same for every project so projects can be compared
(`docs/contracts/wire-formats.md` §a.3.1; C-136, C-137). Each event is a `wl` event with `sv: 1`; **every property
value is a closed enum**. Never sent: addresses (G/C/M/S…), transaction hashes, XDR, amounts, memos, signatures,
network passphrases, error messages or any free text.

| Event `n` | Fields (wire key → rollup key) | Sent when | Counted only (C-137) |
|---|---|---|---|
| `wallet_modal_opened` | — | wallet picker shown | no (forwarded) |
| `wallet_modal_closed` | `out` → `outcome`; `wt` → `wallet` when `connected` | picker closed | no |
| `wallet_selected` | `wt` | the user picked a wallet | no |
| `wallet_connect` | `wt`, `net`, `ck` → `connect_kind` (`new` · `restored`), `wc` → `wallet_context` | an address became available; `restored` = a session restored without a new authorisation, never counted as a new connection | no |
| `wallet_connect_failed` (1.2.0) | `wt`, `net`, `fr` → `failure_reason`, `wc` | an explicit connect gave the app no usable connection | no |
| `walletconnect_session` (1.2.0) | `ws` → `wc_state` (`proposed` · `approved` · `rejected`), `net`, `wc` | the kit's WalletConnect module proposed a session, and how it ended | no |
| `walletconnect_request` (1.2.0) | `wm` → `wc_method`, `net`, `ws` (`approved` · `rejected`) | a WalletConnect sign request settled | **yes** |
| `wallet_disconnect` | `wt`; `net` optional | the user disconnected | no |
| `sign_requested` | `wt`, `net`, `sk` → `sign_kind` | the app asked the wallet to sign | **yes** |
| `sign_approved` | `wt`, `net`, `sk`, `dur` → `duration` | the wallet returned a signature | **yes** |
| `sign_rejected` | `wt`, `net`, `sk`, `dur`, `ec` → `error_class` | the wallet returned an error, the call threw, or the adapter's timeout passed | **yes** |
| `tx_submitted` | `rc` → `result_class`, `net`; `wt` optional | the app's submission settled (Horizon, RPC send + poll, sign-and-submit) | **yes** |
| `smart_wallet_created` | `net`; `wt` optional (`passkey`) | a smart wallet (contract account) was deployed for the user | **yes** |
| `passkey_used` | `po` → `passkey_op`, `net` | a WebAuthn ceremony of a passkey wallet completed | **yes** |

"Counted only": the gateway adds the event to the per-day property rollup but never forwards it to Umami or the
spool, because its time could be matched to a public ledger transaction (C-137). The client sends every event the
same way.

Closed lists:

| Key | Values |
|---|---|
| `wt` wallet type | `freighter` `albedo` `xbull` `lobstr` `hana` `hot` `rabet` `walletconnect` `ledger` `trezor` `fordefi` `klever` `onekey` `bitget` `cactuslink` `dcent` `scopuly` `metamask` `ghostsig` `passkey` `injected_other` `unknown`. Wallets Kit ids are aliased (case-insensitive): `varial` (Freighter's id from kit 2.8.0) → `freighter`, `wallet_connect` → `walletconnect`, `hot-wallet`/`hot_wallet` → `hot`, `BitgetWallet` → `bitget`, `LEDGER` → `ledger`, `TREZOR` → `trezor`; anything else → `unknown`. The alias map is versioned with the tracker (`src/stellar.ts`). |
| `net` network | `mainnet` `testnet` `futurenet` `local` `unknown` — mapped in memory from the passphrase (`Public Global Stellar Network ; September 2015`, `Test SDF Network ; September 2015`, `Test SDF Future Network ; October 2022`, `Standalone Network ; February 2017`) or a wallet's network name (`PUBLIC`, `TESTNET`, Albedo's `public`/`testnet`); the passphrase is never sent |
| `ck` connect kind | `new` `restored` |
| `sk` sign kind | `tx` `auth_entry` `message` `tx_submit` (`signTransaction` with `submit: true`, or sign-and-submit) |
| `ec` error class | from the SEP-43 `code` only (SEP-43 is still Draft): `-4` `user_rejected`, `-3` `invalid_request`, `-2` `external_service`, `-1` `internal`; no answer within the adapter's timeout (120 s) `timeout`; `unsupported`; anything else (no code, unknown code, a thrown non-SEP-43 error such as a cancelled passkey prompt) `unknown`. The message is never read. |
| `rc` result class | RPC `sendTransaction`: `ERROR` → `error`, `TRY_AGAIN_LATER` → `try_again_later`, `PENDING`/`DUPLICATE` → followed through the app's own `getTransaction`/`pollTransaction` (`SUCCESS` → `success`, `FAILED` → `failed`), `pending` if not finished within 30 s. Horizon: `200` → `success`, `400` with `tx_failed`/`op_*` → `failed`, `504` → `pending`, else `error`. Kit `signAndSubmitTransaction`: its `status` (`success`/`pending`). |
| `dur` duration | `lt5s` `5_30s` `gt30s` |
| `out` modal outcome | `connected` `dismissed` (kit code `-1`, "user closed the modal") `error` |
| `po` passkey operation | `register` `authenticate` `sign` |
| `fr` connect-failure reason (1.2.0) | explicit connects only (a silent restore that finds nothing sends nothing): adapter timeout → `timeout`; SEP-43 `-4`, WalletConnect `5000`, Privy `exited_auth_flow`, WebAuthn `NotAllowedError` → `user_rejected`; wallet reported itself unavailable (`isConnected`/`isAvailable` false) or WebAuthn `NotSupportedError` → `wallet_not_installed`; answer without error and without address → `wallet_locked`; wallet's own network ≠ your `networkPassphrase` → `network_mismatch` (instead of `wallet_connect`); else `error_other` |
| `wc` wallet context (1.2.0) | `none` `varial_inapp` `dcent_inapp` `scopuly_inapp` `other_inapp` `unknown` — read from `window.stellar.provider`/`.platform` and `window.scopuly.platform` only (the sentinels Varial/Freighter Mobile, D'CENT and Scopuly inject); never a version or the User-Agent |
| `ws` / `wm` WalletConnect (1.2.0) | `proposed` `approved` `rejected` / `sign_xdr` `sign_submit_xdr` `sign_message` `sign_auth_entry` (`stellar_signXDR` …) |
| `wt` addition (1.2.0) | `privy` (Privy embedded Stellar wallets) |

Adding a value is a minor change made in the gateway, the counter-record schema and the database check **first**;
renaming or removing one creates `sv: 2` (§a.3.1). Custom events (`track()`) are unchanged: an `ev` event that
happens to use a v1 name is still a custom event.

### Adapters (Tier 1 — one line in your app; either profile)

None of these packages is installed or imported by the tracker: you pass in the object you already use. The adapters
find the running tracker (`init()` or the script tag) themselves and send nothing while tracking is blocked (GPC,
DNT, opt-out, no consent). Wrapped calls are delegated synchronously with the same arguments (wallet pop-ups still
open inside the click) and return exactly what the wallet returns.

```ts
// Stellar Wallets Kit v2 (static class) — or attachWalletsKitV1(kitInstance, { networkPassphrase }) for ≤ 1.9.5
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";
attachWalletsKit(StellarWalletsKit);          // any time: also counts references copied earlier (Scaffold Stellar)
// optional, for apps that also call wallet modules outside the kit:
// StellarWalletsKit.init({ modules: wrapWalletsKitModules(defaultModules()) });

// Direct wallet APIs: use the returned wrapped object instead of the original (the original is never modified)
import * as freighterApi from "@stellar/freighter-api";
import { attachRpcServer, wrapFreighter, wrapInjected } from "@usagemap/tracker/wallets";
const freighter = wrapFreighter(freighterApi);
const dcent = wrapInjected(window.dcentStellarProvider);   // wallet type detected: dcent
attachRpcServer(rpcServer);                   // tx_submitted from your own sendTransaction + poll

// Passkey smart wallets
import { attachPasskeyKit, attachSmartAccountKit } from "@usagemap/tracker/passkey";
attachPasskeyKit(passkeyKit);                 // or attachSmartAccountKit(smartAccountKit)
```

| Entry | Function | What is wrapped / observed |
|---|---|---|
| `/wallets-kit` | `attachWalletsKit(StellarWalletsKit)` | kit v2 events `WALLET_SELECTED` (id), `STATE_UPDATE` (address present as a boolean; the callback the kit fires on subscription is a restored session), `DISCONNECT`; `authModal` wrapped; sign calls observed on the **selected wallet module** through the kit's `selectedModule` getter (every v2 method delegates through it at call time), so method references the app copied before attaching (Scaffold Stellar's `wallet.ts`), modules given to a later `init()` and WalletConnect's `signAndSubmitTransaction` are all counted; `detach()` restores the class exactly. `net` is the network of the call. |
| `/wallets-kit` | `wrapWalletsKitModules(modules, {networkPassphrase?})` | optional: wraps the kit's wallet modules where the app constructs them (`init({modules})`), for apps that also call a module outside the kit; module `getAddress` (`new`), sign methods, `disconnect`. With `attachWalletsKit` too, every event is counted once. |
| `/wallets-kit` | `attachWalletsKitV1(kit, {networkPassphrase})` | v1 instance: `openModal` callbacks, `getAddress` (`new` after a pick in the modal, else `restored`), sign methods, `disconnect` |
| `/wallets` | `wrapFreighter(api)` | `requestAccess` (`new`), `getAddress` (`restored`), `signTransaction`/`signAuthEntry`/`signMessage`, `getNetwork(Details)`; `{error: {code}}` results are rejections |
| `/wallets` | `wrapAlbedo(albedo)` | `publicKey` (`new`), `tx` (`network`, `submit`), `signMessage` |
| `/wallets` | `wrapXBull(x)` | `window.xBullSDK` (`connect`, `getPublicKey`, `signXDR`) or `xBullWalletConnect` (`connect`, `sign`, `signMessage`) |
| `/wallets` | `wrapLobstr(api)` | `getPublicKey` (`new`), `signTransaction`, `signMessage` (no network argument: pass `networkPassphrase`) |
| `/wallets` | `wrapHana(window.hanaWallet.stellar)` | `getPublicKey`, `signTransaction`, `signAuthEntry`, `signMessage`, `signBlob` |
| `/wallets` | `wrapHot(HOT)` | `request("stellar:getAddress" \| "stellar:signTransaction" \| "stellar:signAuthEntry" \| "stellar:signMessage")`; other methods untouched |
| `/wallets` | `wrapInjected(provider, {wallet?})`, `detectInjectedWallet(provider)` | any injected SEP-43-style provider (D'CENT, Rabet, Klever, OneKey, Bitget, Cactus Link, Scopuly …). The type is found by **identity** with the wallet's documented global (e.g. `window.dcentStellarProvider`) or the `window.stellar` sentinel D'CENT and Freighter Mobile inject; otherwise `injected_other`. Only those named globals are read, only to name the provider you passed in; nothing is enumerated or recorded. |
| `/wallets` | `attachHorizonServer(server)`, `attachRpcServer(server)` | `submitTransaction`; `sendTransaction` + your `getTransaction`/`pollTransaction` (the hash is held in memory only to match your poll; the adapter makes no request of its own) |
| `/passkey` | `attachPasskeyKit(kit)`, `attachPasskeyServer(server)` | passkey-kit 0.20.0: events `walletCreated`, `walletConnected`, `walletDisconnected` (**event name only** — the payloads carry C-addresses and key ids and are never read); `createKey` → register, `connectWallet` → authenticate, `sign`/`signAuthEntry`/`signAdmin`; `PasskeyServer.send` → `tx_submitted` |
| `/passkey` | `attachSmartAccountKit(kit)` | smart-account-kit 0.10.0: events `credentialCreated`, `walletConnected` (`restored` during a silent `connectWallet()`), `walletDisconnected`; `createWallet` (`smart_wallet_created` when `autoSubmit` succeeded), `authenticatePasskey`, `sign*`, `signAndSubmit*` (also via `transfer`, `executeAndSubmit`) |

| `/privy` | `wrapPrivyStellar(hookResult, {networkPassphrase?})`, `privyLoginCallbacks(callbacks)` | `@privy-io/react-auth` ≥ 3.52 (Apache-2.0): `createWallet({chainType: "stellar"})` → `wallet_connect`/`wallet_connect_failed`; `signRawHash({chainType: "stellar"})` → `sign_*` (`sk: tx`); `logout` → `wallet_disconnect`; `useLogin` `onComplete` with a linked Stellar wallet → `wallet_connect` (`restored` when already authenticated), `onError` → `wallet_connect_failed`. Other chains pass through; the user, e-mail, wallet id, address, hash and signature are never read. |
| `/stellar-rpc` | `attachRpcTelemetry(server, {network?})`, `attachHorizonTelemetry(server, {network?})`, `flushRpcTelemetry()` | browser RPC/Horizon telemetry, **aggregate only** (§a.3.2): js-stellar-sdk's public `httpClient.interceptors` (14.3.1–17.x: the server; 13.x–14.3.0: the `rpc`/`Horizon` namespace). In-memory counts per RPC method / Horizon route template, network, outcome class (`ok` `rpc_error` `http_4xx` `http_429` `http_5xx` `timeout` `network_error`) and latency bucket (`lt100ms` `100_500ms` `500_2000ms` `gt2000ms`), sent as ONE `stellar_rpc` event when the page is hidden or the UTC day changes, stored only as per-site daily totals: no visitor, session, page, call time, URL (a provider API key in the path stays in the browser), params or address. |

Every entry also exports `stellarEvent(name, fields)` (the allow-list serialiser, for an event your own code knows
about, e.g. `smart_wallet_created` after you deployed the wallet yourself), `walletType()` and `networkOf()`.

**Upstream events that are declared but never emitted** (source read at passkey-kit 0.20.0 and smart-account-kit
0.10.0): `transactionSigned` and `transactionSubmitted` exist in both kits' event maps but neither kit ever emits
them — so signing and submission are captured by wrapping the kits' methods, not by listening. Also never emitted:
passkey-kit `signerAdded`/`signerUpdated`/`signerRemoved`, smart-account-kit `credentialDeleted` (none maps to a v1
event).

Limits, stated: wallets switch accounts or networks without telling the app (no event, Wallets Kit PR #113 is not
merged); `net` is the network the app asked for, `unknown` when no call carries one; `restored` vs `new` is decided
per method (an explicit access request is `new`, a silent read of an authorised session `restored`); the kit's side-
effect import (ADR-0029 option 6) is not shipped — a second copy of the kit would be a second, empty singleton; a
Wallets Kit module the app calls itself, outside the kit, is counted only when wrapped with `wrapWalletsKitModules`;
a hardware wallet's account picker (`getAddresses()`) is not wrapped (its connection is seen through `STATE_UPDATE`);
`authModal` called through a reference copied before attaching sends no modal events (the connection is still seen);
Tier 0 (zero-configuration DOM signals) is presence only (`wk`) in this version.

## Debug mode (developers only)

`@usagemap/tracker/debug` explains, in the console and in a small on-page panel, **why nothing was sent or
counted**:

```ts
import { debug } from "@usagemap/tracker/debug";
debug();   // before init(); returns off(). Script tag: an earlier <script type="module"> importing it.
```

| It reports | From |
|---|---|
| Global Privacy Control on (Brave's default), Do Not Track, the visitor's opt-out | the same checks as the core |
| consent-gated mode without `grantConsent()`; no tracker running (ad blocker, CSP `script-src`, SRI mismatch, bad `data-site`) | nothing was requested within 3 s |
| a Content Security Policy blocking the ingest hosts | `securitypolicyviolation` |
| page origin not a declared domain or dev origin (no CORS headers), ad blocker or network | a failed request, then a no-cors probe of `/healthz`: reachable → origin, unreachable → blocked |
| timeout; `400`, `404` (unknown site key), `410` (withdrawn version), `429`, `503`; a challenge without a valid v1 token | the answers |
| `X-Scf-Debug` when the gateway sends it (§a.8): on a dev origin outside the site's debug window only `class=dev; reasons=dev_origin` ("accepted, never counted; the would-be verdict is in the portal's first-event panel"); while the site's debug mode is on, the class and reason codes of every request, explained | the response header |

The core is unchanged by this (size budget): the debug module observes the core's requests by wrapping `window.fetch`
for the two ingest hosts only. It prints event kinds, names and paths — never the token, a query string, an identifier
or a header. Do not ship it to production.

### Dev and preview origins (§a.8)

The tracker behaves the same on `localhost`, `127.0.0.1` and preview hosts as in production — challenge, proof,
events — so the full path can be tested locally. The gateway decides: for an origin listed in the site's dev origins
it answers `202`, never counts the events and shows them in the portal's first-event panel; for an origin that is
neither declared nor a dev origin it sends no CORS headers, which the debug module reports. Tokens fetched from a dev
origin are valid on dev batches only.

## Configuration attributes (script tag)

| Attribute | Required | Meaning |
|---|---|---|
| `data-site` | yes | public site key, 22 alphanumeric characters |
| `data-consent="required"` | no | consent-gated mode |

There is no other configuration and none is ever fetched. The two ingest hosts, the version, the profile and the
proof-of-work ceiling are compiled into each file (ADR-0004).

## What it does, exactly

- **Page views** on load and on History API navigation (`pushState`, `replaceState`, `popstate`). A page view is
  sent only when `location.pathname` differs from the last one sent, so hydration in SSR frameworks, same-path
  `replaceState`, and query- or fragment-only changes do not count; back/forward to a different path does. A page
  restored from the browser's back/forward cache runs no script and is not counted again.
- **Path only.** Only `location.pathname` (≤ 500 chars) is sent — never the query string or fragment (C-65) and never
  the page title (C-89). Requests use `referrerPolicy: "origin"`, so the `Referer` header carries no path either.
- **Challenge and proof first** (C-35). On the first event of a page load the tracker posts `/v1/c`, then searches
  the PBKDF2-SHA-256 proof with WebCrypto (`crypto.subtle.deriveBits`, a few calls in flight; WebCrypto computes off
  the main thread, the main thread only compares integers). No Worker — so no `worker-src blob:` in tenant CSPs and
  still a single SRI-pinned file. Events wait for the proof. If the page is hidden first, pending events are sent at
  once with the token and **without** proof (the gateway marks them `suspect`). The token and proof are reused for
  later events and refreshed after 25 minutes or 300 events. A challenge asking for more than the compiled work
  ceiling (2²⁴ PBKDF2 iterations by default; the contract default is 2¹⁸ expected) is not solved.
- **Sending.** `fetch(…, {keepalive: true, credentials: "omit"})` with a `text/plain` JSON body (no CORS preflight),
  a 3-second timeout, and at most two retries alternating between the two ingest hosts, waiting
  `min(Retry-After, 30 s)` or 500 ms × 2ⁿ with jitter; the same event ids are resent — also when a request is
  abandoned after 3 s and retried on the other host — so the gateways and the engine proxy drop the copies (one id
  per action). A batch is at most 10 events and at most 8 KiB: events that do not fit wait for the next batch. No retry on `400`; `404`/`410` stop the tracker for the page. On `pagehide` (or the page becoming
  hidden) queued events and pending retries are sent at once with the same keepalive `fetch` — never with
  `navigator.sendBeacon`, because EasyPrivacy (on by default in uBlock Origin and Brave) blocks every third-party
  beacon (`*$ping,third-party`; found by the filter-list check).
- **Per-event id** — 16 random bytes (22 base64 characters, `+` and `/` written `_`: ≥ 127 bits), held in memory only,
  never a visitor identifier (C-37).
- **Wallets Kit presence** (`standard` only, C-93): a boolean on the page view, from DOM markers only (the kit's v1
  custom elements, the v2 `section.stellar-wallets-kit` node, or its `--swk-*` theme variable). The tracker never
  touches wallet objects, extension messages or the kit's storage.

## Privacy behaviour

- **Nothing is sent at all** — not even a challenge — when Global Privacy Control is on
  (`navigator.globalPrivacyControl`), Do Not Track is `1`, the visitor has opted out, or consent-gated mode is on and
  consent has not been granted.
- No cookies, no `sessionStorage`, no IndexedDB; `localStorage` only for the visitor's own opt-out flag.
- Reads in `strict`: the page path, plus — only to honour the visitor's choices and to send on page hide — the
  GPC/DNT flags, the opt-out flag and the page's visibility state. Nothing else.
- What the server stores and for how long: `docs/privacy/data-inventory.md`.

## Building, verifying, testing

```sh
eval "$(mise env -s bash)"                         # Node 24.19, pnpm 12.19
flock /tmp/scf-pnpm.lock pnpm install              # from the repository root
pnpm --filter @usagemap/tracker build         # dist/<semver>/{standard,strict}.js + manifest.json, dist/npm/
pnpm --filter @usagemap/tracker verify-reproducible   # two clean builds, byte-for-byte comparison
pnpm --filter @usagemap/tracker test          # vitest, both profiles (happy-dom)
pnpm --filter @usagemap/tracker exec playwright install chromium   # once per machine
pnpm --filter @usagemap/tracker test:e2e      # Playwright, Chromium: built files + fixture apps
pnpm --filter @usagemap/tracker filter-list-check   # ad-blocker lists (network)
pnpm --filter @usagemap/tracker typecheck && pnpm --filter @usagemap/tracker lint
```

`build` fails if a gzip size budget is exceeded (`strict` ≤ 2,500 B, `standard` ≤ 3,500 B, C-32; 1.1.0 as built
2,458 B and 2,826 B — 1.0.0 was 2,408 B and 2,778 B; the `stellar()` method adds 85 B net in `strict`; the wider value
guard and the 8 KiB batch split (+~90 B) were paid for by a smaller proof-of-work setup, one shared request
header object, and dropping redundant type and shape checks, leaving 42 B of headroom; 1.2.0 is 2,492 B and 2,862 B: the
core's shape check admits the new keys and the `stellar_rpc` cells) or if the static check finds `eval`, `Function`, dynamic `import()`, `document.cookie`,
`sessionStorage`, IndexedDB, `.title`, query string or fragment access, wallet globals, DOM-XSS sinks, workers,
`message` listeners, fingerprinting APIs, `sendBeacon`, any `localStorage` use other than the opt-out flag — and, in
`strict`, any client-signal, referrer, screen, language or Wallets Kit read (`scripts/check-output.ts`). The adapter
entries (`wallets-kit`, `wallets`, `passkey`) may name wallets but are checked by stricter rules: no network access
of their own, no web storage at all, no `postMessage` or `message` listener, no enumeration of `window`/`globalThis`.
The debug module is checked like the core; `privy` and `stellar-rpc` by the adapter rules. Adapter sizes (gzip,
1.2.0): `wallets-kit` ≈ 5.6 kB, `wallets` ≈ 5.4 kB, `passkey` ≈ 3.7 kB, `privy` ≈ 3.4 kB, `stellar-rpc` ≈ 3.1 kB,
`debug` ≈ 5.0 kB — loaded only by apps that import them (the npm entries are not minified, for review);
`test/build.test.ts` holds them to their own budgets (`wallets-kit` ≤ 6,144 B, `wallets` ≤ 6,144 B, `passkey` ≤
4,608 B, `privy` ≤ 4,608 B, `stellar-rpc` ≤ 4,096 B) and checks that none imports or bundles a wallet library (the
kit, WalletConnect, Freighter's API, Privy).

### Released versions are immutable

`releases/<semver>/` holds the exact bytes (classic files + manifest) of every released version, built from that
release's source. Each build verifies them against their manifest and copies them next to the current version into
`dist/` (only for the release configuration, not for builds with overridden hosts), and refuses to build a version
number that is already released. Release checklist:

1. **Do not release a tracker that sends `sv` (1.1.0 and later) until every gateway in service accepts it** (§a.7:
   gateways first — the schema is closed, so an older gateway answers `400` and the whole batch, page views
   included, is lost). Likewise for any new v1 enum value: gateway, counter-record schema and database check first.
2. Bump the version (never rebuild a released number), build, `verify-reproducible`, then archive
   `dist/<semver>/` into `releases/<semver>/`.
3. Update every SRI pin outside this package (quickstarts, onboarding, the portal's snippet fixtures).

### Browser tests (`e2e/`)

Everything runs in Chromium against route-intercepted origins (no ports) and a protocol-v1 **mock gateway**
(`e2e/lib/gateway.ts`) that serves the released files, issues real challenges, verifies each proof, validates every
request body against the §a JSON Schemas and fails the test on any violation, any non-`fetch` request, any query
string, fragment, title, e-mail or StrKey in a body, a cookie header, or a `Referer` carrying a path.

| Spec | What it proves |
|---|---|
| `smoke.spec.ts` | challenge → proof → event; SRI mismatch runs nothing; strict CSP with Trusted Types; hide before proof |
| `fixtures.spec.ts` | page-view counting on the fixture apps in `e2e/apps/` (built by the Playwright global setup with esbuild): **static HTML** (script tag + SRI, full page loads, fragment links), **React Router** SPA (npm `init()` in a `<StrictMode>` effect, i.e. called twice), **Vue Router** SPA (script tag + command queue; the router's start-up `replaceState`), and a **server-rendered, hydrated** React Router app (`react-dom/server` + `hydrateRoot`; script tag and `init()` on one page, and npm only) — no double count on hydration, back/forward, `replace` navigation, query-only and fragment-only changes |
| `wallets.spec.ts` | a wallet dApp fixture (`e2e/apps/wallet-dapp/`, built for each profile) with **mocks** of the Wallets Kit, Freighter and an RPC server (`test/wallet-mocks.ts`, never a real wallet): the Wallets Kit flow (modal → Freighter → sign → user rejects → disconnect, signing through method references copied off the kit before the adapter attached, as Scaffold Stellar does) and the Freighter-wrapper flow (requestAccess → sign → RPC submit polled to success) produce exactly the schema-v1 events, validated against `$defs/stellar`, with no StrKey, hash, XDR or wallet text in any body; the debug panel explains a CSP violation and a refused request |
| `privacy.spec.ts` | consent-gated mode sends nothing (not even the challenge) before `grantConsent()` and stops on `revokeConsent()`; GPC, DNT and `optOut()` send nothing; `strict` reads only the visitor's choices and the visibility state (property reads instrumented, attributed by stack trace; `standard` as positive control) |

The fixture frameworks (React, React Router, Vue, Vue Router) are dev dependencies of this package used only by
the fixture bundles in `e2e/.build/`; `dependencies` stays empty and the build test checks that no framework code
reaches `dist/`. The SSR fixture is a plain React Router data-router server render rather than Next.js or Astro:
both of those pull in dependencies whose licences are not on the allow-list (`caniuse-lite`, CC-BY-4.0; `sharp`'s
LGPL libvips binaries), and the licence gate scans dev dependencies too.

### Filter-list check (web.adblock-safe-script-name, web.adblock-safe-endpoints)

`scripts/filter-list-check.ts` downloads the lists in `scripts/filter-lists.json` — EasyList, EasyPrivacy, uBlock
filters (+ Privacy, Badware risks, Quick fixes), Peter Lowe's list, AdGuard Base and Tracking Protection, Brave's
specific and first-party lists — and evaluates every request the tracker makes from a generic tenant page (each
profile's script, `POST /v1/c`, `POST /v1/e`, the manifest, on both hosts) with a small self-contained matcher of
Adblock network-filter syntax (`scripts/filter-list/matcher.ts`, unit-tested in `test/filter-matcher.test.ts`).
Each list is evaluated on its own; a match prints the rule with its file and line. `--mode=pinned` uses the lists
at pinned commits with SHA-256 checks, `--mode=live` the current lists (size and time limits); the default runs
both. `--hosts=https://a.x,https://b.y` checks candidate production host names; `--repin` updates the pins.
Exit code 1 if anything is blocked. The lists are data read at check time and are never committed or shipped.

`manifest.json` lists per file: size, gzip size, SHA-256, SHA-384 and the `integrity` string, plus the esbuild and
Node versions, the compiled hosts and proof-of-work parameters, and — when the environment provides them — the git
commit (`SOURCE_COMMIT`) and build-container digest (`BUILD_CONTAINER_DIGEST`).

Build-time parameters (environment): `TRACKER_HOSTS` (two comma-separated origins; https, or http on localhost for
local end-to-end runs), `TRACKER_POW_MAX_WORK`, `TRACKER_POW_PARALLEL`. Any override changes the bytes and therefore
the SRI hash — a test build can never pass for a release.
