// SPDX-License-Identifier: Apache-2.0
// Dual-export quickstarts per stack, as `getOtelConfig` answers them (OpenAPI `OtelConfig`), transcribed from the tested
// recipes of spikes/s06a-dual-export-node-python/README.md and spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md
// (C-102, C-105, wire-formats §f.2). The tenant keeps its own APM: every recipe exports twice — everything to the
// tenant's APM, only the HTTP server duration metric (or, for span-only stacks, only local-root SERVER spans, C-107)
// to UsageMap. Tokens are never embedded: the text carries `<INGEST_TOKEN>` (OpenAPI: "tokens are never re-displayed").
//
// The mock control plane serves these, and they are the reference for the control plane's generator: the portal
// renders whatever the API returns.

import type { ControlPlane } from "@usagemap/api-types";

export type Stack = "collector" | "node" | "nextjs" | "fastapi" | "go" | "rust" | "java" | "dotnet";

export const STACKS: { id: Stack; label: string }[] = [
  { id: "node", label: "Node.js / Express" },
  { id: "nextjs", label: "Next.js" },
  { id: "fastapi", label: "Python / FastAPI" },
  { id: "go", label: "Go (net/http)" },
  { id: "rust", label: "Rust (axum)" },
  { id: "java", label: "Java (OpenTelemetry agent)" },
  { id: "dotnet", label: ".NET (ASP.NET Core)" },
  { id: "collector", label: "Your own OpenTelemetry Collector" },
];

export const TOKEN_PLACEHOLDER = "<INGEST_TOKEN>";

/** Local-root SERVER spans only (S-04 §2 expression; C-107): anything true is dropped. */
const ROOT_SERVER_ONLY = [
  "- span.kind != SPAN_KIND_SERVER",
  "- not IsRootSpan() and (span.flags / 256) - (span.flags / 512) * 2 == 1 and (span.flags / 512) - (span.flags / 1024) * 2 == 0",
];

export function otelRecipe(
  stack: Stack,
  opts: { endpoint: string; serviceName: string },
): ControlPlane.OtelConfig {
  const ep = opts.endpoint;
  const svc = opts.serviceName;
  const env: Record<string, string> = {
    SCF_OTLP_TOKEN: TOKEN_PLACEHOLDER,
    OTEL_SERVICE_NAME: svc,
  };
  switch (stack) {
    case "collector":
      return {
        stack,
        files: [
          {
            filename: "otel-collector.yaml",
            content: `# otel/opentelemetry-collector-contrib:0.165.0 — fan-out: everything to your APM, only HTTP server
# durations (and local-root SERVER spans of span-only services) to UsageMap.
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
  # span branch: only for services that emit no HTTP server metric (e.g. Next.js); list them by name
  filter/scf_server_spans_only:
    error_mode: ignore
    trace_conditions:
      ${ROOT_SERVER_ONLY[0]}
      ${ROOT_SERVER_ONLY[1]}
      - not IsMatch(resource.attributes["service.name"], "^(my-next-app)$")
  transform/scf_minimal_span_attrs:
    error_mode: ignore
    trace_statements:
      - replace_pattern(span.attributes["http.target"], "\\\\?.*$", "")
      - keep_keys(span.attributes, ["http.route", "http.request.method", "http.response.status_code", "error.type", "url.path", "url.scheme", "http.method", "http.status_code", "http.target", "next.route"])
      - keep_keys(resource.attributes, ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name"])
exporters:
  otlp_http/apm:
    endpoint: https://apm.example
    headers: { api-key: "\${env:APM_API_KEY}" }
  otlp_http/scf:
    endpoint: ${ep}
    headers: { Authorization: "Bearer \${env:SCF_OTLP_TOKEN}" }
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
`,
          },
        ],
        env: { SCF_OTLP_TOKEN: TOKEN_PLACEHOLDER, APM_API_KEY: "<your APM key>" },
        notes: [
          "Recommended pattern: the only one that sends no request headers, host or process attributes to UsageMap.",
          "Point your services' SDKs at the Collector (OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318). Node ESM apps still need the instrumentation loader hook, or no http.route is recorded.",
          "Python: set OTEL_SEMCONV_STABILITY_OPT_IN=http on the service.",
          "Span-only services (such as Next.js) must be listed by name in filter/scf_server_spans_only; only their local-root SERVER spans reach UsageMap.",
          "Logs are never accepted by UsageMap; the logs pipeline goes to your APM only.",
        ],
      };
    case "node":
      return {
        stack,
        files: [
          {
            filename: "otel.mjs",
            content: `// Run: OTEL_LOGS_EXPORTER=none node --import ./otel.mjs app.mjs
import { register } from 'node:module';
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url); // ESM apps: without it, no http.route
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';

const SCF_METRICS = ['http.server.request.duration', 'http.server.duration'];
function onlyHttpServer(inner) {            // UsageMap reader gets only the HTTP server duration metric
  return {
    export(rm, cb) {
      const scopeMetrics = rm.scopeMetrics
        .map((sm) => ({ ...sm, metrics: sm.metrics.filter((m) => SCF_METRICS.includes(m.descriptor.name)) }))
        .filter((sm) => sm.metrics.length > 0);
      if (scopeMetrics.length === 0) return cb({ code: 0 });
      inner.export({ ...rm, scopeMetrics }, cb);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    selectAggregationTemporality: inner.selectAggregationTemporality?.bind(inner),
    selectAggregation: inner.selectAggregation?.bind(inner),
  };
}
const apmHeaders = { 'api-key': process.env.APM_API_KEY };
const sdk = new NodeSDK({
  serviceName: '${svc}',
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: 'https://apm.example/v1/traces', headers: apmHeaders }) })],
  metricReaders: [
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: 'https://apm.example/v1/metrics', headers: apmHeaders }) }),
    new PeriodicExportingMetricReader({
      exporter: onlyHttpServer(new OTLPMetricExporter({
        url: '${ep}/v1/metrics',
        headers: { Authorization: \`Bearer \${process.env.SCF_OTLP_TOKEN}\` },
      })),
    }),
  ],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
`,
          },
          {
            filename: "package.json (dependencies)",
            content: `"@opentelemetry/api": "1.10.0",
"@opentelemetry/sdk-node": "0.301.1",
"@opentelemetry/auto-instrumentations-node": "0.83.0",
"@opentelemetry/instrumentation": "0.301.1",
"@opentelemetry/sdk-metrics": "3.1.1",
"@opentelemetry/sdk-trace": "3.1.1",
"@opentelemetry/exporter-metrics-otlp-proto": "0.301.1",
"@opentelemetry/exporter-trace-otlp-proto": "0.301.1"
`,
          },
        ],
        env: { ...env, OTEL_LOGS_EXPORTER: "none" },
        notes: [
          "Leave OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_METRICS_HEADERS unset: the SDK would send them to UsageMap too.",
          "ESM apps must register the instrumentation loader hook (first lines of otel.mjs), or Express is never patched and no route is recorded.",
          "Only the HTTP server duration metric goes to UsageMap; traces and all other metrics go to your APM only.",
        ],
      };
    case "nextjs":
      return {
        stack,
        files: [
          {
            filename: "instrumentation.js",
            content: `// Next.js 16 + @vercel/otel 2.3 (OTel JS 2.x: @opentelemetry/sdk-trace-base 2.12.1, @opentelemetry/api 1.10.0)
import { registerOTel, OTLPHttpProtoTraceExporter } from '@vercel/otel';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanKind, trace } from '@opentelemetry/api';

class LocalRootServerSpansOnly {              // UsageMap needs local-root SERVER spans only
  constructor(inner) { this.inner = inner; }
  export(spans, done) {
    const roots = spans.filter((s) => s.kind === SpanKind.SERVER && (!s.parentSpanContext || s.parentSpanContext.isRemote));
    if (roots.length === 0) return done({ code: 0 });
    this.inner.export(roots, done);
  }
  shutdown() { return this.inner.shutdown(); }
  forceFlush() { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}
export function register() {
  registerOTel({
    serviceName: '${svc}',
    spanProcessors: [
      'auto',                                  // existing export (Vercel or OTEL_EXPORTER_OTLP_* env)
      new BatchSpanProcessor(new LocalRootServerSpansOnly(new OTLPHttpProtoTraceExporter({
        url: '${ep}/v1/traces',
        headers: { Authorization: \`Bearer \${process.env.SCF_OTLP_TOKEN}\` },
      }))),
    ],
  });
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_MANUAL_SIG_HANDLE === 'true') {
    process.once('SIGTERM', async () => {     // next start would exit without flushing
      const tp = trace.getTracerProvider();
      try { await (tp.getDelegate?.() ?? tp).forceFlush?.(); } finally { process.exit(0); }
    });
  }
}
`,
          },
        ],
        env: { ...env, NEXT_MANUAL_SIG_HANDLE: "true" },
        notes: [
          "Next.js sends spans only; UsageMap turns local-root SERVER spans into the request metric and never stores a span.",
          "Start the node process directly (node node_modules/next/dist/bin/next start) with NEXT_MANUAL_SIG_HANDLE=true, or buffered spans are lost on SIGTERM.",
          "Bracket routes such as /accounts/[id] are converted to /accounts/{id}; query strings are removed before anything is stored.",
        ],
      };
    case "fastapi":
      return {
        stack,
        files: [
          {
            filename: "otel_setup.py",
            content: `# otel_setup.py — import before the app starts serving
import os
from dataclasses import replace
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

SCF_METRICS = ("http.server.request.duration", "http.server.duration")

class OnlyHttpServer(MetricExporter):
    """Forward only the HTTP server duration metric to UsageMap (point types are frozen: copy, never mutate)."""
    def __init__(self, inner):
        super().__init__(preferred_temporality=inner._preferred_temporality,
                         preferred_aggregation=inner._preferred_aggregation)
        self._inner = inner
    def export(self, metrics_data, timeout_millis: float = 10_000, **kw):
        rms = []
        for rm in metrics_data.resource_metrics:
            sms = [replace(sm, metrics=[m for m in sm.metrics if m.name in SCF_METRICS]) for sm in rm.scope_metrics]
            sms = [sm for sm in sms if sm.metrics]
            if sms:
                rms.append(replace(rm, scope_metrics=sms))
        if not rms:
            return MetricExportResult.SUCCESS
        return self._inner.export(replace(metrics_data, resource_metrics=rms), timeout_millis=timeout_millis)
    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        return self._inner.force_flush(timeout_millis)
    def shutdown(self, timeout_millis: float = 30_000, **kw) -> None:
        self._inner.shutdown(timeout_millis=timeout_millis)

resource = Resource.create({"service.name": "${svc}"})
apm_headers = {"api-key": os.environ["APM_API_KEY"]}
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[
    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint="https://apm.example/v1/metrics", headers=apm_headers)),
    PeriodicExportingMetricReader(OnlyHttpServer(OTLPMetricExporter(
        endpoint="${ep}/v1/metrics",
        headers={"Authorization": f"Bearer {os.environ['SCF_OTLP_TOKEN']}"}))),
]))
tp = TracerProvider(resource=resource)
tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="https://apm.example/v1/traces", headers=apm_headers)))
trace.set_tracer_provider(tp)
`,
          },
          {
            filename: "app.py",
            content: `# app.py — flush on shutdown (uvicorn re-raises SIGTERM, so atexit never runs)
from contextlib import asynccontextmanager
from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

@asynccontextmanager
async def lifespan(_app):
    yield
    for p in (trace.get_tracer_provider(), metrics.get_meter_provider()):
        getattr(p, "shutdown", lambda: None)()

app = FastAPI(lifespan=lifespan)
FastAPIInstrumentor.instrument_app(app)
`,
          },
          {
            filename: "requirements.txt",
            content:
              "opentelemetry-api==1.45.2\nopentelemetry-sdk==1.45.2\nopentelemetry-exporter-otlp-proto-http==1.45.2\nopentelemetry-instrumentation-fastapi==0.66b2\n",
          },
        ],
        env: { ...env, OTEL_SEMCONV_STABILITY_OPT_IN: "http" },
        notes: [
          "Set OTEL_SEMCONV_STABILITY_OPT_IN=http: without it Python sends the old metric (milliseconds, route in http.target).",
          "Leave OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_METRICS_HEADERS unset: the SDK would send them to UsageMap too.",
          "Flush in the lifespan handler, as in app.py, or the last minute of data is lost on shutdown.",
        ],
      };
    case "go":
      return {
        stack,
        files: [
          {
            filename: "otel.go",
            content: `// go.opentelemetry.io/otel v1.47.0 (sdk, sdk/metric, exporters/otlp/otlpmetric/otlpmetrichttp),
// go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.72.0
type onlyHTTPServer struct{ sdkmetric.Exporter }

func (e onlyHTTPServer) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
	out := metricdata.ResourceMetrics{Resource: rm.Resource}
	for _, sm := range rm.ScopeMetrics {
		var keep []metricdata.Metrics
		for _, m := range sm.Metrics {
			if m.Name == "http.server.request.duration" {
				keep = append(keep, m)
			}
		}
		if len(keep) > 0 {
			sm.Metrics = keep
			out.ScopeMetrics = append(out.ScopeMetrics, sm)
		}
	}
	if len(out.ScopeMetrics) == 0 {
		return nil
	}
	return e.Exporter.Export(ctx, &out)
}

func setupOTel(ctx context.Context) (*sdkmetric.MeterProvider, error) {
	res, _ := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK()) // service.instance.id
	apm, err := otlpmetrichttp.New(ctx) // your APM, from OTEL_EXPORTER_OTLP_* env
	if err != nil {
		return nil, err
	}
	scf, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL("${ep}/v1/metrics"),
		otlpmetrichttp.WithHeaders(map[string]string{"Authorization": "Bearer " + os.Getenv("SCF_OTLP_TOKEN")}))
	if err != nil {
		return nil, err
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(apm)),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(onlyHTTPServer{scf})))
	otel.SetMeterProvider(mp)
	return mp, nil // defer mp.Shutdown(context.Background())
}

// mux := http.NewServeMux()
// mux.HandleFunc("GET /accounts/{id}", getAccount) // pattern => http.route
// http.ListenAndServe(":8080", otelhttp.NewHandler(mux, "api"))
`,
          },
        ],
        env,
        notes: [
          "Register handlers with method and path patterns (GET /accounts/{id}); the pattern becomes the route.",
          "resource.WithService() adds service.instance.id, which Go does not set by default.",
          "Go does not merge environment headers into WithHeaders, so your APM's OTEL_EXPORTER_OTLP_HEADERS stay with your APM.",
        ],
      };
    case "rust":
      return {
        stack,
        files: [
          {
            filename: "Cargo.toml (dependencies)",
            content: `opentelemetry = "0.33.1"
opentelemetry_sdk = "0.33.1"
opentelemetry-otlp = { version = "0.33.1", features = ["reqwest-rustls"] }   # without it: no https
opentelemetry-instrumentation-tower = { version = "0.19.0", features = ["axum"] }   # 'axum' is NOT default
tracing-subscriber = { version = "0.3", features = ["env-filter"] }         # to see export errors
`,
          },
          {
            filename: "main.rs (excerpt)",
            content: `let scf = MetricExporter::builder().with_http()
    .with_endpoint("${ep}/v1/metrics")                                    // full URL incl. /v1/metrics
    .with_headers(HashMap::from([("Authorization".into(), format!("Bearer {}", std::env::var("SCF_OTLP_TOKEN")?))]))
    .build()?;
let mp = SdkMeterProvider::builder().with_resource(Resource::builder().build())
    .with_periodic_exporter(apm).with_periodic_exporter(scf).build();
global::set_meter_provider(mp.clone());                                   // before building the layer
tracing_subscriber::registry().with(EnvFilter::new("warn")).with(tracing_subscriber::fmt::layer()).init();
let app = Router::new().route("/accounts/{id}", get(account))
    .layer(opentelemetry_instrumentation_tower::http::server::Layer::new()); // after the routes
// on exit (blocking client): tokio::task::spawn_blocking(move || mp.shutdown()).await
`,
          },
        ],
        env: { ...env, OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=<unique per replica>" },
        notes: [
          "Unset OTEL_EXPORTER_OTLP_HEADERS and OTEL_EXPORTER_OTLP_METRICS_HEADERS: in Rust they replace the UsageMap token in code and would send your APM key to UsageMap. Configure your APM headers in code, or use your own Collector.",
          "Set OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<unique per replica>.",
          "The image needs ca-certificates for https.",
          "With the tracing stack (spans only), prefer your own Collector with the SERVER-span filter.",
        ],
      };
    case "java":
      return {
        stack,
        files: [
          {
            filename: "sdk.yaml",
            content: `# OTEL_CONFIG_FILE for the OpenTelemetry Java agent 2.33.1. \${VAR} is substituted from the environment.
# Run: java -javaagent:opentelemetry-javaagent.jar -jar app.jar   (with OTEL_CONFIG_FILE=/etc/otel/sdk.yaml)
file_format: "1.2"
resource:
  attributes:
    - name: service.name
      value: \${OTEL_SERVICE_NAME}
  detection/development:
    detectors:
      - service:          # adds service.instance.id
tracer_provider:
  processors:
    - batch:
        exporter:
          otlp_http:
            endpoint: \${APM_ENDPOINT}/v1/traces
            headers: [ { name: api-key, value: "\${APM_API_KEY}" } ]
meter_provider:
  readers:
    - periodic:
        interval: 5000
        exporter:
          otlp_http:
            endpoint: \${APM_ENDPOINT}/v1/metrics
            headers: [ { name: api-key, value: "\${APM_API_KEY}" } ]
    - periodic:
        interval: 5000
        exporter:
          otlp_http:
            endpoint: ${ep}/v1/metrics
            headers: [ { name: Authorization, value: "Bearer \${SCF_OTLP_TOKEN}" } ]
            temporality_preference: cumulative
            default_histogram_aggregation: explicit_bucket_histogram
logger_provider:
  processors:
    - batch:
        exporter:
          otlp_http:
            endpoint: \${APM_ENDPOINT}/v1/logs
            headers: [ { name: api-key, value: "\${APM_API_KEY}" } ]
propagator:
  composite: [ { tracecontext: }, { baggage: } ]
`,
          },
        ],
        env: {
          ...env,
          OTEL_CONFIG_FILE: "/etc/otel/sdk.yaml",
          APM_ENDPOINT: "https://apm.example",
          APM_API_KEY: "<your APM key>",
        },
        notes: [
          "The agent's other metrics also reach UsageMap and are dropped there by the allow-list; only http.server.request.duration is stored.",
          "Never point the agent's single OTLP endpoint at UsageMap: logs would be refused (404). Use this file or your own Collector.",
        ],
      };
    case "dotnet":
      return {
        stack,
        files: [
          {
            filename: "Program.cs (excerpt)",
            content: `// OpenTelemetry.Extensions.Hosting, OpenTelemetry.Exporter.OpenTelemetryProtocol,
// OpenTelemetry.Instrumentation.AspNetCore 1.21.0 (.NET 8+)
var apmKey = Environment.GetEnvironmentVariable("APM_API_KEY");
var scfToken = Environment.GetEnvironmentVariable("SCF_OTLP_TOKEN");
builder.Services.AddOpenTelemetry()
  .ConfigureResource(r => r.AddService("${svc}"))          // adds service.instance.id
  .WithMetrics(m => m.AddAspNetCoreInstrumentation()
    .AddOtlpExporter("apm-metrics", o => { o.Endpoint = new Uri("https://apm.example/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "api-key=" + apmKey; })
    .AddOtlpExporter("scf", o => { o.Endpoint = new Uri("${ep}/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "Authorization=Bearer " + scfToken; }));
`,
          },
        ],
        env: { SCF_OTLP_TOKEN: TOKEN_PLACEHOLDER, APM_API_KEY: "<your APM key>" },
        notes: [
          "Set Protocol = HttpProtobuf explicitly: the .NET default is gRPC.",
          "Framework metrics such as aspnetcore.* and kestrel.* are dropped by UsageMap's allow-list; only the request duration is stored.",
        ],
      };
  }
}
