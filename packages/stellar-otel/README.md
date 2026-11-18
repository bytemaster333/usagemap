# @usagemap/stellar-otel

OpenTelemetry metrics for **js-stellar-sdk** calls made by your backend: latency per Stellar RPC method and Horizon
route, plus outcome classes for transaction submission, polling and simulation. It records with **your own
MeterProvider** (`@opentelemetry/api` peer dependency) and never records an address, transaction hash, XDR, key, URL
or user identifier.

- **Supported SDK:** `@stellar/stellar-sdk` **13.x to 17.x** (peer range `>=13.0.0 <18.0.0`). It uses only the
  SDK's public interceptor API. On anything without it, both functions do nothing and return
  `{ instrumented: false }`. They never throw and never change a request. See [SDK versions](#sdk-versions).
- **Server side only:** Node.js ≥ 22.12, e.g. Express or Next.js route handlers. Browser use
  is not supported yet; other runtimes are untested.
- **No dependency on the SDK's XDR classes:** SDK 17 replaced the js-xdr accessors, and SDK 16 folded
  `@stellar/stellar-base` into the SDK. Result codes are therefore read straight from the `TransactionResult` bytes
  (fee | code | first operation result, fee-bump inner results included), a wire layout that is the same in every
  major. This adds nothing to the bundle.

## Quickstart

```ts
import { rpc, Horizon } from "@stellar/stellar-sdk";
import { instrumentStellarRpc, instrumentHorizon } from "@usagemap/stellar-otel";
export const server = new rpc.Server("https://soroban-testnet.stellar.org");
instrumentStellarRpc(server, { network: "testnet" });   // network is learnt from getNetwork if omitted
instrumentHorizon(new Horizon.Server("https://horizon-testnet.stellar.org"), { network: "testnet" });
```

Export with your usual OTel setup, e.g. `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and the `Authorization: Bearer
$SCF_OTLP_TOKEN` header of the UsageMap OTel recipe. Generated `contract.Client`s and `AssembledTransaction`s are
covered when you pass the instrumented server as their `server` option.

## SDK versions

| SDK version | Hook point | What you pass | Tested at |
|---|---|---|---|
| 14.3.1 to 17.x | each server's own `server.httpClient.interceptors` | the `rpc.Server` / `Horizon.Server` | 14.6.1, 15.1.0, 16.4.1, 17.4.0 |
| 13.0.0 to 14.3.0 | the module-wide `rpc.AxiosClient` / `Horizon.AxiosClient` that all servers share | the `rpc` / `Horizon` namespace | 13.3.0, 14.1.0 |

The per-server clients arrived in js-stellar-sdk **14.3.1** ("Replaced global `HttpClient` with per-instance clients",
CHANGELOG). On 13.x to 14.3.0, instrument the namespace once at start-up:

```ts
import { rpc, Horizon } from "@stellar/stellar-sdk";          // 13.x … 14.3.0
instrumentStellarRpc(rpc, { network: "testnet" });            // covers every rpc.Server of this SDK copy
instrumentHorizon(Horizon, { network: "testnet" });
```

On those versions, passing a server instance returns `{ instrumented: false }` because the instance has no client
of its own. On 14.3.1 and later, passing the namespace does the same. The handle's `scope` (`"server"` or `"module"`)
tells you which hook was used. A module-wide hook has one `stellar.network` for the whole process, so pass `network`
if the process talks to more than one network. SDK 12 and older are not supported.

**How to check:** `npm ls @stellar/stellar-sdk` (or `pnpm why @stellar/stellar-sdk`) shows the version your backend
loads. Then check that `instrumentStellarRpc(…).instrumented` is `true` at start-up and log it if it is not:

```ts
const h = instrumentStellarRpc(server, { network: "testnet" });
if (!h.instrumented) console.warn("stellar-otel: SDK without interceptors, see the SDK versions table");
```

## What is recorded

| Metric | Type | Attributes (all closed sets) |
|---|---|---|
| `rpc.client.call.duration` | histogram, s | `rpc.system.name=jsonrpc`, `rpc.method` (13 Stellar RPC methods or `_OTHER`), `error.type` (JSON-RPC code `-32700…-32603`, HTTP status ≥ 400, `timeout`, `network`, `_OTHER`; only on failure), `rpc.status_code` (the JSON-RPC code), `stellar.network` |
| `http.client.request.duration` | histogram, s | `http.request.method` (`GET`/`POST`/`_OTHER`), `url.template` (50 Horizon route templates including `/`; anything else `_OTHER`; a base-path prefix such as an API key is skipped), `http.response.status_code` (28 known statuses), `error.type`, `stellar.network` |
| `stellar.tx.submissions` | counter | `stellar.tx.via` (`rpc`/`horizon`), `stellar.tx.status` (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`, `SUCCESS`, `FAILED`, `_OTHER`), `stellar.tx.result_class` (on `ERROR`/`FAILED`), `stellar.network` |
| `stellar.tx.polls` | counter | `stellar.tx.status` (`SUCCESS`, `FAILED`, `NOT_FOUND`, `_OTHER`), `stellar.tx.result_class` (on `FAILED`), `stellar.network` |
| `stellar.tx.simulations` | counter | `stellar.sim.outcome` (`success`, `error`, `restore_required`), `stellar.sim.error_class` (on `error`), `stellar.network` |

Result classes: `success`, `bad_seq`, `insufficient_fee`, `insufficient_balance`, `bad_auth`, `time_bounds`,
`no_account`, `malformed`, `soroban_invalid`, `resource_limit`, `expired_state`, `contract_error`, `op_failed`,
`undecodable`, `other`. Simulation error classes are matched on the host error text in memory, and the text is then
discarded. `stellar.network` is one of `mainnet`, `testnet`, `futurenet`, `local`, `unknown`.

**Never recorded:** the RPC or Horizon URL (paid providers put API keys in it), request params, transaction hashes,
XDR, account or contract addresses, ledger keys, error message text and request ids. The UsageMap Collector applies
the same closed sets again on ingest (wire-formats §f.5 step 4a) and drops everything else. These metrics describe
your backend's **outbound dependency health**. They are not API usage and never count as API traffic.

## Develop

```sh
pnpm --filter @usagemap/stellar-otel test          # whole suite once per SDK major (13.3.0, 14.1.0, 14.6.1,
                                                        # 15.1.0, 16.4.1, 17.4.0): mock RPC/Horizon, OTLP export
pnpm --filter @usagemap/stellar-otel exec vitest run --project sdk-15   # one major only
pnpm --filter @usagemap/stellar-otel test:testnet  # optional, read-only public testnet (RPC_URL/HORIZON_URL), 17.x
node scripts/record-fixtures.ts                         # re-record test/fixtures/testnet-rpc.json (read-only)
pnpm --filter @usagemap/stellar-otel collector-fixture   # rewrite the Collector's SDK fixture
```
