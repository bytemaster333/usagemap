// SPDX-License-Identifier: Apache-2.0
// Metrics only, to your UsageMap OTLP endpoint, configured by the standard OpenTelemetry environment variables:
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics
//   OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20<your ingest token>"
//   OTEL_SERVICE_NAME=<the service name registered in the portal>
// Imported first, so the global MeterProvider exists before anything records.
import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const provider = new MeterProvider({
  resource: resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME ?? "my-api" }),
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60_000),
    }),
  ],
});
metrics.setGlobalMeterProvider(provider);

/** Export what is left and stop (call before the process exits). */
export const shutdown = () => provider.shutdown();

// Flush the last counts when a server is stopped (containers stop with SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"])
  process.once(sig, () => {
    provider.shutdown().finally(() => process.exit(0));
  });
