# Paid API with x402 on Stellar

An Express API whose `GET /report` costs $0.01 in USDC on testnet through an x402 facilitator. `instrumentX402Http` adds payment required / verified / settled / failed / canceled counts; nothing about the payer, payee, amount or transaction leaves the process. Guide: [Agent payments (x402, MPP)](../../docs/onboarding/payments.md).

## Run it

1. **Install:** from the repository root, `pnpm install && pnpm --filter @usagemap/payments-otel build && pnpm -C examples install --frozen-lockfile --filter ./api-x402`.
2. **Set your key:** `export PAY_TO=G… FACILITATOR_URL=https://… OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer%20$SCF_OTLP_TOKEN OTEL_SERVICE_NAME=paid-api` (portal: **Project → API services**, **Ingest tokens**).
3. **Run:** `pnpm -C examples/api-x402 start`, then `curl -i localhost:8402/report` (answers `402 Payment Required`).

## The lines that add UsageMap

`server.mjs`:

```js
import { instrumentX402Http } from "@usagemap/payments-otel";
// …
// UsageMap: payment required / verified / settled / failed / canceled counts.
const payments = instrumentX402Http(httpServer);
if (!payments.instrumented) console.warn("payments-otel: x402 server without hook API");
```

`package.json`:

```json
    "start": "node --import ./otel.mjs server.mjs"
```

## What you'll see in the portal

Portal → your project → **API services** → `paid-api` → the payments panel: `payment required` for every 402, then `verified` and `settled` once a client pays. Counts only; no payer, amount or hash.

## Test it without the app

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"paid-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200 {"partialSuccess":{}}` means accepted (`401`: token wrong; `403`: project pending). The point is recorded as
one *baseline point* in the service's data-quality table and adds nothing to any figure
([how the API test works](../../docs/onboarding/integrations.md#how-the-api-test-works)).

## Tested by

`packages/payments-otel/test/example-x402.test.ts` runs this server with `@x402/core` and a fake facilitator and checks the payment counters it exports (`pnpm --filter @usagemap/payments-otel run test:example`); `tests/quickstarts/backends.test.ts` checks it is listed.
