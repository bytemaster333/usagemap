# Bun HTTP server (edge middleware)

A Bun HTTP server with two routes. `usagemap.wrap(handler)` sends UsageMap `http.server.request.duration` per
route template (`/accounts/{id}`), method and status. On a long-lived server `flushTimer` exports every 10 seconds,
and `SIGTERM` exports what is left. Query, headers, client address and body are never read. Guide:
[Cloudflare Workers and other edge runtimes](../../docs/onboarding/api-cloudflare-workers.md); package:
[`packages/edge-otel`](../../packages/edge-otel/README.md#bun).

## Run it

1. **Install:** Bun 1.4; from the repository root, `pnpm --filter @usagemap/edge-otel build && pnpm --dir examples install`.
2. **Set your key:** `export OTEL_SERVICE_NAME=my-bun-api OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20scfa_ing_…"`
   (or the shorter `USAGEMAP_ENDPOINT` / `USAGEMAP_TOKEN` / `USAGEMAP_SERVICE_NAME`).
3. **Run:** `cd examples/edge-bun && bun run index.ts` → `curl localhost:3000/accounts/GABC`.

## The lines that add UsageMap

`index.ts`:

```ts
import { createUsageMap, optionsFromEnv } from "@usagemap/edge-otel";
// …
const usagemap = createUsageMap({
  ...optionsFromEnv(Bun.env),
  routes: ["/health", "/accounts/:id"],
  flushTimer: true,
});
// …
  fetch: usagemap.wrap(handler),
// …
process.on("SIGTERM", async () => {
  await usagemap.shutdown();
```

## What you'll see in the portal

**API services → my-bun-api**: requests per route (`/accounts/{id}`, `/health`), status codes and latency, within
about a minute.

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
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-bun-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` runs `bun run index.ts` in the pinned `oven/bun:1.4.4-alpine` image (by digest, host network),
sends 5×200 and 3×404 with canary query strings, user agent, forwarded address and cookie, stops the container with
SIGTERM and checks at the UsageMap stand-in that the last window was exported: counts per route template and status,
only `method`, `route` and `status` as attributes, and no canary.
