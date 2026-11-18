# SPDX-License-Identifier: Apache-2.0
# Dual export: everything to your APM as before, plus a filtered copy (only the HTTP server duration metric) to UsageMap.
# Import it before the app. Leave OTEL_EXPORTER_OTLP_HEADERS unset: the Python SDK would merge it into the UsageMap
# exporter too (your vendor key would reach UsageMap).
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

APM = os.environ["APM_OTLP_ENDPOINT"]
SCF = os.environ["SCF_OTLP_ENDPOINT"]
# Both names: without OTEL_SEMCONV_STABILITY_OPT_IN=http the instrumentation sends only the older one.
SCF_METRICS = ("http.server.request.duration", "http.server.duration")


class OnlyHttpServer(MetricExporter):
    """Forwards only the HTTP server duration metric. The SDK's point types are frozen dataclasses: copy them."""

    def __init__(self, inner: OTLPMetricExporter):
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


resource = Resource.create()  # reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
apm_headers = {"api-key": os.environ["APM_API_KEY"]}
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[
    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{APM}/v1/metrics", headers=apm_headers)),
    PeriodicExportingMetricReader(OnlyHttpServer(OTLPMetricExporter(
        endpoint=f"{SCF}/v1/metrics",
        headers={"Authorization": f"Bearer {os.environ['SCF_OTLP_TOKEN']}"}))),
]))
tracer_provider = TracerProvider(resource=resource)
tracer_provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{APM}/v1/traces", headers=apm_headers)))
trace.set_tracer_provider(tracer_provider)
