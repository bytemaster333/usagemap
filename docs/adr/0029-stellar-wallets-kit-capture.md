# ADR-0029: Stellar Wallets Kit capture

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** feature.wallets-kit-autocapture, feature.custom-events, privacy.minimal-erasure-scope, privacy.gdpr-no-consent, trust.verified-vs-raw, tracker.no-remote-updates

## Context
UsageMap offers automatic capture of events from the Stellar Wallets Kit without tenant-side configuration
(feature.wallets-kit-autocapture). Wallet events are a strong usage signal (a fake visitor does
not connect a wallet), but the data around them is sensitive: under EDPB Guidelines 02/2025 on blockchain (v2.0,
adopted 7 Jul 2026) a public key "can be used to identify the individuals" and is personal data (para 26; fn 12
lists "transaction identifiers, wallet addresses").

What was verified in the kit's source (Creit-Tech/Stellar-Wallets-Kit, tag **v2.8.0** = `9db6b36`, 2026-10-28; v1
at tag `v1.9.5`):
- **Three event types only.** `StellarWalletsKit.on(KitEventType, cb)` (`src/sdk/kit.ts:185-227`) supports
  `STATE_UPDATED` (string value `"STATE_UPDATE"`, payload `{address, networkPassphrase}`), `WALLET_SELECTED`
  (`{id}`) and `DISCONNECT` (`{}`) (`src/types/mod.ts:36-60`). There are **no sign, modal-open or modal-close
  events**; sign methods emit nothing.
- **`STATE_UPDATED` fires on every subscription and carries the address.** It is a Preact `effect` that runs
  synchronously when created; with a session restored from `localStorage['@StellarWalletsKit/activeAddress']` the
  first callback contains the restored G-address (`kit.ts:183`: "triggered at launch"). A naive listener records a
  false "connect" on every page load and receives the user's address.
- **No official global build.** npm ships ESM + CJS (built with `@deno/dnt`), no UMD/IIFE, no `window` global, in v1
  or v2. The only UMD is a community bundle exposing `window.MyWalletKit`. Real apps (Scaffold Stellar template,
  OracleDesk) bundle the kit as ESM, sometimes via dynamic `import()`. A third-party script cannot reach the kit.
- **PR #113 (module `onChange` forwarding) is open and unmerged**; v2.8.0 never calls `module.onChange`, so account
  switches inside a wallet produce no kit event.
- v1 dispatches bubbling, composed DOM `CustomEvent`s (`wallet-selected`, `modal-closed`, `button-clicked`,
  `disconnect-wallet`) whose `detail` has no address. v2 renders `section.stellar-wallets-kit` under `<body>`.
- npm week 2026-11-05..11: 27,218 downloads, v2 69 %, v1 30 % — v1 must be supported.
- The wallet id changed: `freighter` (≤ 2.7.1) became `varial` in 2.8.0 (`varial.module.ts:25,197`).
- **Umami's bounce definition:** a visit that contains any
  custom event is not a bounce. An event fired automatically on page load would therefore turn every single-page
  visit on a kit-embedding dApp into a non-bounce, and its bounce rate would no longer be comparable with that of an
  ordinary site — which undermines cross-project comparison.

## Options considered
1. **Global detection** (`window.StellarWalletsKit`). Pros: zero config. Cons: no official global exists; scanning
   `window` for kit-like objects is fingerprinting-like enumeration. Only a cheap direct check is kept.
2. **DOM signals: v1 CustomEvents, v2 modal markup.** Pros: zero config, no address in payloads. Cons: v2 markup is
   undocumented; gives presence and modal open/close only, not connect or sign.
3. **Read the kit's localStorage keys.** Pros: reliable session state. Cons: reading terminal storage is squarely
   ePrivacy Art. 5(3); `activeAddress` is the user's public key. Rejected.
4. **Explicit adapter `attachWalletsKit(kit)` or a side-effect import.** Pros: full taxonomy via the public API,
   including wrapped sign calls; tenant opts in with one line. Cons: not zero config; the side-effect import works only
   if the bundler resolves to the same kit instance (npm `@creit.tech` ≠ JSR `@creit-tech`).
5. **Passive observation of wallet-extension `postMessage` traffic** (Freighter/Varial `FREIGHTER_EXTERNAL_MSG_*`,
   LOBSTR `LOBSTR_EXTERNAL_MSG_*`). Pros: sees sign requests without tenant code. Cons: the listener is handed
   transaction XDR, signatures and public keys in `event.data` even if it discards them; private protocols.
6. **Monkey-patching injected wallet providers** (`window.rabet`, `window.xBullSDK`, …). Rejected: patching a
   wallet's signing object is what malicious scripts do, and probing these globals fingerprints installed extensions.

## Decision
Three tiers, documented with their limits.
- **Tier 0 — on by default, zero configuration, in the `standard` profile only** (C-13): address-free DOM signals
  only — v1 CustomEvents (`wallet-selected` → `detail.id` only, `modal-closed`, `button-clicked`,
  `disconnect-wallet`) and v2 modal open/close (node `section.stellar-wallets-kit` added/removed). **Tier 0 sends
  events only for user actions** — modal opened or closed, wallet selected, and the v1 disconnect click — **and never
  an automatic event on page load** (C-75). **`wallet_kit_detected` is not an event** (it was in C-45; C-75 removes
  it): kit presence and `kit_major` are reported through the per-site counter path of C-39 (installation-check page
  and trust-score inputs), not to Umami, so they cannot rescue a visit from being a bounce. The exact wire field is
  in `docs/contracts/`. No connect or sign events for v2 at this tier; dashboards say so. The `strict` profile contains no Tier 0 code path: under `strict`, wallet events
  are sent only if the tenant explicitly attaches the adapter (Tier 1).
- **Tier 1 — one line, either profile:** `attachWalletsKit(StellarWalletsKit)` (v2), the v1 instance equivalent, or a side-effect
  import (separate entries for npm `@creit.tech` and JSR `@creit-tech`; the kit is an optional peer dependency, never
  installed by us). The adapter subscribes to the three kit events and wraps the kit's own sign methods
  transparently (same arguments, same result or rejection, no `await` before delegating, wrapped once, detach
  restores). It **ignores the first `STATE_UPDATED`/`WALLET_SELECTED` callback after each `on()`** and emits
  `wallet_session_restored` for it, so a restored session is never counted as a new connection.
- **Tier 2 — passive observation of wallet-extension messages: not shipped.** A listener on `window` `message` would
  receive XDR, signatures and addresses from every Freighter/Varial or LOBSTR exchange on the page. Even if discarded
  immediately, the tracker would be code that is handed users' transaction data on every tenant site; that is
  incompatible with the "never addresses" rule and with the supply-chain posture of a script embedded across the
  ecosystem (ADR-0004, ADR-0023). It cannot be enabled by configuration.

| Event | Allowed fields | Source |
|---|---|---|
| `wallet_modal_opened` | — | Tier 0 v2 node added / v1 `button-clicked`; Tier 1 wrapped `authModal` |
| `wallet_modal_closed` | `outcome`, `duration_bucket` | Tier 0 v2 node removed / v1 `modal-closed`; Tier 1 `authModal` settles |
| `wallet_selected` | `wallet_id` | v1 `wallet-selected`; Tier 1 `WALLET_SELECTED` (not the initial callback) |
| `wallet_connected` | `wallet_id`, `network` | Tier 1: `STATE_UPDATED` address undefined → defined, excluding the first callback |
| `wallet_session_restored` | `wallet_id`, `network` | Tier 1: first `STATE_UPDATED` callback that carries an address |
| `wallet_disconnected` | `wallet_id` | Tier 1 `DISCONNECT` (de-duplicated against the accompanying state events); v1 `disconnect-wallet` |
| `sign_requested` | `wallet_id`, `kind`, `network` | Tier 1 wrapped `signTransaction` / `signAuthEntry` / `signMessage` / `signAndSubmitTransaction` |
| `sign_completed` | `wallet_id`, `kind`, `network`, `duration_bucket` | Tier 1: the wrapped promise resolves |
| `sign_failed` | `wallet_id`, `kind`, `network`, `duration_bucket`, `error_class` | Tier 1: the wrapped promise rejects |

The placement of fields on events above follows the research taxonomy; the binding rule (C-45) is the field
vocabulary below. No event in this table fires without a user action or a wallet state change the user caused
(C-75). The metric definitions state that **a visit with any custom or wallet event is not a bounce** (C-75, C-73);
Tier 1 events, which follow user actions, therefore affect bounce rate the same way any custom event does.

**Allow-list serialiser** (C-45). The only values that leave the browser are, all from closed sets and never free
text: event type (closed set above); `wallet_id` (closed set of kit `productId` values; `freighter` and `varial`
aliased to one id; anything else becomes `other`); sign `kind` ∈ {`tx`, `auth_entry`, `message`, `tx_submit`};
`network` ∈ {`public`, `testnet`, `futurenet`, `other`} (mapped in memory from the passphrase, which is never sent);
modal `outcome`; `duration_bucket`; `error_class` ∈ {`rejected`, `timeout`, `unsupported`, `other`}; and, on the
counter path only, `kit_major`. The closed sets for `outcome`, `duration_bucket` and `kit_major` are specified in
`docs/contracts/`.
**Never addresses (G/M/C), XDR, signatures, signed messages, memos, network passphrases, error text,
wallet-availability lists or WalletConnect topics.** The adapter
reads payload fields by name (`payload.id`; the presence of `payload.address` as a boolean for the transition check)
and keeps the address in memory no longer than one comparison. A test on the **outgoing request** fails the build if
any beacon matches `/[GCM][A-Z2-7]{55}/` or a base64 XDR prefix, or carries a field outside the allow-list.
Events travel as ordinary custom events through the gateway (ADR-0005), inheriting the page's verdict; the gateway
discards fields the site's profile does not allow (C-37) and passes event names and property values through the same
server-side guard as page paths (C-52).

## Consequences
Positive: wallet activity becomes a cross-signal for the trust score (ADR-0028) without collecting any identifier;
v1 apps on the `standard` profile get useful capture with zero configuration; bounce rate stays comparable between
dApps that embed the kit and ordinary sites, because nothing fires on page load (C-75).

Negative: "without tenant-side configuration" is met only partially — zero-config capture exists only in the
`standard` profile; for v2 apps (≈ 69 % of installs) it gives modal open/close (and presence on the counter path
only), and connect/sign funnels need Tier 1; a visitor who only opens the wallet modal is no longer a bounce, which is
Umami's definition and is stated in the metric glossary; account switches inside a wallet are
invisible until PR #113 or an equivalent ships; Tier 0's v2 signal depends on undocumented markup that may change.
The adapter must be wrapped before the app captures method references (Scaffold's `wallet.ts:34` copies
`StellarWalletsKit.signTransaction` at module load); events still work regardless of order.

Must do: a test matrix against kit
 1.9.5, 2.5.0, 2.7.1 and 2.8.0 (ADR-0026); version the wallet-id alias map with the
tracker; offer Creit Tech an upstream, payload-free `MODAL_*`/`SIGN_*` event hook.

Revisit if: the kit ships documented address-free modal/sign events or a global event target (Tier 0 could then be
complete); PR #113 merges (adds `wallet_account_changed`, compared in memory only); a wallet protocol changes.

Unproven: nothing here has run in a browser yet; the v2 DOM markers are stable 2.0 → 2.8 by source reading only;
the Freighter → Varial rename is seen in source but its public announcement is unconfirmed.

## Open points
None outstanding. (Tier 0 profile scope is settled by C-13; the field vocabulary by C-45; the removal of the presence
event and the user-action-only rule by C-75.)
