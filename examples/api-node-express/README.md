# Node.js / Express API

An Express API measured with zero code changes: the OpenTelemetry auto-instrumentation is loaded by the start command and configured by the standard `OTEL_*` variables. `otel-dual-export.mjs` shows the variant for apps that already export to an APM. Guide: [Node.js API in 10 minutes](../../docs/onboarding/api-node-express.md).

## Run it

1. **Install:** `pnpm -C examples install --frozen-lockfile --filter ./api-node-express` (from the repository root).
2. **Set your key:** `export OTEL_SERVICE_NAME=my-api OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20$SCF_OTLP_TOKEN OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_METRICS_EXPORTER=otlp OTEL_TRACES_EXPORTER=none OTEL_LOGS_EXPORTER=none` (portal: **Project → API services** gives the endpoint and the service name; the ingest token `scfa_ing_…` is shown once under **Ingest tokens**).
3. **Run:** `pnpm -C examples/api-node-express run start:scf-only`, then `curl localhost:8080/accounts/GABC`.

## The lines that add UsageMap

`package.json`:

```json
    "start:scf-only": "node --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import @opentelemetry/auto-instrumentations-node/register app.mjs",
```

`otel-dual-export.mjs`:

```js
const { APM_OTLP_ENDPOINT, APM_API_KEY, SCF_OTLP_ENDPOINT, SCF_OTLP_TOKEN } = process.env;
// …
const SCF_METRICS = ["http.server.request.duration", "http.server.duration"];
```

## What you'll see in the portal

Portal → your project → **API services** → the service `my-api`. After the first export interval (60 s by
default) the data-quality panel shows the points as kept, and the dashboard shows the route `/accounts/{id}` (as
your framework names the parameter) with its 200, 404 and 500 counts and latency. Path values (the `G…` in the URL) never arrive: only the route template does.

## Test it without the app

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200 {"partialSuccess":{}}` means accepted (`401`: token wrong; `403`: project pending). The point is recorded as
one *baseline point* in the service's data-quality table and adds nothing to any figure
([how the API test works](../../docs/onboarding/integrations.md#how-the-api-test-works)).

## Tested by

`tests/quickstarts/backends/backends.spec.ts` starts this service in both modes (UsageMap only, and dual export next to
an APM) against a local stand-in of the UsageMap OTLP endpoint, sends a fixed request mix with canary query strings,
User-Agent and `X-Forwarded-For`, stops it with `SIGTERM` and checks what arrived: the route template, status codes,
exact counts, the bearer token, and none of the canaries. `tests/quickstarts/backends.test.ts` checks the guide against
these files. Run: `QS_BACKENDS=node-express tests/quickstarts/backends/run.sh`.
