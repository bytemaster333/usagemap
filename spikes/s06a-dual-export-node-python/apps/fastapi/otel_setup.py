"""Recipe B.2 (in-SDK dual export, Python), as tested. Import before creating the app's server."""
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

APM = os.environ.get("APM_OTLP_URL", "https://apm.example")
SCF = os.environ.get("SCF_OTLP_URL", "https://ingest.scf.example")
# Both names: with the Python default (old) conventions only http.server.duration exists.
SCF_METRICS = tuple(os.environ.get("SCF_METRIC_NAMES", "http.server.request.duration,http.server.duration").split(","))


class OnlyHttpServer(MetricExporter):
    """Forward only the HTTP server duration metric to UsageMap."""

    def __init__(self, inner: OTLPMetricExporter):
        super().__init__(preferred_temporality=inner._preferred_temporality,
                         preferred_aggregation=inner._preferred_aggregation)
        self._inner = inner

    def export(self, metrics_data, timeout_millis: float = 10_000, **kw):
        # The SDK's point types are frozen dataclasses (1.45.2): build filtered copies, never mutate.
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


interval = int(os.environ.get("OTEL_METRIC_EXPORT_INTERVAL", "60000"))
resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "my-api")})
apm_headers = {"api-key": os.environ.get("APM_API_KEY", "")}
apm = OTLPMetricExporter(endpoint=f"{APM}/v1/metrics", headers=apm_headers)
scf = OnlyHttpServer(OTLPMetricExporter(endpoint=f"{SCF}/v1/metrics",
                                        headers={"Authorization": f"Bearer {os.environ['SCF_OTLP_TOKEN']}"}))
metrics.set_meter_provider(MeterProvider(
    resource=resource,
    metric_readers=[PeriodicExportingMetricReader(apm, export_interval_millis=interval),
                    PeriodicExportingMetricReader(scf, export_interval_millis=interval)],
))
tp = TracerProvider(resource=resource)
tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{APM}/v1/traces", headers=apm_headers)))
trace.set_tracer_provider(tp)
