# SPDX-License-Identifier: Apache-2.0
# Metrics only, to your UsageMap OTLP endpoint, configured by the standard OpenTelemetry environment variables:
#   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics
#   OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer%20<your ingest token>
#   OTEL_SERVICE_NAME=<the service name registered in the portal>
# Import it first: it installs the global MeterProvider the instrumentation records with.
from opentelemetry import metrics
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource

provider = MeterProvider(
    resource=Resource.create(),  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
    metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())],
)
metrics.set_meter_provider(provider)


def shutdown() -> None:
    """Export what is left and stop (call before the process exits)."""
    provider.shutdown()
