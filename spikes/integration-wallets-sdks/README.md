# Spike: wallets and client SDKs (integration analysis 2026-11-19)

Throwaway. Not part of the pnpm workspace. The conclusions below are self-contained.

## What it proved

1. **`instrumentStellarRpc(server)` works on js-stellar-sdk 17.4.0 through the public `rpc.Server#httpClient.interceptors`**
   and needs no SDK patching. A Symbol stamped on the request config by the request interceptor survives to
   `response.config` and `error.config` in the 17.x fetch client, so per-call durations are exact.
   - Emits `rpc.client.call.duration` (s, Stable semconv; `rpc.system.name=jsonrpc`, `rpc.method` from the closed
     list of 13 Stellar RPC methods else `_OTHER`, `rpc.status_code`/`error.type` = JSON-RPC code, `http_<status>`,
     `timeout` or `network`) plus `stellar.network`.
   - Plus Stellar counters: `stellar.tx.submissions` (`PENDING|DUPLICATE|TRY_AGAIN_LATER|ERROR` + result class),
     `stellar.tx.polls` (`SUCCESS|FAILED|NOT_FOUND` + result class), `stellar.tx.simulations`
     (`success|error|restore_required` + error class from the host error text, which is then discarded).
   - One instrumented server also covers `contract.AssembledTransaction` / generated `contract.Client`s via the
     `server` option (test shows their `getLedgerEntries` call recorded).
   - **js-stellar-sdk 17 replaced the XDR accessor API** (`xdr.X.fromXDR(...).result().switch().name` is gone; new
     generated classes with `.type` and fields). The spike therefore decodes `TransactionResult` from its fixed wire
     layout (int64 fee | int32 code | first op result), which is SDK-version-independent and adds no bundle weight.
     Covers fee-bump inner results and the new `txFROZEN_KEY_ACCESSED` (-18).
   - Exported over real OTLP/HTTP to a local sink: metric names present, no address, hash or RPC URL in the payload.
   - **Read-only public testnet run** (`npm run testnet`, results in `results/`): getNetwork, getHealth ×3,
     getLatestLedger, getFeeStats, getVersionInfo, getTransaction (random hash → `NOT_FOUND`), simulateTransaction
     (native SAC `decimals()` from an unfunded key → `success`), Horizon fee_stats / ledgers / accounts (404). All
     recorded with templates; nothing submitted. RPC calls were ~0.14–0.26 s from this host (first call 0.56 s).
2. **`instrumentHorizon(server)`** (same interceptor API on `Horizon.Server`): `http.client.request.duration` with a
   closed Horizon `url.template` (`/accounts/{id}/payments`, `/transactions/{id}`, … else `_OTHER`), status code, and
   `stellar.tx.submissions{via=horizon}` with the Horizon `result_codes.transaction` mapped to the same classes.
3. **Stellar Wallets Kit 2.8.0 analytics as a *module wrapper*** (`withUsageMap(defaultModules(), {emit})` passed to
   `StellarWalletsKit.init`), run against the **real kit core** (`/sdk`, Preact signals) in Node with fake modules:
   - Captures `wallet_connect`, `sign_requested/approved/rejected` (SEP-43 code → `user_rejected` etc.,
     duration bucket), `tx_submitted` (`signAndSubmitTransaction` status), `wallet_disconnect`, all with tracker
     schema v1 values, address-free (beacon regex test), and the app still gets the wallet's original result/error.
   - The kit's static methods delegate to `selectedModule.<fn>` at call time (`src/sdk/kit.ts:123-170` @ v2.8.0), and
     the modal's connect path calls `activeModule.getAddress()` (`components/pages/auth-options.page.ts:73`), so the
     wrapper also sees **calls through a method reference copied before instrumentation** (Scaffold Stellar's
     `export const signTransaction = StellarWalletsKit.signTransaction`).
   - Control test: the shipped tracker 1.1.0 `attachWalletsKit` (patches the static methods) **misses** such a
     pre-copied reference (0 sign events) while catching calls through the static method. This is the gap the
     module wrapper closes; the two compose (kit events for restored sessions, wrapper for sign/connect).
   - Kit 2.8.0 never calls a module's `onChange` (only the Scopuly module implements it); hardware wallets connect via
     `getAddresses()` (not wrapped; the kit's `STATE_UPDATE` covers them).

## Sizes (esbuild, minified, gzip -9)

`instrumentStellarRpc` + classifier 2.2 KB (3.8 KB including `@opentelemetry/api`), Horizon 1.3 KB, Wallets Kit
module wrapper 1.2 KB.

## Run

```sh
eval "$(mise env -s bash)"           # repo root toolchain (Node 24)
scripts/setup.sh                      # pinned deps, --ignore-scripts; vendors the kit tarball without its wallet SDKs
npm test                              # 10 tests: mock RPC, Horizon, Wallets Kit (no network)
npm run testnet                       # optional, read-only public testnet (RPC_URL / HORIZON_URL override)
```

Last run (machine clock 2026-11-18 21:16 UTC): 10/10 pass; testnet run OK. `node_modules/` and the extracted
kit were deleted afterwards. Dependencies: MIT 46, Apache-2.0 13, BSD-3-Clause 1 (all allow-listed).

## Not proved here

Browser bundling and the aggregate (no-session) path for browser-side tx metrics; Go/Python wrappers (design only:
Go `rpcclient.NewClient(url, *http.Client)` takes a custom `Transport`; Python `SorobanServer(url, client=…)` takes a
`BaseSyncClient` whose `post(url, json_data)` sees the method); Rust `stellar-rpc-client` 30.0.0 builds its
`HttpClient` internally (no middleware hook).
