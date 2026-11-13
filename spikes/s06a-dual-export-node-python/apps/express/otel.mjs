// SPDX-License-Identifier: Apache-2.0
// Recipe B.1 (in-SDK dual export), tested. Load first: node --import ./otel.mjs app.mjs
// ESM apps: the ESM loader hook must be registered, or express (imported via `import`) is never
// patched and http.route is missing from metrics and spans. Harmless for CommonJS apps.
import { register } from 'node:module';
if (process.env.S06A_NO_ESM_HOOK !== '1') register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';

const APM = process.env.APM_OTLP_URL ?? 'https://apm.example';
const SCF = process.env.SCF_OTLP_URL ?? 'https://ingest.scf.example';
const SCF_METRICS = ['http.server.request.duration', 'http.server.duration'];
const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000);

// Forward only the HTTP server duration metric to UsageMap (Views would also affect the APM reader).
function onlyHttpServer(inner) {
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

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'my-api',
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  spanProcessors: [
    // SDK 3.x: processors take an options object ({ exporter }); passing the exporter positionally fails silently.
    new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${APM}/v1/traces`, headers: { 'api-key': process.env.APM_API_KEY } }) }),
  ],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exportIntervalMillis: interval,
      exporter: new OTLPMetricExporter({ url: `${APM}/v1/metrics`, headers: { 'api-key': process.env.APM_API_KEY } }),
    }),
    new PeriodicExportingMetricReader({
      exportIntervalMillis: interval,
      exporter: onlyHttpServer(new OTLPMetricExporter({
        url: `${SCF}/v1/metrics`,
        headers: { Authorization: `Bearer ${process.env.SCF_OTLP_TOKEN}` },
      })),
    }),
  ],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
