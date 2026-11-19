# SPDX-License-Identifier: Apache-2.0
"""A realistic backend session through the real py-stellar-base servers: RPC reads, submissions with several
statuses, polls, simulations, an HTTP failure, an unknown method, Horizon reads and a failed submission. Encoded as
one OTLP/HTTP JSON export request exactly as the OpenTelemetry Python SDK's OTLP exporter would send it. Used by
``test_otlp_export.py`` and by ``scripts/collector_fixture.py`` (the Collector's SDK fixture for its golden tests)."""

from __future__ import annotations

import contextlib

from conftest import ACCOUNT, API_KEY, HASH, RECORDED, Answer, Mock, bad_seq, serve_mock, trapped
from google.protobuf.json_format import MessageToJson
from opentelemetry.exporter.otlp.proto.common.metrics_encoder import encode_metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import Resource
from stellar_sdk import Server, SorobanServer
from stellar_sdk.exceptions import BaseRequestError
from test_rpc import envelope

from scf_stellar_otel import SCOPE_NAME, SCOPE_VERSION, HorizonClient, StellarRpcClient

LEDGER = {"latestLedger": 5812068, "latestLedgerCloseTime": "1795083980"}


def _session(m: Mock, meter) -> None:
    rpc = SorobanServer(f"{m.url}/rpc/{API_KEY}?apikey={API_KEY}", client=StellarRpcClient(meter=meter))
    rpc.get_network()
    rpc.get_health()
    for status in ("PENDING", "TRY_AGAIN_LATER", "ERROR"):
        ans = {"status": status, "hash": HASH, **LEDGER}
        if status == "ERROR":
            ans["errorResultXdr"] = bad_seq()
        m.rpc["sendTransaction"] = ans
        rpc.send_transaction(envelope())
    rpc.get_transaction(HASH)
    m.rpc["getTransaction"] = dict(RECORDED["getTransactionNotFound"]["result"], status="FAILED", resultXdr=trapped())
    rpc.get_transaction(HASH)
    rpc.simulate_transaction(envelope())
    m.rpc["simulateTransaction"] = {"error": f"HostError: Error(Contract, #3) {ACCOUNT}", "latestLedger": 1}
    rpc.simulate_transaction(envelope())
    m.rpc["getFeeStats"] = lambda _p: Answer(503, "down")
    with contextlib.suppress(BaseRequestError):
        rpc.get_fee_stats()
    rpc._client.post(rpc.server_url, json_data={"jsonrpc": "2.0", "id": 9, "method": "getSomethingElse"})

    def horizon(verb: str, path: str) -> Answer | None:
        p = path.removeprefix(f"/{API_KEY}")
        if verb == "GET" and p == "/fee_stats":
            return Answer(200, {"last_ledger": "1"})
        if verb == "GET" and p.startswith("/accounts/"):
            return Answer(200, {"_embedded": {"records": []}, "_links": {}})
        if verb == "POST" and p == "/transactions":
            return Answer(400, {"type": "tx_failed", "extras": {"result_codes": {"transaction": "tx_bad_seq"}}})
        return None

    m.horizon = horizon
    hz = Server(f"{m.url}/{API_KEY}/", client=HorizonClient(meter=meter, network="testnet"))
    hz.fee_stats().call()
    hz.payments().for_account(ACCOUNT).cursor("now").call()
    with contextlib.suppress(BaseRequestError):
        hz.submit_transaction(envelope(), skip_memo_required_check=True)


def run_scenario() -> str:
    """Run the session and return the OTLP/HTTP JSON body of one export request."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader],
        resource=Resource.create({"service.name": "stellar-dapp-api-py", "deployment.environment.name": "test"}),
    )
    try:
        with serve_mock() as m:
            _session(m, provider.get_meter(SCOPE_NAME, SCOPE_VERSION))
        data = reader.get_metrics_data()
    finally:
        provider.shutdown()
    assert data is not None
    # OTLP JSON (opentelemetry-proto JSON mapping): lowerCamelCase field names, enums as integers.
    return MessageToJson(encode_metrics(data), use_integers_for_enums=True, indent=1) + "\n"
