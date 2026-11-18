// SPDX-License-Identifier: Apache-2.0
// Dual export: everything to your APM as before, plus a filtered copy (only the HTTP server duration metric) to UsageMap.
// Leave OTEL_EXPORTER_OTLP_HEADERS unset: the Node SDK would merge it into the UsageMap exporter too.
import { register } from "node:module";

register("@opentelemetry/instrumentation/hook.mjs", import.meta.url); // ESM apps: without it, no http.route

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";

const { APM_OTLP_ENDPOINT, APM_API_KEY, SCF_OTLP_ENDPOINT, SCF_OTLP_TOKEN } = process.env;
const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000);

const SCF_METRICS = ["http.server.request.duration", "http.server.duration"];
function onlyHttpServer(inner) {
  return {
    export(rm, cb) {
      const scopeMetrics = rm.scopeMetrics
        .map((sm) => ({
          ...sm,
          metrics: sm.metrics.filter((m) => SCF_METRICS.includes(m.descriptor.name)),
        }))
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

const apmHeaders = { "api-key": APM_API_KEY };
const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } }),
  ],
  spanProcessors: [
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter({
        url: `${APM_OTLP_ENDPOINT}/v1/traces`,
        headers: apmHeaders,
      }),
    }),
  ],
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${APM_OTLP_ENDPOINT}/v1/metrics`,
        headers: apmHeaders,
      }),
      exportIntervalMillis: interval,
    }),
    new PeriodicExportingMetricReader({
      exporter: onlyHttpServer(
        new OTLPMetricExporter({
          url: `${SCF_OTLP_ENDPOINT}/v1/metrics`,
          headers: { Authorization: `Bearer ${SCF_OTLP_TOKEN}` },
        }),
      ),
      exportIntervalMillis: interval,
    }),
  ],
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
