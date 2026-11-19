# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import base64

import pytest
from conftest import ACCOUNT, API_KEY, HASH, archived, bad_seq, fee_bump_inner_insufficient_fee, trapped

from scf_stellar_otel import classify as c


@pytest.mark.parametrize(
    ("xdr", "want"),
    [
        (bad_seq(), "bad_seq"),
        (trapped(), "contract_error"),
        (archived(), "expired_state"),
        (fee_bump_inner_insufficient_fee(), "insufficient_fee"),
        ("", "undecodable"),
        ("not-xdr!", "undecodable"),
        ("AAAA", "undecodable"),
        (None, "undecodable"),
        ("A" * (1 << 17), "undecodable"),
        (base64.b64encode(bytes(8) + (-99).to_bytes(4, "big", signed=True)).decode(), "other"),
        # txFAILED with a truncated operation list, and a fee bump whose inner result is again a fee bump.
        (base64.b64encode(bytes(8) + (-1).to_bytes(4, "big", signed=True)).decode(), "op_failed"),
        (
            base64.b64encode(bytes(8) + (-13).to_bytes(4, "big", signed=True) + bytes(40) + (-13).to_bytes(4, "big", signed=True)).decode(),
            "other",
        ),
    ],
)
def test_tx_result_class(xdr, want):
    assert c.tx_result_class(xdr) == want


@pytest.mark.parametrize(
    ("url", "want"),
    [
        ("https://h.example/accounts/" + ACCOUNT, "/accounts/{id}"),
        (f"https://h.example/{API_KEY}/accounts/{ACCOUNT}/payments?cursor=now&limit=5", "/accounts/{id}/payments"),
        (f"https://h.example/accounts/{ACCOUNT}/data/secret-key-name", "/accounts/{id}/data/{key}"),
        (f"https://h.example/transactions/{HASH}", "/transactions/{id}"),
        ("https://h.example/paths/strict-send?x=1", "/paths/strict-send"),
        ("https://h.example/", "/"),
        (f"https://h.example/{API_KEY}/", "_OTHER"),  # a bare prefix is not "/"
        ("https://h.example/unknown/route", "_OTHER"),
        ("https://h.example/" + "/".join(["a"] * 20), "_OTHER"),
        ("http://[bad", "_OTHER"),
    ],
)
def test_horizon_route(url, want):
    assert c.horizon_route(url) == want


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("HostError: Error(Contract, #3)", "contract_error"),
        ("Error(Budget, ExceededLimit)", "resource_limit"),
        ("entry is archived", "expired_state"),
        ("Error(Auth, InvalidAction)", "auth"),
        ("Error(WasmVm, InvalidAction)", "wasm_trap"),
        ("Error(Value, InvalidInput)", "value_error"),
        ("Error(Storage, ExceededLimit)", "storage"),
        ("Account not found " + ACCOUNT, "no_account"),
        ("anything else", "other"),
        (None, "other"),
    ],
)
def test_sim_error_class(text, want):
    assert c.sim_error_class(text) == want


def test_small_classifiers():
    assert c.network_of("Public Global Stellar Network ; September 2015") == "mainnet"
    assert c.network_of("my private passphrase") == "unknown"
    assert c.network_of(None) == "unknown"
    assert c.rpc_method("getHealth") == "getHealth" and c.rpc_method(ACCOUNT) == "_OTHER"
    assert c.json_rpc_error_type(-32601) == "-32601" and c.json_rpc_error_type(True) == "_OTHER"
    assert c.json_rpc_error_type("-32601") == "_OTHER"
    assert c.status_error_type(503) == "503" and c.status_error_type(418) == "_OTHER" and c.status_error_type(200) == "_OTHER"
    assert c.http_status(True) is None
    assert c.closed(c.SUBMIT_STATUSES, "PENDING") == "PENDING" and c.closed(c.SUBMIT_STATUSES, 1) == "_OTHER"


def test_transport_error_type():
    class ReadTimeout(Exception):
        pass

    wrapped = RuntimeError("wrapper")
    wrapped.__cause__ = ReadTimeout()
    assert c.transport_error_type(wrapped) == "timeout"
    assert c.transport_error_type(TimeoutError()) == "timeout"
    assert c.transport_error_type(OSError("refused")) == "network"
    loop = RuntimeError("a")
    loop.__cause__ = loop
    assert c.transport_error_type(loop) == "network"
