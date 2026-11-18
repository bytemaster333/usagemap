// SPDX-License-Identifier: Apache-2.0
// Metrics only, to the UsageMap OTLP endpoint, configured by the standard OpenTelemetry environment variables:
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://<your ingest host>/v1/metrics
//   OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20<SCF_OTLP_TOKEN>"
//   OTEL_SERVICE_NAME=paid-api
// Loaded with `node --import ./otel.mjs server.mjs`, so the global MeterProvider exists before the server starts.
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const provider = new MeterProvider({
  resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "paid-api" }),
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000),
    }),
  ],
});
metrics.setGlobalMeterProvider(provider);

// Flush the last counts on shutdown (containers stop with SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"])
  process.once(sig, () => {
    provider.shutdown().finally(() => process.exit(0));
  });
