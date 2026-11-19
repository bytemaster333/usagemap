# SPDX-License-Identifier: Apache-2.0
"""StellarRpcClient behind the real py-stellar-base SorobanServer and RequestsClient, against a local mock that
replays recorded testnet answers."""

from __future__ import annotations

import time

import pytest
from conftest import ACCOUNT, API_KEY, HASH, RECORDED, SEED, Answer, archived, bad_seq, trapped
from stellar_sdk import Account, Keypair, Network, SorobanServer, TransactionBuilder
from stellar_sdk.client.requests_client import RequestsClient
from stellar_sdk.exceptions import BaseRequestError, ConnectionError, SorobanRpcErrorResponse

from scf_stellar_otel import StellarRpcClient

LEDGER = {"latestLedger": 5812068, "latestLedgerCloseTime": "1795083980"}


def server(mock, metrics, **kw) -> SorobanServer:
    # An API key in the path and the query of the RPC URL: neither may be recorded.
    url = f"{mock.url}/rpc/{API_KEY}?apikey={API_KEY}"
    return SorobanServer(url, client=StellarRpcClient(meter=metrics.meter, **kw))


def envelope():
    kp = Keypair.from_raw_ed25519_seed(bytes(range(32)))  # a fixed test key
    tx = (
        TransactionBuilder(Account(kp.public_key, 1), Network.TESTNET_NETWORK_PASSPHRASE, base_fee=100)
        .append_bump_sequence_op(2)
        .set_timeout(30)
        .build()
    )
    tx.sign(kp)
    return tx


def test_reads_learn_the_network(mock, metrics):
    s = server(mock, metrics)
    s.get_health()  # before getNetwork: unknown
    s.get_network()
    s.get_fee_stats()
    s.get_version_info()
    assert metrics.attrs("rpc.client.call.duration") == [
        {"rpc.system.name": "jsonrpc", "rpc.method": "getFeeStats", "stellar.network": "testnet"},
        {"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "stellar.network": "unknown"},
        {"rpc.system.name": "jsonrpc", "rpc.method": "getNetwork", "stellar.network": "testnet"},  # learnt from its own answer
        {"rpc.system.name": "jsonrpc", "rpc.method": "getVersionInfo", "stellar.network": "testnet"},
    ]
    for _, p in metrics.points("rpc.client.call.duration"):
        assert p.count == 1
        assert list(p.explicit_bounds) == [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0]
        assert 0 <= p.sum < 5


def test_fixed_network_wins_over_get_network(mock, metrics):
    mock.rpc["getNetwork"] = {"passphrase": "Public Global Stellar Network ; September 2015", "protocolVersion": 23}
    s = server(mock, metrics, network="Test SDF Network ; September 2015")
    s.get_network()
    assert metrics.attrs("rpc.client.call.duration")[0]["stellar.network"] == "testnet"


@pytest.mark.parametrize(
    ("answer", "want"),
    [
        ({"status": "PENDING"}, {"stellar.tx.status": "PENDING"}),
        ({"status": "DUPLICATE"}, {"stellar.tx.status": "DUPLICATE"}),
        ({"status": "TRY_AGAIN_LATER"}, {"stellar.tx.status": "TRY_AGAIN_LATER"}),
        ({"status": "ERROR", "errorResultXdr": None}, {"stellar.tx.status": "ERROR", "stellar.tx.result_class": "bad_seq"}),
    ],
)
def test_send_transaction_statuses(mock, metrics, answer, want):
    if answer.get("errorResultXdr", 0) is None:
        answer = {**answer, "errorResultXdr": bad_seq()}
    mock.rpc["sendTransaction"] = {**answer, "hash": HASH, **LEDGER}
    s = server(mock, metrics, network="testnet")
    s.send_transaction(envelope())
    assert metrics.attrs("stellar.tx.submissions") == [{"stellar.tx.via": "rpc", **want, "stellar.network": "testnet"}]


def test_polls_and_simulations(mock, metrics):
    s = server(mock, metrics, network="testnet")
    s.get_transaction(HASH)  # recorded NOT_FOUND
    failed = dict(RECORDED["getTransactionNotFound"]["result"], status="FAILED", resultXdr=trapped())
    mock.rpc["getTransaction"] = failed
    s.get_transaction(HASH)
    mock.rpc["getTransaction"] = dict(failed, resultXdr=archived())
    s.get_transaction(HASH)
    s.simulate_transaction(envelope())  # recorded success
    mock.rpc["simulateTransaction"] = RECORDED["simulateError"]["result"]
    s.simulate_transaction(envelope())  # recorded HostError: Error(Context, UnexpectedSize) → other
    mock.rpc["simulateTransaction"] = {
        "error": f"HostError: Error(Contract, #3) {ACCOUNT}",
        "latestLedger": 1,
    }
    s.simulate_transaction(envelope())
    mock.rpc["simulateTransaction"] = {
        "restorePreamble": {"transactionData": "AAAA", "minResourceFee": "1"},
        "latestLedger": 1,
    }
    s.simulate_transaction(envelope())
    assert metrics.attrs("stellar.tx.polls") == [
        {"stellar.tx.status": "FAILED", "stellar.tx.result_class": "contract_error", "stellar.network": "testnet"},
        {"stellar.tx.status": "FAILED", "stellar.tx.result_class": "expired_state", "stellar.network": "testnet"},
        {"stellar.tx.status": "NOT_FOUND", "stellar.network": "testnet"},
    ]
    assert metrics.attrs("stellar.tx.simulations") == [
        {"stellar.sim.outcome": "error", "stellar.sim.error_class": "contract_error", "stellar.network": "testnet"},
        {"stellar.sim.outcome": "error", "stellar.sim.error_class": "other", "stellar.network": "testnet"},
        {"stellar.sim.outcome": "restore_required", "stellar.network": "testnet"},
        {"stellar.sim.outcome": "success", "stellar.network": "testnet"},
    ]


def test_json_rpc_error_unknown_method(mock, metrics):
    c = StellarRpcClient(meter=metrics.meter, network="testnet")
    resp = c.post(mock.url + "/rpc", json_data={"jsonrpc": "2.0", "id": 1, "method": "getSomethingElse"})
    assert resp.status_code == 200 and resp.json()["error"]["code"] == -32601  # passed through unchanged
    assert metrics.attrs("rpc.client.call.duration") == [
        {
            "rpc.system.name": "jsonrpc",
            "rpc.method": "_OTHER",
            "error.type": "-32601",
            "rpc.status_code": "-32601",
            "stellar.network": "testnet",
        }
    ]


def test_json_rpc_error_through_the_sdk(mock, metrics):
    mock.rpc["getLatestLedger"] = lambda _p: Answer(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": ACCOUNT}})
    mock.rpc["getHealth"] = lambda _p: Answer(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": 7, "message": SEED}})
    s = server(mock, metrics, network="testnet")
    with pytest.raises(SorobanRpcErrorResponse):
        s.get_latest_ledger()
    with pytest.raises(SorobanRpcErrorResponse):
        s.get_health()
    assert metrics.attrs("rpc.client.call.duration") == [
        {
            "rpc.system.name": "jsonrpc",
            "rpc.method": "getLatestLedger",
            "error.type": "-32603",
            "rpc.status_code": "-32603",
            "stellar.network": "testnet",
        },
        {"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "error.type": "_OTHER", "stellar.network": "testnet"},
    ]
    assert ACCOUNT not in metrics.all_json() and SEED not in metrics.all_json()


def test_http_failures(mock, metrics):
    mock.rpc["getHealth"] = lambda _p: Answer(503, "upstream down")
    mock.rpc["getLatestLedger"] = lambda _p: Answer(418, "teapot")
    s = server(mock, metrics, network="testnet")
    with pytest.raises(BaseRequestError):
        s.get_health()
    with pytest.raises(BaseRequestError):
        s.get_latest_ledger()
    assert metrics.attrs("rpc.client.call.duration") == [
        {"rpc.system.name": "jsonrpc", "rpc.method": "getHealth", "error.type": "503", "stellar.network": "testnet"},
        {"rpc.system.name": "jsonrpc", "rpc.method": "getLatestLedger", "error.type": "_OTHER", "stellar.network": "testnet"},
    ]


def test_transport_errors(mock, metrics):
    def slow(_p):
        time.sleep(1.0)
        return Answer(200, {"jsonrpc": "2.0", "id": 1, "result": {}})

    mock.rpc["getHealth"] = slow
    timeout = SorobanServer(
        mock.url + "/rpc", client=StellarRpcClient(RequestsClient(post_timeout=0.2, num_retries=0), meter=metrics.meter)
    )
    with pytest.raises(ConnectionError):
        timeout.get_health()
    refused = SorobanServer("http://127.0.0.1:9/rpc", client=StellarRpcClient(RequestsClient(num_retries=0), meter=metrics.meter))
    with pytest.raises(ConnectionError):
        refused.get_latest_ledger()
    got = {a["rpc.method"]: a["error.type"] for a in metrics.attrs("rpc.client.call.duration")}
    assert got == {"getHealth": "timeout", "getLatestLedger": "network"}


def test_instrumentation_never_breaks_the_call(mock):
    class Broken:
        def create_histogram(self, *a, **k):
            return self

        def create_counter(self, *a, **k):
            return self

        def record(self, *a, **k):
            raise RuntimeError("meter broken")

        def add(self, *a, **k):
            raise RuntimeError("meter broken")

    s = SorobanServer(mock.url + "/rpc", client=StellarRpcClient(meter=Broken()))  # type: ignore[arg-type]
    assert s.get_network().passphrase == "Test SDF Network ; September 2015"
    with pytest.raises(SorobanRpcErrorResponse):
        mock.rpc["getHealth"] = lambda _p: Answer(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "x"}})
        s.get_health()


def test_get_and_stream_pass_through(mock, metrics):
    c = StellarRpcClient(meter=metrics.meter)
    assert c.get(mock.url + "/anything").status_code == 404
    assert metrics.points("rpc.client.call.duration") == []
    c.close()
