# Vercel Edge Functions (edge middleware)

A Vercel Edge Function without a framework: `GET /api/accounts/<id>`. Wrapping the default export with
`withUsageMap` sends UsageMap the request count, status and duration under the route template `/api/accounts/{id}`,
exported after the response through the request context's `waitUntil`. Query, headers, client address and body are
never read. Guide: [Cloudflare Workers and other edge runtimes](../../docs/onboarding/api-cloudflare-workers.md);
package: [`packages/edge-otel`](../../packages/edge-otel/README.md#vercel-edge-function).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/edge-otel build && pnpm --dir examples install`.
2. **Set your key:** `export OTEL_SERVICE_NAME=my-edge-api OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20scfa_ing_…"`
   (on Vercel: the same three as project environment variables, the token as a sensitive one).
3. **Run:** `cd examples/edge-vercel && pnpm start` → `curl localhost:3000/api/accounts/GABC`. `pnpm start` runs the
   function on Node the way the edge runtime calls it; `vercel deploy` runs the same file on Vercel.

## The lines that add UsageMap

`api/accounts/[id].ts`:

```ts
import { optionsFromEnv, withUsageMap } from "@usagemap/edge-otel";
// …
export default withUsageMap(handler, {
  ...optionsFromEnv(process.env),
  routes: ["/api/accounts/[id]"],
});
```

## What you'll see in the portal

**API services → my-edge-api**: requests per route (`/api/accounts/{id}`), status codes and latency.

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
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-edge-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` starts `dev.mjs` on Node, sends 5×200 and 3×404 with canaries, then a
request after the 10-second window, and checks the counts per route template and status, the three attributes and no
canary at the UsageMap stand-in. **Not run:** Vercel's edge runtime itself (`vercel dev` needs a linked Vercel
project); the package's `test/runtimes.test.ts` reproduces its calling convention.
