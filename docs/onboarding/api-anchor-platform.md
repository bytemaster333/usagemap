# Stellar Anchor Platform 5.x: configuration only

**No code, no rebuild.** The Anchor Platform is a Spring Boot application in the `stellar/anchor-platform` image. The
OpenTelemetry Java agent, attached by an environment variable, measures its SEP endpoints; UsageMap receives the HTTP server
duration metric per SEP route (`/sep10/auth`, `/sep24/transactions/...`, `/.well-known/stellar.toml`, ...). Your
deployment keeps its own anchor configuration; you add one jar and a few environment variables.

**Tested:** `stellar/anchor-platform:5.0.0` (digest
`sha256:bb1487fa38665dcbf0879a2303fc113dea021f73570c49da112292ec2d52c009`, Java 17 inside) with the agent 2.33.1 and
the files in [`examples/api-anchor-platform`](../../examples/api-anchor-platform/) runs in the repository's backend
suite as a SEP server (SEP-1 enabled, a throwaway PostgreSQL) against a local stand-in of the UsageMap endpoint: requests
to `/.well-known/stellar.toml` (200) and to a disabled SEP (404), then `docker stop`. UsageMap received
`http.server.request.duration` with `http.route`, the status code and the duration, counts equal to what the server
answered; no client address, user agent or query string anywhere in the payload. Only the SEP-1 route was exercised;
the other SEP routes go through the same Spring MVC instrumentation, but they were not called by the test.

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API** (service name, e.g. `my-anchor`), then **Ingest tokens** → create a token |
| 2–4 | Download the agent jar and mount it into the container |
| 4–8 | Add the environment variables and the entrypoint below to your SEP server's container |
| 8–10 | Restart; the API wizard shows data after one export interval (60 s) |

## 1. The agent jar

The example's [`fetch-agent.sh`](../../examples/api-anchor-platform/fetch-agent.sh) downloads
`opentelemetry-javaagent-2.33.1.jar` from Maven Central and checks its SHA-256
(`e43a270df53c6f423e0ab157be9c27ccc01d5dc3232e162fe54777573db2f149`):

```sh
./fetch-agent.sh ./otel     # writes ./otel/opentelemetry-javaagent.jar
```

Mount the directory read-only at `/otel` in the SEP server's container.

## 2. Environment

The example's [`otel-scf-only.env`](../../examples/api-anchor-platform/otel-scf-only.env), plus the endpoint, the
token and an instance id at run time:

```sh
JAVA_TOOL_OPTIONS=-javaagent:/otel/opentelemetry-javaagent.jar
OTEL_SERVICE_NAME=my-anchor
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_TRACES_EXPORTER=none
OTEL_LOGS_EXPORTER=none
OTEL_METRICS_EXEMPLAR_FILTER=always_off
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_...
OTEL_RESOURCE_ATTRIBUTES=service.instance.id=sep-1
```

- `JAVA_TOOL_OPTIONS` is read by the JVM itself, whatever starts it. If you already set it, append the flag.
- **`OTEL_METRICS_EXEMPLAR_FILTER=always_off` is required**: measured with agent 2.33.1, exemplars otherwise carry
  `client.address` (from `X-Forwarded-For`), `url.query` and `user_agent.original` into every export.
- `OTEL_LOGS_EXPORTER=none`: the agent exports logs by default; UsageMap refuses them.

## 3. Entrypoint: let `SIGTERM` reach Java

```sh
docker run ... --entrypoint java stellar/anchor-platform:5.0.0 -jar /app/anchor-platform-runner.jar --sep-server
```

The image's own start script runs `java` from a `bash` script without `exec`, so `docker stop` (or a Kubernetes pod
deletion) signals `bash`, not Java. Measured with the stock entrypoint: the container was killed when the grace period
ran out, the agent never flushed, and UsageMap received nothing from a run shorter than one export interval — every restart
loses up to a minute of requests. With `java` as the entrypoint the JVM shuts down cleanly and the agent's last export
arrives (measured). The Kubernetes equivalent (not run by the suite) is `command: ["java"]` and
`args: ["-jar", "/app/anchor-platform-runner.jar", "--sep-server"]`. Measure the SEP server only: the Platform API
(`--platform-server`) is your back office's interface, not public usage.

## 4. Check it

The API wizard shows requests per SEP route, status codes and latency. Unmatched paths arrive as `http.route = "/**"`
and are counted under `{unknown}`. The agent also sends `jvm.*` and `db.client.connections.*` metrics and resource
attributes such as `host.name`, `container.id` and `process.command_args`; UsageMap drops them before storage. Nothing
arrives? See [troubleshooting](troubleshooting.md#api-opentelemetry).

## Already have an APM?

Use [`otel-dual-export.env`](../../examples/api-anchor-platform/otel-dual-export.env) with the Java example's
declarative file [`sdk.yaml`](../../examples/api-java-spring/otel/sdk.yaml) mounted at `/otel/sdk.yaml`, and set
`OTEL_SERVICE_NAME`, `APM_OTLP_ENDPOINT`, `APM_API_KEY`, `SCF_OTLP_ENDPOINT` and `SCF_OTLP_TOKEN`. Run by the same
suite: the APM stand-in got traces, metrics and logs with its own key; UsageMap got metrics only, with the UsageMap token. See
[Java dual export](api-java-spring.md#dual-export-agent-with-a-declarative-file) for what the file does.

## What the test needed besides your configuration

[`anchor-demo.env`](../../examples/api-anchor-platform/anchor-demo.env) is the smallest configuration that starts a
5.0.0 SEP server for the test: SEP-1 only, one testnet asset, and a PostgreSQL database (`DATA_TYPE=postgres`) — the
5.0.0 image ships neither the H2 nor the SQLite driver its defaults mention, so a database is needed even for a demo
(measured). It is not part of the integration.

## Where this comes from

- Anchor Platform 5.0.0 source at that tag (github.com/stellar/anchor-platform: `Dockerfile`, `scripts/docker-start.sh`,
  `anchor-config-default-values.yaml`, read 2026-11-19) for the entrypoint, the ports and the configuration keys;
  Docker Hub for the image digest.
- OpenTelemetry Java agent 2.33.1 documentation and the OpenTelemetry specification's SDK environment variables (read
  2026-11-19).
- Everything marked *measured* is run by our backend suite.
