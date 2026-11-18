# Already have an APM? Dual export

The per-stack pages send telemetry to UsageMap only, configured by environment variables. That is the easy path because
the OpenTelemetry environment variables describe **one** destination: one endpoint, one set of headers. If you already
export to an APM or vendor, you need a second, filtered export to UsageMap, and the environment variables can no longer
carry both.

## Recommended: your own Collector fans out

Point your services at an OpenTelemetry Collector you run; it sends everything to your APM and a filtered copy (the
HTTP server duration metric, or root SERVER spans) to UsageMap. Your services need no change beyond the Collector's
address, and no vendor key ever reaches UsageMap. Recipe: [tenant Collector fan-out](../guides/quickstarts/api-collector-fanout.md).

## In-SDK: a second exporter in code

Every recipe keeps your APM export unchanged and adds a second exporter with UsageMap's endpoint and token in code:

| Stack | Runnable example (tested) | Recipe |
|---|---|---|
| Node.js / Express | [`otel-dual-export.mjs`](../../examples/api-node-express/otel-dual-export.mjs) | [two metric readers](../guides/quickstarts/api-node-express.md) |
| Next.js | — | [`@vercel/otel`, SERVER spans only](../guides/quickstarts/api-nextjs.md) |
| Python / FastAPI | [`otel_dual_export.py`](../../examples/api-python-fastapi/otel_dual_export.py) | [filtered second reader](../guides/quickstarts/api-python-fastapi.md) |
| Go `net/http` | [`cmd/dual-export/main.go`](../../examples/api-go-nethttp/cmd/dual-export/main.go) | [filtered second reader](../guides/quickstarts/api-go.md) |
| Rust / axum | [`src/bin/dual-export.rs`](../../examples/api-rust-axum/src/bin/dual-export.rs) | [second periodic exporter](../guides/quickstarts/api-rust-axum.md) |
| Java / Spring Boot | [`otel/sdk.yaml`](../../examples/api-java-spring/otel/sdk.yaml) | [agent with a declarative file](api-java-spring.md#dual-export-agent-with-a-declarative-file) |
| Stellar Anchor Platform 5.x | [`otel-dual-export.env`](../../examples/api-anchor-platform/otel-dual-export.env) + the Java `sdk.yaml` | [configuration only](api-anchor-platform.md#already-have-an-apm) |
| .NET | — | [named OTLP exporters](../guides/quickstarts/api-dotnet.md) |

**What the examples prove.** The repository's backend suite runs each example against two local stand-ins, one for
your APM and one for UsageMap (which requires the bearer token): the APM receives its export with its own key; UsageMap receives
`/v1/metrics` only, with the UsageMap token, never the APM key, and the HTTP server duration metric with `http.route`, the
status code and the duration, counts equal to what the app answered, flushed on `SIGTERM`; no client address, user
agent or query string anywhere. UsageMap receives **only** that metric from Node, Python and Go (the examples filter);
from Rust (no filter possible in `opentelemetry` 0.33.1) it also gets three other `http.server.*` metrics, and from
the Java agent `jvm.*`, `otel.sdk.*` and `db.client.*` metrics. The platform drops all of these before storage. The Go
example configures the APM exporter from `OTEL_EXPORTER_OTLP_*`, header included, and that header never reached UsageMap.

**The one rule that matters:** with Node.js, Python or Rust, leave `OTEL_EXPORTER_OTLP_HEADERS` and
`OTEL_EXPORTER_OTLP_METRICS_HEADERS` **unset** and put your APM key in code. Measured: Node and Python merge those
variables into the UsageMap exporter (your vendor key would be sent to UsageMap), and Rust lets them override the UsageMap token (all
UsageMap data lost with `401`). Go, .NET, `@vercel/otel` and a Collector are not affected. Details:
[rules for every stack](../guides/quickstarts/api-common.md).
