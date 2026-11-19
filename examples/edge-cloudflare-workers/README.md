# Cloudflare Workers (edge middleware)

A Worker with two routes. Wrapping its export with `withUsageMap` sends UsageMap `http.server.request.duration`
per **route template** (`/accounts/{id}`, never `/accounts/GABC…`), method and status, exported after the response
through `ctx.waitUntil`. Query, headers, client address and body are never read. Cloudflare's own OTLP export has
traces only; this fills the metrics gap. Guide: [Cloudflare Workers](../../docs/onboarding/api-cloudflare-workers.md);
package: [`packages/edge-otel`](../../packages/edge-otel/README.md).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/edge-otel build && pnpm --dir examples install`
   (installs `wrangler` 4.162.0 for this example).
2. **Set your key:** service name and endpoint are in `wrangler.toml`; put the token in `.dev.vars` locally
   (`OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_…`) and `pnpm exec wrangler secret put OTEL_EXPORTER_OTLP_HEADERS` for deploys.
3. **Run:** `cd examples/edge-cloudflare-workers && pnpm dev` → `curl localhost:8787/accounts/GABC`. Each 10-second
   window is exported by the next request after it closes.

## The lines that add UsageMap

`src/worker.ts`:

```ts
import { optionsFromEnv, withUsageMap } from "@usagemap/edge-otel";
// …
export default withUsageMap(app, (env: Record<string, unknown>) => ({
  ...optionsFromEnv(env),
  routes: ["/health", "/accounts/:id"],
}));
```

## What you'll see in the portal

**API services → my-worker**: requests per route (`/accounts/{id}`, `/health`), status codes and latency, about a
minute after the first export. Durations on Workers are I/O-inclusive wall time (the Workers clock only advances
across I/O).

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
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-worker"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` runs the Worker in **workerd through the example's own
`wrangler dev`** (local mode, no Cloudflare account), sends 5×200 and 3×404 with canary query strings, user agent,
forwarded address and cookie, then a request after the window closes, and checks at the UsageMap stand-in: the counts
per route template and status, only `method`, `route` and `status` as attributes, `service.name` from
`wrangler.toml`, and no canary. A deploy to Cloudflare itself is not part of the test.
