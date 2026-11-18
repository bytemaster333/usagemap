# API: Node.js / Express (in-SDK dual export)

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: — the same recipe, in the sample service `tests/fixtures/api/node-express/`, dual-exports to the gateway's OTLP front door in the end-to-end suite `tests/e2e/api/30-api.e2e.test.ts` (exact request counts asserted). Source: `spikes/s06a-dual-export-node-python/README.md` §1 and
"Recipe B.1" (app `apps/express/otel.mjs`). Read [api-common.md](api-common.md) first. The
[tenant Collector](api-collector-fanout.md) avoids the header hazard entirely.

Measured: UsageMap received metrics only — exactly `http.server.request.duration` (s, explicit histogram, cumulative,
`http.route` present), no canary values, count matching the requests sent.

## Dependencies (as tested)

`@opentelemetry/api@1.10.0`, `@opentelemetry/sdk-node@0.301.1`, `@opentelemetry/auto-instrumentations-node@0.83.0`,
`@opentelemetry/instrumentation@0.301.1` (a **direct** dependency under pnpm), `@opentelemetry/sdk-metrics@3.1.1`,
`@opentelemetry/sdk-trace@3.1.1`, `@opentelemetry/exporter-metrics-otlp-proto@0.301.1`,
`@opentelemetry/exporter-trace-otlp-proto@0.301.1`. Express 5.3.0, Node 24.19. These versions were younger than the
repository's 3-day minimum release age when tested; re-resolve them through your own policy.

## `otel.mjs`

```js
// otel.mjs
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
  serviceName: 'my-api',
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: 'https://apm.example/v1/traces', headers: apmHeaders }) })],
  metricReaders: [
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: 'https://apm.example/v1/metrics', headers: apmHeaders }) }),
    new PeriodicExportingMetricReader({
      exporter: onlyHttpServer(new OTLPMetricExporter({
        url: 'https://ingest.scf.example/v1/metrics',
        headers: { Authorization: `Bearer ${process.env.SCF_OTLP_TOKEN}` },
      })),
    }),
  ],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
```

Run:

```sh
OTEL_LOGS_EXPORTER=none node --import ./otel.mjs app.mjs
```

## Pitfalls the spike hit

1. **`new BatchSpanProcessor(exporter)` (positional) silently loses every APM span** with SDK 3.x; the constructor
   takes `{ exporter }`. The error is visible only with `OTEL_LOG_LEVEL=debug`.
2. **ESM without the loader hook:** Express is never patched and no `http.route` arrives — all requests collapse into
   one route per status.
3. **Leave `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_METRICS_HEADERS` unset**: the Node SDK merges them into the
   UsageMap exporter (a vendor key reached the stand-in). Configure APM headers in code as above.
4. Without `OTEL_LOGS_EXPORTER=none` the NodeSDK creates a default logs exporter.
5. `instrumentation-http` 0.220.0 and older emit legacy `http.server.duration` in ms; 0.221.0 and later emit only the
   stable metric (`OTEL_SEMCONV_STABILITY_OPT_IN=http/dup` is ignored). Both are accepted.
6. The NodeSDK's default resource detectors add `host.name`, `process.owner`, `process.command_args` and more. The
   platform drops them before storage; the tenant Collector removes them before they leave your network.
