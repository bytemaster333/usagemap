# Stellar RPC and Horizon calls (Python, py-stellar-base)

A Python script that calls Stellar RPC (`getHealth`, `getNetwork`) and Horizon (`/fee_stats`) on testnet with
`stellar-sdk` 17.0.1. Wrapping the SDK's HTTP client with `scf_stellar_otel` measures every call: latency per RPC
method and Horizon route, outcome class and network — never a URL, address, hash or XDR. Guide:
[Python / FastAPI §5](../../docs/onboarding/api-python-fastapi.md#5-optional-stellar-rpc-and-horizon-calls-py-stellar-base);
package: [`packages/stellar-otel-py`](../../packages/stellar-otel-py/README.md).

## Run it

1. **Install:** `cd examples/stellar-rpc-python && python3 -m venv .venv && .venv/bin/pip install --no-deps -r requirements.txt`
   (Python 3.10+; every package pinned exactly).
2. **Set your key:** in the portal, **Project → API services → Add**, then **Ingest tokens**:
   `export OTEL_SERVICE_NAME=my-python-backend OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20scfa_ing_…"`
3. **Run:** `PYTHONPATH=../../packages/stellar-otel-py/src .venv/bin/python main.py` → prints
   `rpc healthy, protocol …, fee p50 …` and exports once on exit. (`PYTHONPATH` until the package is on PyPI.)

## The lines that add UsageMap

`main.py`:

```python
import otel_setup
from scf_stellar_otel import HorizonClient, StellarRpcClient
# …
# UsageMap: pass the instrumented client to each server.
rpc = SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))
horizon = Server(HORIZON_URL, client=HorizonClient(network="testnet"))
```

`otel_setup.py` is a plain metrics-only OpenTelemetry setup configured by the standard `OTEL_*` variables; in a
FastAPI service, the [FastAPI recipe](../../docs/onboarding/api-python-fastapi.md)'s provider does the same job.

## What you'll see in the portal

**API services → my-python-backend → Stellar RPC/Horizon**: one `getHealth` and one `getNetwork` call and one
`GET /fee_stats`, testnet, with latency — your backend's outbound dependency health, never counted as API traffic.

## Test it without the app

The portal's API test (**Integrations → the card → Test**) sends one marked data point for your service through
the same endpoint. It is recorded as a baseline point in the service's data-quality table and never counted:

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-python-backend"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` installs `requirements.txt` (`--no-deps`, wheels only) and runs
`python main.py` in the pinned `python:3.13-alpine3.23` image against local stand-ins of Stellar RPC (recorded
testnet answers), Horizon and the UsageMap OTLP endpoint (protobuf). Same checks as the Node example: bearer token,
one point per method and route, no URL, key or forbidden attribute key.
