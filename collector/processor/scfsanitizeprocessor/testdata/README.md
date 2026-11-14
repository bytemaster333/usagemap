# scfsanitize test data

| Path | What | Source |
|---|---|---|
| `sdk/<sdk>.metrics.json`, `sdk/<sdk>.traces.json` | One OTLP JSON export request per SDK flavour, exactly as the SDK sent it to its APM | Spikes S-06a (`spikes/s06a-dual-export-node-python/out/apm/`) and S-06b (`spikes/s06b-dual-export-go-rust-jvm-dotnet/out/apm-*.jsonl`), runs of 2026-11-12 |
| `golden/<sdk>.{metrics,traces}.json` | The sanitised output for those inputs (reviewed) | `go test -run 'TestSDKFixtures(Metrics\|Traces)' -update` |
| `sdk/stellar-otel.metrics.json` | One OTLP/HTTP JSON export of `@usagemap/stellar-otel` 0.1.0 + OTel JS SDK 3.1.1 (js-stellar-sdk 17.4.0 against a mock RPC/Horizon replaying recorded testnet answers) | `pnpm --filter @usagemap/stellar-otel collector-fixture` (`packages/stellar-otel/test/scenario.ts`) |
| `golden/stellar-otel.metrics.json`, `golden/stellar-otel.enabled.metrics.json` | Its sanitised output with `stellar_client_metrics` off (default: drops only) and on (step 4a) | `go test -run 'TestSDKFixturesMetrics\|TestStellarFixtureGolden' -update` |
| `fuzz/FuzzSanitizeNoLeak/` | Fuzzer inputs that once failed (both were over-broad test patterns, not leaks) | `go test -fuzz=FuzzSanitizeNoLeak` |
| `gen/extract_sdk_fixtures.py` | Re-creates `sdk/` from the spike outputs (git-ignored; present only where the spikes ran) | — |

Fixtures: Node/Express (`@opentelemetry/sdk-node` 0.301, stable names; and with tenant env headers), Node 0.220
(legacy names, ms), Next.js (`@vercel/otel`, spans only, bracket routes, raw query in `http.target`), Python/FastAPI
0.66b2 (default: legacy `http.server.duration` in ms with the route in `http.target`, exemplars; and stable),
Go `otelhttp` 0.72, Rust `opentelemetry-instrumentation-tower` 0.19 (`http.route = ""` on unmatched paths) and
`tracing-opentelemetry`, Java agent 2.33 (`http.route = "/**"`), .NET 1.21 (`aspnetcore.*`/`kestrel.*` metrics).

Changes made by the extractor (and only these): values of resource attributes outside the §f.5 allow-list are
replaced by `CANARY-RES-<key>`; spans are thinned to at most three per (scope, kind, route/path, status); local
file-system paths in exception stack traces are replaced by `/CANARY-PATH`. Request paths such as
`/nope/unmatched-canary-path` were named by the spikes and are legitimate routes.
