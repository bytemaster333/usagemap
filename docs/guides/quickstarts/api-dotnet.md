# API: .NET / ASP.NET Core (named OTLP exporters)

**Status (docs.quickstarts-run): measured in a spike, not yet against the real endpoint.** The UsageMap endpoint (OTLP front door, ingest tokens) is built and the Node, Python, Go and Rust recipes run against it in `tests/e2e/api/30-api.e2e.test.ts`; this recipe was measured only against the spike's stand-in endpoint. Source: `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`
(".NET 8+ (tested on 10)", app `apps/dotnet-minimal/Program.cs`). Read [api-common.md](api-common.md) first.

Tested: .NET SDK 10.0.404 / ASP.NET Core runtime 10.0.15, minimal API; `OpenTelemetry.Extensions.Hosting`,
`OpenTelemetry.Exporter.OpenTelemetryProtocol` and `OpenTelemetry.Instrumentation.AspNetCore` 1.21.0. Measured: UsageMap
received `http.server.request.duration` (s, 14 explicit bounds, cumulative) with `http.route` and `error.type` on 5xx.
Code `Headers` override environment headers (a wrong env `Authorization` and an env `api-key` did not reach UsageMap).

## Setup

```csharp
builder.Services.AddOpenTelemetry()
  .ConfigureResource(r => r.AddService("my-api"))          // adds service.instance.id
  .WithMetrics(m => m.AddAspNetCoreInstrumentation()
    .AddOtlpExporter("apm-metrics", o => { o.Endpoint = new Uri("https://apm.example/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "api-key=" + apmKey; })
    .AddOtlpExporter("scf", o => { o.Endpoint = new Uri("https://ingest.scf.example/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "Authorization=Bearer " + scfToken; }));
```

Notes:

- Give every `AddOtlpExporter` call its **own name** (the spike used `apm-traces`, `apm-metrics`, `scf`).
- Set `Protocol = HttpProtobuf` explicitly: the .NET default is gRPC, which was not tested against UsageMap.
- UsageMap also receives `http.server.active_requests` and the `aspnetcore.*` / `kestrel.*` metrics (no per-exporter metric
  filter in this setup); the platform drops them. `kestrel.*` carries the listen address in `server.address` — dropped.
- Unmatched requests have no route (marked `aspnetcore.request.is_unhandled=true`) and are counted under `{unknown}`.
- Traces stay with your APM (add your `WithTracing(...)` exporter as before); UsageMap needs only the metric.
