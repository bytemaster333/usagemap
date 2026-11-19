# Calls to SCF Integration List partners (Soroswap)

A backend that asks Soroswap's API for a quote and a price. Wrapping `fetch` once with `partnerFetch` records each
partner call: partner, route template, outcome class and network — never the URL, query, API key, body or amounts.
Calls to other hosts pass through unmeasured. Guide: [Partner calls](../../docs/onboarding/api-partner-calls.md).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/partner-otel build && pnpm --dir examples install`.
2. **Set your key:** **Project → API services → Add** and an ingest token:
   `export OTEL_SERVICE_NAME=my-backend OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20scfa_ing_…"`
   and your partner key `export SOROSWAP_API_KEY=…`.
3. **Run:** `cd examples/partner-calls && pnpm start` → `POST /quote → …`, `GET /price → …`; exports once on exit.

## The lines that add UsageMap

`index.mjs`:

```js
import { partnerFetch } from "@usagemap/partner-otel";
// …
const opts = { network: "testnet" };
if (process.env.SOROSWAP_API_URL) opts.partner = "soroswap";
const fetch = partnerFetch(globalThis.fetch, opts);
```

On `api.soroswap.finance` the host identifies the partner; `partner` is only needed behind your own proxy.

## What you'll see in the portal

**API services → my-backend → partner calls**: `soroswap` `/quote` and `/price` with their outcome (`success`,
`auth_error` without a valid key, `rate_limited` …) and latency, on testnet. Labelled self-reported; your on-chain
metric stays the authority.

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

`tests/quickstarts/integrations/server.spec.ts` runs `node index.mjs` against a local stand-in of the partner API
(`/quote` 200, `/price` 429) and the UsageMap OTLP stand-in. It checks `/quote` `success` and `/price`
`rate_limited` with exactly four attributes, that the API key reached the partner but not UsageMap, and that the
contract ids in the query and the body never arrive. Soroswap itself is not called.
