# API: Java / Spring Boot (OpenTelemetry Java agent)

**Status (docs.quickstarts-run): measured in a spike, not yet against the real endpoint.** The UsageMap endpoint (OTLP front door, ingest tokens) is built and the Node, Python, Go and Rust recipes run against it in `tests/e2e/api/30-api.e2e.test.ts`; this recipe was measured only against the spike's stand-in endpoint. Source: `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`
("Java", scenarios `s06b-java-otelconf` and `s06b-java-tenantcol`; config `apps/java-spring/otel/sdk.yaml`). Read
[api-common.md](api-common.md) first.

Tested: OpenTelemetry Java agent 2.33.1 (SDK 1.67.0), Spring Boot 4.1.2 (`spring-boot-starter-webmvc`, Tomcat), Java 25.
The server metric comes from the **Tomcat** instrumentation scope (`io.opentelemetry.tomcat-10.0`), not from Spring.
Unmatched requests get `http.route = "/**"`, which the platform treats as no route (`{unknown}`).

## Option 1: agent with a declarative configuration file

```sh
OTEL_SERVICE_NAME=my-api OTEL_CONFIG_FILE=/etc/otel/sdk.yaml \
java -javaagent:opentelemetry-javaagent.jar -jar app.jar
```

```yaml
# /etc/otel/sdk.yaml — for the OpenTelemetry Java agent 2.33.1. ${VAR} is substituted from the environment.
file_format: "1.2"
resource:
  attributes:
    - name: service.name
      value: ${OTEL_SERVICE_NAME}
  detection/development:
    detectors:
      - service:          # adds service.instance.id
tracer_provider:
  processors:
    - batch:
        exporter:
          otlp_http:
            endpoint: ${APM_ENDPOINT}/v1/traces
            headers: [ { name: api-key, value: "${APM_API_KEY}" } ]
meter_provider:
  exemplar_filter: always_off   # exemplars would carry client IP, query string and User-Agent (below)
  readers:
    - periodic:
        interval: 5000
        exporter:
          otlp_http:
            endpoint: ${APM_ENDPOINT}/v1/metrics
            headers: [ { name: api-key, value: "${APM_API_KEY}" } ]
    - periodic:
        interval: 5000
        exporter:
          otlp_http:
            endpoint: ${SCF_OTLP_ENDPOINT}/v1/metrics
            headers: [ { name: Authorization, value: "Bearer ${SCF_OTLP_TOKEN}" } ]
            temporality_preference: cumulative
            default_histogram_aggregation: explicit_bucket_histogram
logger_provider:
  processors:
    - batch:
        exporter:
          otlp_http:
            endpoint: ${APM_ENDPOINT}/v1/logs
            headers: [ { name: api-key, value: "${APM_API_KEY}" } ]
propagator:
  composite: [ { tracecontext: }, { baggage: } ]
```

The `interval: 5000` is the spike's test value; use your normal export interval. `SCF_OTLP_ENDPOINT` is
`https://ingest.scf.example` (placeholder).

Measured behaviour:

- **Switch exemplars off** (`exemplar_filter: always_off` in the file; `OTEL_METRICS_EXEMPLAR_FILTER=always_off` in
  env mode, Option 2). Measured with agent 2.33.1: otherwise every histogram point carries exemplars whose attributes
  include `client.address` (taken from `X-Forwarded-For`), `url.query`, `url.path`, `user_agent.original` and
  `network.peer.address` — even with `OTEL_TRACES_EXPORTER=none`, and to **every** exporter, your APM included. UsageMap
  drops exemplars before storage; your other backends may keep them.
- Use `file_format: "1.2"`; `"1.0"` works with a warning.
- **In declarative mode no resource detectors run by default** — without `detection/development.detectors:
  [service:]` there is no `service.instance.id`.
- Environment OTLP headers are **ignored** when the file is used (a wrong env `Authorization` did not reach UsageMap).
- **No per-reader filter:** UsageMap receives the duration metric plus 12 `jvm.*` and `otel.sdk.*` metrics; the platform
  drops everything but the duration.
- The agent exports logs by default; here they go to your APM only. Do not point the agent's single env endpoint at
  UsageMap — `/v1/logs` answers `404` there.

## Option 2: agent with its normal env config → your Collector

Point the agent's standard `OTEL_EXPORTER_OTLP_ENDPOINT` at a [tenant Collector](api-collector-fanout.md). Measured
(`s06b-java-tenantcol`): UsageMap received only `http.server.request.duration` and the resource was reduced to
`service.name`, `service.version` and `service.instance.id` (the agent's env mode also sends `host.name`,
`container.id`, `process.*`, `os.*`, which the Collector's `keep_keys` removes).

Not tested: an agent extension that adds a second metric reader in code.
