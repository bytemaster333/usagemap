# Node.js / Express API: the first 10 minutes

**UsageMap-only, environment variables only, no code change.** If you do not export OpenTelemetry anywhere today, this is
your path: UsageMap is the only destination, so all configuration goes into environment variables. Already have an APM?
See [dual export](api-dual-export.md) instead.

**Tested:** the example service [`examples/api-node-express`](../../examples/api-node-express/) is started with
exactly this command (its `start:scf-only` script) by the repository's backend suite, against a local stand-in of the
UsageMap endpoint: requests with three status codes on `/accounts/:id`, then `SIGTERM`. UsageMap received the HTTP server
duration metric with `http.route`, the status code and the duration, request counts equal to what the app answered,
in one export sent on shutdown; no client address, user agent or query string anywhere in the payload.

| Minute | Step |
|---|---|
| 0–1 | Portal: **Add an API** → service name |
| 1–2 | Portal: **Ingest tokens** → create a token (shown once) |
| 2–4 | Add two packages |
| 4–6 | Start the app with the environment below |
| 6–10 | Send a few requests; after one export interval (60 s) the API wizard shows requests, status codes and latency |

## 1. Packages

```sh
pnpm add --save-exact @opentelemetry/auto-instrumentations-node@0.83.0 @opentelemetry/instrumentation@0.301.1
```

These are the versions our test suite runs (current on npm when this page was checked: 0.83.1 and 0.301.2), with
Express 5.3.0 on Node 24. No code imports them; they are loaded by the start command.

## 2. Start command

```sh
OTEL_SERVICE_NAME=my-api \
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${SCF_OTLP_TOKEN}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_METRICS_EXPORTER=otlp OTEL_TRACES_EXPORTER=none OTEL_LOGS_EXPORTER=none \
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${HOSTNAME}" \
node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
  --import @opentelemetry/auto-instrumentations-node/register app.mjs
```

| Variable | Why |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the UsageMap base URL; the SDK appends `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_HEADERS` | your ingest token. The header format is `key=value` with the value percent-encoded, so the space after `Bearer` is `%20` |
| `OTEL_METRICS_EXPORTER=otlp` | UsageMap uses the HTTP server duration metric |
| `OTEL_TRACES_EXPORTER=none` | sending spans as well would count the service twice; metrics are enough |
| `OTEL_LOGS_EXPORTER=none` | UsageMap does not accept logs (`404`) |
| `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=…` | one value per replica, so that restarts and replicas are told apart |

- `SCF_OTLP_TOKEN` is your ingest token (`scfa_ing_…`). Keep it in your platform's secret store.
- **CommonJS apps** (`require`): drop the `--experimental-loader` line and use `--require` instead of `--import`.
  **ESM apps** need the loader line: without it Express is never patched and requests arrive without their route.
  Node 24 prints an `ExperimentalWarning` for it; that is harmless.
- Optionally limit the instrumentations to what UsageMap uses:
  `OTEL_NODE_ENABLED_INSTRUMENTATIONS=http,express`. Measured without it: UsageMap also receives the `nodejs.*` and `v8js.*`
  runtime metrics and an HTTP client metric, and the resource carries `host.name`, `process.owner` and
  `process.command_args`. UsageMap drops all of these before storage; limit them here if they should not leave your host.
- The auto-instrumentation flushes on `SIGTERM` (measured: the only export of a short run arrived on shutdown). Give
  your platform's stop signal a few seconds of grace.

## 3. Check it

Send a few requests, wait a minute, then open the portal's API wizard (or the service's page). It shows requests per
route (`/accounts/{id}`), status codes and p50/p95 latency, and a data-quality table of what was received but not
kept (other metrics and attributes are dropped before storage, by design). Nothing arrives? See
[troubleshooting](troubleshooting.md#api-opentelemetry).

## Where this comes from

- The exact command, packages and versions run in our test suite twice: here, straight to a stand-in of the UsageMap
  endpoint (`examples/api-node-express`), and behind a tenant Collector against the real platform.
- Environment variables: OpenTelemetry specification, *SDK environment variables* and *OTLP exporter
  configuration* (opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ and
  opentelemetry.io/docs/specs/otel/protocol/exporter/, read 2026-11-16): the endpoint is a base URL with `v1/metrics`
  appended, default protocol `http/protobuf`, `none` disables an exporter, the metric export interval defaults to
  60,000 ms.
- `auto-instrumentations-node` README (github.com/open-telemetry/opentelemetry-js-contrib, read 2026-11-16) for the
  `register` entry and `OTEL_NODE_ENABLED_INSTRUMENTATIONS`; npm registry for the versions.
