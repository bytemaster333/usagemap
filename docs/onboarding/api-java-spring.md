# Java / Spring Boot API: the first 10 minutes

**UsageMap-only, environment variables only, no code change.** The OpenTelemetry Java agent instruments Spring MVC, Tomcat
and the JVM at start-up; UsageMap is the only destination, so everything is configured by environment variables. Already
have an APM? See [dual export](#dual-export-agent-with-a-declarative-file) below.

**Tested:** the example service [`examples/api-java-spring`](../../examples/api-java-spring/) (Spring Boot 4.1.2,
`spring-boot-starter-webmvc`, Java 25, agent 2.33.1) runs in the repository's backend suite with the start command
and environment below, against a local stand-in of the UsageMap endpoint: requests with three status codes on
`/accounts/{id}`, then `SIGTERM`. UsageMap received `http.server.request.duration` with `http.route`, the status code and
the duration, counts equal to what the app answered, in the export the agent sent on shutdown; no client address, user
agent or query string anywhere in the payload.

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API**, then **Ingest tokens** → create a token |
| 2–4 | Download the agent jar |
| 4–10 | Start with the environment below; the API wizard shows data after one export interval (60 s) |

## 1. The agent

Download `opentelemetry-javaagent-2.33.1.jar` from Maven Central
(`io.opentelemetry.javaagent:opentelemetry-javaagent:2.33.1`, SHA-256
`e43a270df53c6f423e0ab157be9c27ccc01d5dc3232e162fe54777573db2f149`), or let Maven fetch it next to your jar as the
example's `pom.xml` does (`maven-dependency-plugin`, goal `copy`). No dependency is added to the application.

## 2. Start command

```sh
OTEL_SERVICE_NAME=my-api \
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${SCF_OTLP_TOKEN}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_METRICS_EXPORTER=otlp OTEL_TRACES_EXPORTER=none OTEL_LOGS_EXPORTER=none \
OTEL_METRICS_EXEMPLAR_FILTER=always_off \
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${HOSTNAME}" \
java -javaagent:opentelemetry-javaagent.jar -jar app.jar
```

- **`OTEL_METRICS_EXEMPLAR_FILTER=always_off` is required.** Measured with agent 2.33.1: without it, every histogram
  point carries exemplars whose attributes include `client.address` (taken from `X-Forwarded-For`), `url.query`,
  `url.path`, `user_agent.original` and `network.peer.address` — even with `OTEL_TRACES_EXPORTER=none`. UsageMap strips
  exemplars before storage, but they should not leave your process.
- `OTEL_LOGS_EXPORTER=none`: the agent exports logs by default, and UsageMap refuses them (`404`).
- `OTEL_TRACES_EXPORTER=none`: metrics are enough; spans as well would count the service twice.
- The JVM flushes on `SIGTERM` through the agent's shutdown hook (measured: the only export of a short run arrived on
  shutdown). Make sure your container's PID 1 passes the signal on to `java`.

## 3. Check it

After a minute the API wizard shows requests per route (`/accounts/{id}`), status codes and latency. Unmatched paths
arrive as `http.route = "/**"`, which the platform counts under `{unknown}`. The agent also sends `jvm.*` metrics and
resource attributes such as `host.name`, `container.id` and `process.command_args`; UsageMap drops them before storage.
Nothing arrives? See [troubleshooting](troubleshooting.md#api-opentelemetry).

## Dual export: agent with a declarative file

Keep your APM and send UsageMap a copy: the agent reads a declarative configuration file
(`OTEL_CONFIG_FILE=/etc/otel/sdk.yaml`) with two metric readers. The example's
[`otel/sdk.yaml`](../../examples/api-java-spring/otel/sdk.yaml) is run by the same suite: the APM stand-in got traces,
metrics and logs with its own key, UsageMap got metrics only, with the UsageMap token, and never the APM key.

```sh
OTEL_SERVICE_NAME=my-api OTEL_CONFIG_FILE=/etc/otel/sdk.yaml \
APM_OTLP_ENDPOINT=https://apm.example APM_API_KEY=... \
SCF_OTLP_ENDPOINT=https://ingest.scf.example SCF_OTLP_TOKEN=scfa_ing_... \
java -javaagent:opentelemetry-javaagent.jar -jar app.jar
```

Measured with this file: environment OTLP headers are ignored (the suite sets your APM key in
`OTEL_EXPORTER_OTLP_HEADERS` as well, and it never reached UsageMap); declarative mode runs only the resource detectors
the file lists, and `detection/development: detectors: [service:]` adds `service.instance.id`; there is no per-reader
filter, so UsageMap also receives `jvm.*` and `otel.sdk.*` metrics (dropped before storage); `exemplar_filter: always_off`
is set in the file for the reason above. To filter before anything leaves your network, use a
[tenant Collector](../guides/quickstarts/api-collector-fanout.md) instead.

## Where this comes from

- OpenTelemetry Java agent 2.33.1 documentation (opentelemetry.io/docs/zero-code/java/agent/configuration/, read
  2026-11-19) and the OpenTelemetry specification's SDK environment variables (`OTEL_METRICS_EXEMPLAR_FILTER`:
  `always_on`, `always_off`, `trace_based`).
- Everything on this page is run by our backend suite against the example service; Maven Central for the agent's
  checksum.
