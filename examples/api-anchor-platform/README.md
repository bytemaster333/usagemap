# Stellar Anchor Platform 5.x

Anchor Platform's SEP server measured by configuration only: the OpenTelemetry Java agent attached through `JAVA_TOOL_OPTIONS`; SEP routes arrive as templates (`/sep12/customer/{account}` is never expanded). Guide: [Anchor Platform: configuration only](../../docs/onboarding/api-anchor-platform.md).

## Run it

1. **Install:** `cd examples/api-anchor-platform && ./fetch-agent.sh ./otel` (downloads the agent from Maven Central and checks its SHA-256).
2. **Set your key:** add `OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_…` and `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=sep-1` to the platform's environment, next to `otel-scf-only.env` (portal: **Project → API services**, **Ingest tokens**).
3. **Run:** start your Anchor Platform 5.0.0 container with `--env-file otel-scf-only.env`, `-v $PWD/otel:/otel:ro` and `--entrypoint java … -jar /app/anchor-platform-runner.jar --sep-server` (full command in the guide).

## The lines that add UsageMap

`otel-scf-only.env`:

```sh
JAVA_TOOL_OPTIONS=-javaagent:/otel/opentelemetry-javaagent.jar
OTEL_SERVICE_NAME=my-anchor
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
# Without it the agent attaches exemplars carrying client.address, url.query and user_agent.original (measured).
OTEL_METRICS_EXEMPLAR_FILTER=always_off
```

## What you'll see in the portal

Portal → your project → **API services** → the service `my-anchor`. After the first export interval (60 s by
default) the data-quality panel shows the points as kept, and the dashboard shows SEP routes such as `/.well-known/stellar.toml` with their status counts and latency. Path values (the `G…` in the URL) never arrive: only the route template does.

## Test it without the app

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-anchor"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
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
these files. Run: `QS_BACKENDS=anchor-platform tests/quickstarts/backends/run.sh` (Docker: `stellar/anchor-platform:5.0.0` + PostgreSQL).
