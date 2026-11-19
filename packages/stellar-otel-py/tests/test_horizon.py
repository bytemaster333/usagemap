# SPDX-License-Identifier: Apache-2.0
"""HorizonClient behind the real py-stellar-base Server and RequestsClient, against a local Horizon mock."""

from __future__ import annotations

import pytest
from conftest import ACCOUNT, API_KEY, HASH, Answer, bad_seq
from stellar_sdk import Server
from stellar_sdk.client.requests_client import RequestsClient
from stellar_sdk.exceptions import BadRequestError, BadResponseError, ConnectionError, NotFoundError
from test_rpc import envelope

from scf_stellar_otel import HorizonClient


def horizon(mock, metrics, answers: dict[tuple[str, str], Answer], **kw) -> Server:
    def route(verb: str, path: str) -> Answer | None:
        # Strip the provider prefix (an API key in the path) before matching.
        p = path.removeprefix(f"/{API_KEY}")
        return answers.get((verb, p))

    mock.horizon = route
    kw.setdefault("network", "testnet")
    return Server(f"{mock.url}/{API_KEY}/", client=HorizonClient(meter=metrics.meter, **kw))


ACCOUNT_BODY = {
    "id": ACCOUNT,
    "account_id": ACCOUNT,
    "sequence": "1",
    "subentry_count": 0,
    "thresholds": {"low_threshold": 0, "med_threshold": 0, "high_threshold": 0},
    "flags": {},
    "balances": [],
    "signers": [],
    "data": {},
}


def test_reads_are_templated(mock, metrics):
    s = horizon(
        mock,
        metrics,
        {
            ("GET", f"/accounts/{ACCOUNT}"): Answer(200, ACCOUNT_BODY),
            ("GET", "/fee_stats"): Answer(200, {"last_ledger": "1"}),
            ("GET", "/ledgers"): Answer(200, {"_embedded": {"records": []}, "_links": {}}),
            ("GET", f"/accounts/{ACCOUNT}/payments"): Answer(200, {"_embedded": {"records": []}, "_links": {}}),
        },
    )
    s.accounts().account_id(ACCOUNT).call()
    s.fee_stats().call()
    s.ledgers().cursor("now").limit(5).order(desc=True).call()
    s.payments().for_account(ACCOUNT).call()
    with pytest.raises(NotFoundError):
        s.transactions().transaction(HASH).call()
    assert metrics.attrs("http.client.request.duration") == [
        {
            "error.type": "404",
            "http.request.method": "GET",
            "http.response.status_code": 404,
            "stellar.network": "testnet",
            "url.template": "/transactions/{id}",
        }
    ] + [
        {"http.request.method": "GET", "http.response.status_code": 200, "stellar.network": "testnet", "url.template": t}
        for t in ("/accounts/{id}", "/accounts/{id}/payments", "/fee_stats", "/ledgers")
    ]
    j = metrics.all_json()
    for leak in (ACCOUNT, HASH, API_KEY, "cursor", "now", "127.0.0.1"):
        assert leak not in j


def test_submit_sync(mock, metrics):
    answers = {("POST", "/transactions"): Answer(200, {"hash": HASH, "successful": True, "ledger": 1})}
    s = horizon(mock, metrics, answers)
    s.submit_transaction(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions")] = Answer(
        400, {"type": "tx_failed", "extras": {"result_codes": {"transaction": "tx_bad_seq"}, "envelope_xdr": "AAAA"}}
    )
    with pytest.raises(BadRequestError):
        s.submit_transaction(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions")] = Answer(400, {"type": "tx_failed", "extras": {"result_xdr": bad_seq()}})
    with pytest.raises(BadRequestError):
        s.submit_transaction(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions")] = Answer(504, {"type": "timeout"})
    with pytest.raises(BadResponseError):
        s.submit_transaction(envelope(), skip_memo_required_check=True)
    assert metrics.counts("stellar.tx.submissions") == {
        '{"stellar.network": "testnet", "stellar.tx.status": "SUCCESS", "stellar.tx.via": "horizon"}': 1,
        '{"stellar.network": "testnet", "stellar.tx.result_class": "bad_seq", "stellar.tx.status": "FAILED", "stellar.tx.via": "horizon"}': 2,
        '{"stellar.network": "testnet", "stellar.tx.result_class": "other", "stellar.tx.status": "FAILED", "stellar.tx.via": "horizon"}': 1,
    }
    statuses = sorted(a.get("http.response.status_code") for a in metrics.attrs("http.client.request.duration"))
    assert statuses == [200, 400, 504]


def test_submit_async(mock, metrics):
    answers = {("POST", "/transactions_async"): Answer(201, {"tx_status": "PENDING", "hash": HASH})}
    s = horizon(mock, metrics, answers)
    s.submit_transaction_async(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions_async")] = Answer(400, {"tx_status": "ERROR", "errorResultXdr": bad_seq()})
    with pytest.raises(BadRequestError):
        s.submit_transaction_async(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions_async")] = Answer(503, {"tx_status": "TRY_AGAIN_LATER"})
    with pytest.raises(BadResponseError):
        s.submit_transaction_async(envelope(), skip_memo_required_check=True)
    answers[("POST", "/transactions_async")] = Answer(201, {"tx_status": ACCOUNT})
    s.submit_transaction_async(envelope(), skip_memo_required_check=True)
    assert metrics.attrs("stellar.tx.submissions") == [
        {"stellar.network": "testnet", "stellar.tx.result_class": "bad_seq", "stellar.tx.status": "ERROR", "stellar.tx.via": "horizon"},
        {"stellar.network": "testnet", "stellar.tx.status": "PENDING", "stellar.tx.via": "horizon"},
        {"stellar.network": "testnet", "stellar.tx.status": "TRY_AGAIN_LATER", "stellar.tx.via": "horizon"},
        {"stellar.network": "testnet", "stellar.tx.status": "_OTHER", "stellar.tx.via": "horizon"},
    ]


def test_transport_error_and_unknown_network(metrics):
    s = Server("http://127.0.0.1:9/", client=HorizonClient(RequestsClient(num_retries=0), meter=metrics.meter, network="nope"))
    with pytest.raises(ConnectionError):
        s.fee_stats().call()
    assert metrics.attrs("http.client.request.duration") == [
        {"error.type": "network", "http.request.method": "GET", "stellar.network": "unknown", "url.template": "/fee_stats"}
    ]
