# scf-analytics-stellar-otel (Python)

OpenTelemetry metrics for **py-stellar-base** (`stellar-sdk` on PyPI, Apache-2.0) RPC and Horizon calls made by a
Python backend: latency per JSON-RPC method or Horizon route template, plus submission, poll and simulation outcome
classes. It has the same metric names and closed attribute sets as the JavaScript package `@usagemap/stellar-otel`, so
UsageMap's Collector (wire-formats §f.5 step 4a) accepts it unchanged. Addresses, hashes, XDR, keys, URLs, query
parameters and error text are never recorded.

**Supported:** `stellar-sdk` 13 to 17 (`BaseSyncClient` / `BaseAsyncClient` interface). **Tested:** 17.0.1, the
current major on 2026-11-19, with OpenTelemetry Python 1.45.2 on Python 3.13.

## Use

py-stellar-base's extension point is the `client` argument of its servers. Wrap the client you would use anyway:

```python
from stellar_sdk import Server, SorobanServer
from scf_stellar_otel import HorizonClient, StellarRpcClient

rpc = SorobanServer("https://soroban-testnet.stellar.org", client=StellarRpcClient(network="testnet"))
horizon = Server("https://horizon-testnet.stellar.org", client=HorizonClient(network="testnet"))
```

- The default inner client is the SDK's `RequestsClient`. Pass your own as the first argument, for example
  `StellarRpcClient(RequestsClient(post_timeout=10))`.
- Async: use `StellarRpcAsyncClient` / `HorizonAsyncClient` with `SorobanServerAsync` / `ServerAsync`. Their default
  `AiohttpClient` needs `stellar-sdk[aiohttp]`.
- `network` is a name (`mainnet`, `testnet`, `futurenet`, `local`) or a passphrase. If you omit it, the RPC client
  learns it from a `getNetwork` answer; Horizon stays `unknown`.
- `meter=` selects a `Meter`; the default is the global `MeterProvider`, which is the one you configured for your API
  ([Python FastAPI recipe](../../docs/onboarding/api-python-fastapi.md)).

| Metric | Unit | Attributes |
|---|---|---|
| `rpc.client.call.duration` | s | `rpc.system.name=jsonrpc`, `rpc.method` (13 methods or `_OTHER`), `error.type`, `rpc.status_code`, `stellar.network` |
| `http.client.request.duration` | s | `http.request.method`, `url.template` (50 Horizon templates or `_OTHER`), `http.response.status_code`, `error.type`, `stellar.network` |
| `stellar.tx.submissions` | {transaction} | `stellar.tx.via` (`rpc`/`horizon`), `stellar.tx.status`, `stellar.tx.result_class`, `stellar.network` |
| `stellar.tx.polls` | {call} | `stellar.tx.status`, `stellar.tx.result_class`, `stellar.network` |
| `stellar.tx.simulations` | {call} | `stellar.sim.outcome`, `stellar.sim.error_class`, `stellar.network` |

The wrappers never change a request or response. An exception from the inner client is re-raised unchanged, and a
failing meter is ignored. Event streams (`stream()`) are passed through without measurement.

## Tests

```sh
scripts/test.sh            # creates .venv with requirements-test.txt and runs pytest
```

The suite drives the real `SorobanServer`, `Server` and `RequestsClient` against a local mock. The mock replays RPC
answers recorded from the public testnet (`tests/fixtures/testnet-rpc.json`, the same recording as the JavaScript
package) and scripted Horizon answers; XDR results are built with the SDK's own XDR classes. It checks:

- that the closed sets equal the JavaScript package's (`test_sets_match.py`);
- that a full session exports only closed values (`test_otlp_export.py`);
- that the committed Collector fixture has the scenario's shape.

`scripts/collector_fixture.py` regenerates
`collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel-py.metrics.json`; the Collector test
`TestStellarPyFixtureGolden` sanitises it with step 4a on and checks that nothing is dropped.
