# Python / FastAPI API: the first 10 minutes

**UsageMap-only, environment variables only.** Zero-code instrumentation with `opentelemetry-instrument`; the only code is
a three-line flush on shutdown. Already have an APM? See [dual export](api-dual-export.md).

**Tested:** the example service [`examples/api-python-fastapi`](../../examples/api-python-fastapi/) runs with this
start command in the repository's backend suite (Python 3.13), against a local stand-in of the UsageMap endpoint: requests
with three status codes, then `SIGTERM`. UsageMap received `http.server.request.duration` with `http.route`, the status
code and the duration, counts equal to what the app answered, in the one export the `lifespan` flush sent on
shutdown; no client address, user agent or query string anywhere in the payload.

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API**, then **Ingest tokens** → create a token |
| 2–4 | Install three packages |
| 4–5 | Add the shutdown flush |
| 5–10 | Start with the environment below; the API wizard shows data after one export interval (60 s) |

## 1. Packages

```text
opentelemetry-distro==0.66b2
opentelemetry-exporter-otlp-proto-http==1.45.2
opentelemetry-instrumentation-fastapi==0.66b2
```

Install them with `pip install -r requirements.txt` (versions current on PyPI on 2026-11-16; SDK 1.45.2 and
instrumentation 0.66b2 are the ones our test suite runs, with fastapi 0.162.5 and uvicorn 0.54.0). The example's
`requirements.txt` pins every transitive package exactly, as tested.

## 2. Flush on shutdown

uvicorn re-raises SIGTERM after its graceful shutdown, so `atexit` handlers never run and the last export interval is
lost on every restart. Flush in the FastAPI `lifespan`, as the example's `app.py` does:

```python
# The tenant's API: one route, plus the flush on shutdown that uvicorn needs (it re-raises SIGTERM, so atexit
# handlers never run and the last export interval would be lost on every restart).
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from opentelemetry import metrics, trace


@asynccontextmanager
async def lifespan(_app):
    yield
    for provider in (trace.get_tracer_provider(), metrics.get_meter_provider()):
        getattr(provider, "shutdown", lambda: None)()


app = FastAPI(lifespan=lifespan)


@app.get("/accounts/{account_id}")
async def account(account_id: str):
    if account_id == "GMISSING":
        return JSONResponse({"error": "account not found"}, status_code=404)
    if account_id == "GBOOM":
        return JSONResponse({"error": "internal"}, status_code=500)
    return {"id": account_id}
```

## 3. Start command

```sh
OTEL_SERVICE_NAME=my-api \
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example \
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${SCF_OTLP_TOKEN}" \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_METRICS_EXPORTER=otlp OTEL_TRACES_EXPORTER=none OTEL_LOGS_EXPORTER=none \
OTEL_SEMCONV_STABILITY_OPT_IN=http \
OTEL_RESOURCE_ATTRIBUTES="service.instance.id=${HOSTNAME}" \
opentelemetry-instrument uvicorn app:app --host 0.0.0.0 --port 8000
```

- `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` is required: the Python agent's `otlp` exporter otherwise uses gRPC.
- `OTEL_METRICS_EXPORTER` must be set explicitly for the Python agent.
- `OTEL_SEMCONV_STABILITY_OPT_IN=http` makes the instrumentation send the stable `http.server.request.duration` (in
  seconds, with `http.route`). Without it you get the older `http.server.duration` in milliseconds, which UsageMap also
  accepts and converts.
- `OTEL_TRACES_EXPORTER=none`: metrics are enough; sending spans too would count the service twice.

## 4. Check it

After a minute the API wizard shows requests per route (`/accounts/{account_id}`), status codes and latency. The
instrumentation also sends `http.server.active_requests` and `http.server.response.body.size` (measured); UsageMap drops
them before storage.
Nothing? See [troubleshooting](troubleshooting.md#api-opentelemetry).

## 5. Optional: Stellar RPC and Horizon calls (py-stellar-base)

If your API calls Stellar RPC or Horizon with `stellar-sdk`, wrap the SDK's HTTP client with
[`scf-analytics-stellar-otel`](../../packages/stellar-otel-py/README.md). You then see latency per RPC method and
Horizon route, and the submit, poll and simulate outcomes, in the portal's "Stellar RPC/Horizon" panel:

```python
from stellar_sdk import SorobanServer
from scf_stellar_otel import StellarRpcClient

rpc = SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))
```

The metrics are the same as those of the JavaScript package. No address, hash, XDR or URL is recorded.

## Where this comes from

- OpenTelemetry Python zero-code documentation (opentelemetry.io/docs/zero-code/python/ and its configuration page,
  read 2026-11-16): `opentelemetry-instrument`, the `http/protobuf` switch, the metrics exporter that must be named.
- OpenTelemetry specification, SDK environment variables and OTLP exporter configuration (read 2026-11-16).
- PyPI for the versions. The start command, the lifespan flush and the semantic-convention switch are run by our
  test suite (`examples/api-python-fastapi`).
