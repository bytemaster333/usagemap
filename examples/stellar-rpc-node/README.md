# Stellar RPC and Horizon calls (Node.js, js-stellar-sdk)

A backend script that calls Stellar RPC (`getHealth`, `getNetwork`) and Horizon (`/fee_stats`) on testnet with
`@stellar/stellar-sdk` 17.4.0. `@usagemap/stellar-otel` measures every call: latency per RPC method and Horizon
route, outcome class and network — never the RPC URL (provider keys live there), an address, a hash or XDR. Guide:
[Node.js / Express](../../docs/onboarding/api-node-express.md); package: [`packages/stellar-otel`](../../packages/stellar-otel/README.md).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/stellar-otel build && pnpm --dir examples install`
   (the package is linked from this repository until it is on npm).
2. **Set your key:** in the portal, **Project → API services → Add**, then **Ingest tokens**:
   `export OTEL_SERVICE_NAME=my-backend OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20scfa_ing_…"`
3. **Run:** `cd examples/stellar-rpc-node && pnpm start` → prints `rpc healthy, protocol …, fee p50 …` and exports once
   on exit (set `STELLAR_RPC_URL` / `HORIZON_URL` for your own provider).

## The lines that add UsageMap

`index.mjs`:

```js
import { instrumentHorizon, instrumentStellarRpc } from "@usagemap/stellar-otel";
// …
// UsageMap: one line per server object.
const r = instrumentStellarRpc(server, { network: "testnet" });
const h = instrumentHorizon(horizon, { network: "testnet" });
```

`otel.mjs` is a plain metrics-only OpenTelemetry setup (MeterProvider → OTLP/HTTP), configured by the standard
`OTEL_*` variables; keep yours if you have one.

## What you'll see in the portal

**API services → my-backend → Stellar RPC/Horizon**: one `getHealth` and one `getNetwork` call (`jsonrpc`, testnet)
and one `GET /fee_stats`, each with its latency. These are your backend's **outbound dependency health**, not API
usage: they never count as API traffic.

## Test it without the app

The portal's API test (**Integrations → the card → Test**) sends one marked data point for your service through
the same endpoint. It is recorded as a baseline point in the service's data-quality table and never counted:

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-backend"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` runs `node index.mjs` against a local stand-in of Stellar RPC
(recorded testnet answers from `packages/stellar-otel/test/fixtures/testnet-rpc.json`) and Horizon whose URLs carry
a canary "provider key", and a local stand-in of the UsageMap OTLP endpoint. It checks the bearer token, one point per
method and route with `stellar.network=testnet`, and that no URL, key, query or forbidden attribute key arrives.
The public testnet is not called by the test.
