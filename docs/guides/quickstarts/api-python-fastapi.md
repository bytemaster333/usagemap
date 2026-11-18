# API: Python / FastAPI (in-SDK dual export)

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: — the same recipe, in the sample service `tests/fixtures/api/python-fastapi/`, dual-exports to the gateway's OTLP front door in the end-to-end suite `tests/e2e/api/30-api.e2e.test.ts` (exact request counts asserted). Source: `spikes/s06a-dual-export-node-python/README.md` §3 and
"Recipe B.2" (app `apps/fastapi/otel_setup.py`, `app.py`). Read [api-common.md](api-common.md) first.

Measured with `OTEL_SEMCONV_STABILITY_OPT_IN=http`: UsageMap received `http.server.request.duration` (s, cumulative) with
`http.route` (`/accounts/{account_id}`) and no personal-data keys. Without the opt-in Python 0.66b2 sends legacy
`http.server.duration` in **ms**, with the route template only in `http.target` and `http.host` on the metric — still
accepted (the platform converts ms to s and reads the route template from `http.target`), but the stable mode is
cleaner.

## Requirements (as tested)

```text
opentelemetry-api==1.45.2
opentelemetry-sdk==1.45.2
opentelemetry-exporter-otlp-proto-http==1.45.2
opentelemetry-instrumentation-fastapi==0.66b2
```

Tested with CPython 3.13.5, fastapi 0.162.5, uvicorn 0.54.0. Set **`OTEL_SEMCONV_STABILITY_OPT_IN=http`** and leave
`OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_METRICS_HEADERS` **unset**.

## `otel_setup.py` — import before the app starts serving

```python
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

resource = Resource.create({"service.name": "my-api"})
apm_headers = {"api-key": os.environ["APM_API_KEY"]}
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[
    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint="https://apm.example/v1/metrics", headers=apm_headers)),
    PeriodicExportingMetricReader(OnlyHttpServer(OTLPMetricExporter(
        endpoint="https://ingest.scf.example/v1/metrics",
        headers={"Authorization": f"Bearer {os.environ['SCF_OTLP_TOKEN']}"}))),
]))
tp = TracerProvider(resource=resource)
tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="https://apm.example/v1/traces", headers=apm_headers)))
trace.set_tracer_provider(tp)
```

## `app.py` — flush on shutdown

```python
# uvicorn re-raises SIGTERM after its graceful shutdown, so atexit never runs
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
```

## Pitfalls the spike hit

1. **Mutating `sm.metrics = …` exports nothing**: SDK 1.45.2 point types are frozen dataclasses
   (`FrozenInstanceError` on every export). Build filtered copies with `dataclasses.replace`, as above.
2. **Filtering on the stable name only sends nothing** in default (legacy) mode; the filter above keeps both names.
3. **The last interval is lost on every restart** without the `lifespan` flush; runs shorter than the export interval
   delivered nothing. This also applies to `opentelemetry-instrument uvicorn …`.
4. **Exemplars** are attached by default (trace and span ids); the platform strips them before storage.
5. **Env headers leak**: `OTEL_EXPORTER_OTLP_HEADERS` is merged into the UsageMap exporter. Keep it unset.
