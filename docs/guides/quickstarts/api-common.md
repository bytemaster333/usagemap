# API: rules for every stack

**Status (docs.quickstarts-run):** the UsageMap endpoint is built — ingest tokens (`createIngestToken`, portal **Ingest tokens**), the
gateway's OTLP front door, the Collector's sanitise step and the metrics writer — and the Node, Python, Go and Rust
recipes run against it in `tests/e2e/api/30-api.e2e.test.ts`. Everything below was first measured in spikes S-06a (`spikes/s06a-dual-export-node-python/README.md`) and S-06b
(`spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`) against a stand-in endpoint that required a bearer token, and
matches the ingest contract (`docs/contracts/wire-formats.md` §f) and the Collector's sanitise step
(`collector/README.md`).

## Endpoint and token

| | Value |
|---|---|
| Metrics | `POST https://ingest.scf.example/v1/metrics` (placeholder host) |
| Traces | `POST https://ingest.scf.example/v1/traces` |
| Logs | refused: `404` (gRPC `UNIMPLEMENTED`) — do not point a logs exporter at UsageMap |
| Encoding | OTLP/HTTP protobuf, optional gzip (tested). OTLP/gRPC and OTLP/JSON are accepted by the contract but were not tested in the spikes. |
| Auth | `Authorization: Bearer scfa_ing_<id>_<secret><crc>` — your ingest token, shown once in the portal (**Ingest tokens**) |
| Limits | compressed body ≤ 4 MiB, decompressed ≤ 16 MiB; `429` / `503` carry `Retry-After` and are retried by the SDKs and the Collector; `401` (bad/revoked token), `403` (tenant pending or suspended) are not retried |

## Dual export: keep your APM

Every recipe keeps your existing export (APM, vendor, your own Collector) unchanged and **adds** a second, filtered
export to UsageMap. Nothing in these recipes routes your APM traffic through UsageMap.

**Exemplars leak request details — switch them off (Java measured).** The OpenTelemetry Java agent 2.33.1 attaches
exemplars to every histogram point by default, with attributes such as `client.address` (from `X-Forwarded-For`),
`url.query`, `url.path`, `user_agent.original` and `network.peer.address` — even when traces are not exported. UsageMap
drops exemplars before storage, but a dual export sends them to your other backend unchanged. Set
`OTEL_METRICS_EXEMPLAR_FILTER=always_off` (env) or `meter_provider.exemplar_filter: always_off` (declarative file)
unless you deliberately want them there; for other SDKs, check their exemplar default before a dual export.

## Send only the HTTP server duration — or only root SERVER spans

- **Preferred:** the metric `http.server.request.duration` (seconds; legacy `http.server.duration` in ms is accepted
  and converted). Every SDK in the spikes sends it as an explicit-bucket histogram with the 14 default bounds.
- **Only for frameworks that produce no such metric (Next.js with `@vercel/otel`):** SERVER spans. The platform
  derives duration histograms from **local-root SERVER spans** only and discards the spans.
- **Not both for one service.** If a service sends the metric and its spans, it reaches UsageMap twice as two stream
  groups; the platform then uses one preferred group per service and day (C-22) and warns you, but filter on your side
  (the Collector recipe scopes the span branch to named services).
- **Why filter on your side at all:** the platform drops everything else before anything is stored (`scfsanitize`),
  but your spans and resources carry data you should not send anyone: the spikes found raw `url.query` (with an e-mail
  canary), `user_agent.original`, `client.address` taken from `X-Forwarded-For`, `server.address` from the `Host`
  header, `host.name`, `process.owner` and `process.command_args` in SDK defaults.

## Header hazards (measured)

| Stack | `OTEL_EXPORTER_OTLP_HEADERS` from the environment… |
|---|---|
| Node.js SDK, Python SDK (exporters configured in code) | is **merged** into the UsageMap exporter: your vendor key is sent to UsageMap. A code `Authorization` still wins over an env `authorization`. |
| Rust `opentelemetry-otlp` 0.33.1 | **overrides** the code's headers: an env `authorization` replaces the UsageMap token (`401`, all UsageMap data lost, a `WARN` only if a `tracing` subscriber is installed), and an env `api-key` is added to the UsageMap request. |
| Go, .NET, `@vercel/otel`, tenant Collector | not affected. |

So for in-SDK dual export from Node, Python and Rust: **leave `OTEL_EXPORTER_OTLP_HEADERS` and
`OTEL_EXPORTER_OTLP_METRICS_HEADERS` unset** and configure your APM headers in code — or use the
[tenant Collector](api-collector-fanout.md). The gateway reads only `Authorization`, answers a wrong or foreign bearer
with `401`, never logs header values, and forwards no other incoming header (wire-formats §f.2, §f.4).

## Set `service.instance.id`

Cumulative histograms are converted to deltas per stream. `service.instance.id` is **missing by default** in Go
(`resource.Default()`, `otelconf`), Rust, Next.js and the Java agent's declarative mode. The writer falls back to the
point's start time, so a restart is a new stream and nothing is lost (C-105, C-112(3)); still set a value unique per
replica — every recipe here does.

## Routes

- `http.route` from the framework is used when present; Next.js bracket routes (`/accounts/[id]`) become `{id}`.
- `http.route` values `""` (Rust `tracing` stack) and `/**` (Spring catch-all) count as **no route**; unmatched requests
  are counted under `{unknown}` (C-105, C-101).
- Identifier-shaped segments are folded (`{account}`, `{uuid}`, …) and secret-shaped ones become `{redacted}`; see
  `docs/metrics/definitions.md` §3.4.
- Errors are derived from `http.response.status_code` ≥ 500; Go and Rust send no `error.type` on 5xx.

## Flush on shutdown

Two stacks lose their last export interval on every restart unless you flush: Python under uvicorn (it re-raises
SIGTERM, so `atexit` never runs — flush in the FastAPI `lifespan`) and `next start` (exits on SIGTERM without flushing —
`NEXT_MANUAL_SIG_HANDLE=true` plus a flush). The recipes include the fix.

## Sampling

If you sample spans and use the span path, span-derived counts are estimates; a span with a sampling threshold counts
at most 1,024 times. The metric path is unaffected by span sampling.
