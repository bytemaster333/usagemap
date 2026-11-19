# SPDX-License-Identifier: Apache-2.0
"""Test harness: a local mock of Stellar RPC (JSON-RPC over POST) and Horizon, scripted per test, behind the real
py-stellar-base servers and its real ``RequestsClient``. The default RPC answers replay responses recorded from the
public testnet (``tests/fixtures/testnet-rpc.json``, the same recording as the JavaScript package's)."""

from __future__ import annotations

import base64
import contextlib
import json
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import Resource
from stellar_sdk import xdr as X

FIXTURES = Path(__file__).parent / "fixtures"
RECORDED: dict[str, Any] = json.loads((FIXTURES / "testnet-rpc.json").read_text())

# Hostile values a test may plant in requests and responses: none may ever appear in an exported attribute.
ACCOUNT = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
SEED = "SBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
HASH = "cd" * 32
API_KEY = "k3y-0123456789abcdef"


def _b64(v: Any) -> str:
    return base64.b64encode(v.to_xdr_bytes()).decode()


def tx_result(r: X.TransactionResultResult) -> str:
    return _b64(X.TransactionResult(X.Int64(100), r, X.TransactionResultExt(0)))


def bad_seq() -> str:
    return tx_result(X.TransactionResultResult(X.TransactionResultCode.txBAD_SEQ))


def host_fn(code: X.InvokeHostFunctionResultCode) -> str:
    op = X.OperationResult(
        X.OperationResultCode.opINNER,
        tr=X.OperationResultTr(
            X.OperationType.INVOKE_HOST_FUNCTION, invoke_host_function_result=X.InvokeHostFunctionResult(code)
        ),
    )
    return tx_result(X.TransactionResultResult(X.TransactionResultCode.txFAILED, results=[op]))


def trapped() -> str:
    return host_fn(X.InvokeHostFunctionResultCode.INVOKE_HOST_FUNCTION_TRAPPED)


def archived() -> str:
    return host_fn(X.InvokeHostFunctionResultCode.INVOKE_HOST_FUNCTION_ENTRY_ARCHIVED)


def fee_bump_inner_insufficient_fee() -> str:
    inner = X.InnerTransactionResult(
        X.Int64(100),
        X.InnerTransactionResultResult(X.TransactionResultCode.txINSUFFICIENT_FEE),
        X.InnerTransactionResultExt(0),
    )
    pair = X.InnerTransactionResultPair(X.Hash(bytes(32)), inner)
    return tx_result(X.TransactionResultResult(X.TransactionResultCode.txFEE_BUMP_INNER_FAILED, inner_result_pair=pair))


@dataclass
class Answer:
    status: int
    body: Any


@dataclass
class Mock:
    url: str
    #: rpc[method] → result dict, or a callable(params) → Answer; default: the recorded testnet answer.
    rpc: dict[str, Any] = field(default_factory=dict)
    #: horizon(method, path) → Answer, or None for the default (404).
    horizon: Callable[[str, str], Answer | None] | None = None
    requests: list[tuple[str, str]] = field(default_factory=list)


def _recorded(method: str) -> Any:
    key = {"getTransaction": "getTransactionNotFound"}.get(method, method)
    if key in RECORDED:
        return RECORDED[key]
    if method == "simulateTransaction":
        return RECORDED["simulateSuccess"]
    return RECORDED["unknownMethod"]


@contextlib.contextmanager
def serve_mock() -> Iterator[Mock]:
    """Start the mock on a free local port for the duration of the block."""
    state: dict[str, Mock] = {}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a: Any) -> None:  # quiet
            pass

        def _send(self, a: Answer) -> None:
            raw = a.body if isinstance(a.body, str) else json.dumps(a.body)
            b = raw.encode()
            self.send_response(a.status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def _horizon(self, verb: str) -> None:
            m = state["m"]
            path = self.path.split("?", 1)[0]
            m.requests.append((verb, self.path))
            a = m.horizon(verb, path) if m.horizon else None
            self._send(a or Answer(404, {"type": "not_found", "status": 404}))

        def do_GET(self) -> None:  # noqa: N802
            self._horizon("GET")

        def do_POST(self) -> None:  # noqa: N802
            m = state["m"]
            n = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(n).decode()
            if not self.path.startswith("/rpc"):
                self._horizon("POST")
                return
            req = json.loads(raw)
            m.requests.append(("POST", "/rpc:" + req["method"]))
            spec = m.rpc.get(req["method"])
            if callable(spec):
                self._send(spec(req.get("params")))
                return
            if spec is None:
                body = dict(_recorded(req["method"]))
            else:
                body = {"jsonrpc": "2.0", "result": spec}
            body["id"] = req["id"]
            self._send(Answer(200, body))

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    m = Mock(url=f"http://127.0.0.1:{srv.server_address[1]}")
    state["m"] = m
    try:
        yield m
    finally:
        srv.shutdown()
        srv.server_close()


@pytest.fixture
def mock() -> Iterator[Mock]:
    with serve_mock() as m:
        yield m


@dataclass
class Metrics:
    provider: MeterProvider
    reader: InMemoryMetricReader

    @property
    def meter(self) -> Any:
        return self.provider.get_meter("scf_stellar_otel", "0.1.0")

    def points(self, name: str) -> list[tuple[dict[str, Any], Any]]:
        """(attributes, point) of every point of metric ``name``."""
        data = self.reader.get_metrics_data()
        out: list[tuple[dict[str, Any], Any]] = []
        if data is None:
            return out
        for rm in data.resource_metrics:
            for sm in rm.scope_metrics:
                for met in sm.metrics:
                    if met.name == name:
                        out.extend((dict(p.attributes or {}), p) for p in met.data.data_points)
        return out

    def attrs(self, name: str) -> list[dict[str, Any]]:
        return sorted((a for a, _ in self.points(name)), key=lambda a: json.dumps(a, sort_keys=True))

    def counts(self, name: str) -> dict[str, int]:
        return {json.dumps(a, sort_keys=True): (p.count if hasattr(p, "count") else p.value) for a, p in self.points(name)}

    def all_json(self) -> str:
        data = self.reader.get_metrics_data()
        return data.to_json() if data is not None else ""


@pytest.fixture
def metrics() -> Iterator[Metrics]:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], resource=Resource.create({"service.name": "py-dapp"}))
    try:
        yield Metrics(provider, reader)
    finally:
        provider.shutdown()
