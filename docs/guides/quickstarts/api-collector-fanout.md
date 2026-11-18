# API: tenant-side Collector fan-out (recommended)

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: The UsageMap endpoint (OTLP front door, ingest tokens) is built and the Node, Python, Go and Rust recipes run against it in `tests/e2e/api/30-api.e2e.test.ts`; this recipe was measured only against the spike's stand-in endpoint. Source: `spikes/s06a-dual-export-node-python/README.md` §"Recipe A"
(config `collectors/tenant.yaml`), re-confirmed for the Java agent in `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`
(`collector/tenant-fanout.yaml`). Read [api-common.md](api-common.md) first.

Your applications keep exporting to one place — your own OpenTelemetry Collector — with zero-code or default SDK setup.
The Collector sends everything to your APM and a filtered copy to UsageMap. Measured result: the only pattern with **no
header leak** and **no host or process attributes** at UsageMap; requests to UsageMap carried only `content-encoding: gzip` and
the UsageMap `Authorization`, and the resource was reduced to `service.name` (+ `service.instance.id`).

## Collector configuration

Tested with `otel/opentelemetry-collector-contrib:0.165.0`
(`sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea`; there is no `0.165.1` image). Replace the
two endpoints, and list your span-only services (for example Next.js apps) in the span filter.

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  memory_limiter: { check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 20 }
  batch: {}
  filter/scf_metrics_only_http_server:
    error_mode: ignore
    metric_conditions:
      - not (metric.name == "http.server.request.duration" or metric.name == "http.server.duration")
  transform/scf_minimal_metric_attrs:
    error_mode: ignore
    metric_statements:
      - keep_keys(datapoint.attributes, ["http.route", "http.request.method", "http.response.status_code", "error.type", "url.scheme", "network.protocol.version", "http.method", "http.status_code", "http.target"])
      - keep_keys(resource.attributes, ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name"])
  # span branch: only for services that emit no HTTP server metric (e.g. Next.js)
  filter/scf_server_spans_only:
    error_mode: ignore
    trace_conditions:
      - span.kind != SPAN_KIND_SERVER
      - not IsMatch(resource.attributes["service.name"], "^(my-next-app|my-other-span-only-svc)$")
  transform/scf_minimal_span_attrs:
    error_mode: ignore
    trace_statements:
      - replace_pattern(span.attributes["http.target"], "\\?.*$", "")
      - keep_keys(span.attributes, ["http.route", "http.request.method", "http.response.status_code", "error.type", "url.path", "url.scheme", "http.method", "http.status_code", "http.target", "next.route"])
      - keep_keys(resource.attributes, ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name"])
exporters:
  otlp_http/apm:
    endpoint: https://apm.example
    headers: { api-key: "${env:APM_API_KEY}" }
  otlp_http/scf:
    endpoint: https://ingest.scf.example
    headers: { Authorization: "Bearer ${env:SCF_OTLP_TOKEN}" }
    compression: gzip
    sending_queue: { enabled: true }
    retry_on_failure: { enabled: true }
service:
  pipelines:
    traces/apm:  { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    metrics/apm: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    logs/apm:    { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    metrics/scf: { receivers: [otlp], processors: [memory_limiter, filter/scf_metrics_only_http_server, transform/scf_minimal_metric_attrs, batch], exporters: [otlp_http/scf] }
    traces/scf:  { receivers: [otlp], processors: [memory_limiter, filter/scf_server_spans_only, transform/scf_minimal_span_attrs, batch], exporters: [otlp_http/scf] }
```

Notes from the spikes:

- Use the exporter name `otlp_http`; the old `otlphttp` alias still works on 0.165.0 but logs a deprecation warning.
- The span filter keeps SERVER spans of the listed services only. Without the service scoping, Express and FastAPI
  reached UsageMap **both** as metrics and as spans (double source). A rule like "drop spans of services that also send the
  metric" cannot be written in a stateless filter, so the list is explicit.
- Exemplars (Python sends them by default) still reach UsageMap through this config; the platform strips them. Clearing them
  on your side was not tried.
- No logs pipeline goes to UsageMap.

## Pointing your services at the Collector (zero-code, measured)

**Node.js (ESM).** The auto-instrumentation `register` entry does not install the ESM loader hook in 0.83.0; without it
Express is never patched and no `http.route` arrives.

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 OTEL_LOGS_EXPORTER=none node \
  --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
  --import @opentelemetry/auto-instrumentations-node/register app.mjs
# deps: @opentelemetry/auto-instrumentations-node@0.83.0, @opentelemetry/instrumentation@0.301.1
```

(Node 24 prints an ExperimentalWarning for `--experimental-loader`.)

**Python.**

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_SEMCONV_STABILITY_OPT_IN=http opentelemetry-instrument uvicorn app:app
```

plus the `lifespan` flush from [api-python-fastapi.md](api-python-fastapi.md).

**Java.** The agent's normal environment configuration pointed at this Collector (`s06b-java-tenantcol`): UsageMap received
only `http.server.request.duration` with the minimal resource. See [api-java-spring.md](api-java-spring.md).

**Next.js.** `@vercel/otel` with `'auto'` export and `OTEL_EXPORTER_OTLP_*` pointing at the Collector; the span branch
above (with the app listed by name) removes the query from `http.target` and keeps SERVER spans only.
