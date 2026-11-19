# SPDX-License-Identifier: Apache-2.0
"""HTTP clients for py-stellar-base (``stellar-sdk``) that record OpenTelemetry metrics around another client.

py-stellar-base's public extension point is the ``client`` argument of ``SorobanServer`` / ``Server`` (and their
async twins): any ``BaseSyncClient`` / ``BaseAsyncClient``. These classes wrap the client the application would have
used (default ``RequestsClient`` / ``AiohttpClient``) and delegate every call unchanged; they only time it and classify
the outcome into the closed sets of :mod:`scf_stellar_otel.classify`.

Never read into an attribute: the URL (it may carry an API key), query parameters, request bodies, transaction
hashes, XDR, addresses, ledger keys, error message text, request ids. Result XDR is decoded in memory; only its class
survives. Event streams (``stream``) are passed through and not measured.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator, Generator, Mapping
from typing import Any

from opentelemetry.metrics import Meter
from stellar_sdk.client.base_async_client import BaseAsyncClient
from stellar_sdk.client.base_sync_client import BaseSyncClient
from stellar_sdk.client.response import Response

from . import classify as c
from ._instruments import Instruments, instruments

__all__ = ["HorizonAsyncClient", "HorizonClient", "StellarRpcAsyncClient", "StellarRpcClient"]

_MAX_BODY = 1 << 20
Attrs = dict[str, str | int]


def _body(resp: Response) -> Mapping[str, Any] | None:
    """The response body as a JSON object, or None (too large, not JSON, not an object)."""
    text = getattr(resp, "text", None)
    if not isinstance(text, str) or len(text) >= _MAX_BODY:
        return None
    try:
        v = json.loads(text)
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def _status(resp: object) -> int | None:
    s = getattr(resp, "status_code", None)
    return s if isinstance(s, int) and not isinstance(s, bool) else None


def _safely(f: Any, *args: Any) -> None:
    """Run instrumentation code; it must never break or alter the caller's request."""
    try:
        f(*args)
    except Exception:  # noqa: BLE001 - instrumentation never breaks the call
        pass


class _Rpc:
    """Classification and recording of Stellar RPC (JSON-RPC 2.0) calls."""

    def __init__(self, network: str | None, meter: Meter | None) -> None:
        self.ins: Instruments = instruments(meter)
        self.fixed = network is not None
        self.net = c.network_of(network) if self.fixed else "unknown"

    def method_of(self, json_data: object) -> str | None:
        if isinstance(json_data, Mapping) and "method" in json_data:
            return c.rpc_method(json_data.get("method"))
        return None

    def base(self, m: str) -> Attrs:
        return {"rpc.system.name": "jsonrpc", "rpc.method": m, "stellar.network": self.net}

    def response(self, m: str, t0: float, resp: Response) -> None:
        dt = max(0.0, time.perf_counter() - t0)
        st = _status(resp)
        if st is None or not 200 <= st < 300:
            # A non-2xx answer is a transport failure (the SDK raises on it); its status is the error type.
            a = self.base(m)
            a["error.type"] = c.status_error_type(st) if st is not None else c.OTHER
            self.ins.rpc_duration.record(dt, a)
            return
        body = _body(resp)
        err = body.get("error") if body is not None else None
        if isinstance(err, Mapping):
            t = c.json_rpc_error_type(err.get("code"))
            a = self.base(m)
            a["error.type"] = t
            if t != c.OTHER:
                a["rpc.status_code"] = t
            self.ins.rpc_duration.record(dt, a)
            return
        result = body.get("result") if body is not None else None
        rr = result if isinstance(result, Mapping) else None
        if m == "getNetwork" and not self.fixed and rr is not None:
            self.net = c.network_of(rr.get("passphrase"))
        self.ins.rpc_duration.record(dt, self.base(m))
        if rr is None:
            return
        net = {"stellar.network": self.net}
        if m == "sendTransaction":
            status = c.closed(c.SUBMIT_STATUSES, rr.get("status"))
            a: Attrs = {"stellar.tx.via": "rpc", "stellar.tx.status": status}
            if status == "ERROR":
                a["stellar.tx.result_class"] = c.tx_result_class(rr.get("errorResultXdr"))
            self.ins.submissions.add(1, {**a, **net})
        elif m == "getTransaction":
            status = c.closed(c.POLL_STATUSES, rr.get("status"))
            a = {"stellar.tx.status": status}
            if status == "FAILED":
                a["stellar.tx.result_class"] = c.tx_result_class(rr.get("resultXdr"))
            self.ins.polls.add(1, {**a, **net})
        elif m == "simulateTransaction":
            if isinstance(rr.get("error"), str):
                a = {"stellar.sim.outcome": "error", "stellar.sim.error_class": c.sim_error_class(rr.get("error"))}
            elif rr.get("restorePreamble"):
                a = {"stellar.sim.outcome": "restore_required"}
            else:
                a = {"stellar.sim.outcome": "success"}
            self.ins.simulations.add(1, {**a, **net})

    def error(self, m: str, t0: float, err: BaseException) -> None:
        a = self.base(m)
        a["error.type"] = c.transport_error_type(err)
        self.ins.rpc_duration.record(max(0.0, time.perf_counter() - t0), a)


def _failure_class(b: Mapping[str, Any] | None) -> str:
    extras = b.get("extras") if b is not None else None
    extras = extras if isinstance(extras, Mapping) else {}
    codes = extras.get("result_codes")
    code = codes.get("transaction") if isinstance(codes, Mapping) else None
    if isinstance(code, str) and code in c.HORIZON_TX_CODES:
        return c.HORIZON_TX_CODES[code]
    xdr = extras.get("result_xdr")
    if xdr is None and b is not None:
        xdr = b.get("errorResultXdr", b.get("error_result_xdr"))
    return "other" if xdr is None else c.tx_result_class(xdr)


class _Horizon:
    """Classification and recording of Horizon requests."""

    def __init__(self, network: str | None, meter: Meter | None) -> None:
        self.ins = instruments(meter)
        self.net = c.network_of(network)

    def attrs(self, method: str, route: str, status: int | None) -> Attrs:
        a: Attrs = {"http.request.method": method, "url.template": route, "stellar.network": self.net}
        st = c.http_status(status)
        if st is not None:
            a["http.response.status_code"] = st
        return a

    def submission(self, a: Attrs) -> None:
        self.ins.submissions.add(1, {"stellar.tx.via": "horizon", **a, "stellar.network": self.net})

    def response(self, method: str, url: str, t0: float, resp: Response) -> None:
        dt = max(0.0, time.perf_counter() - t0)
        route = c.horizon_route(url)
        st = _status(resp)
        ok = st is not None and 200 <= st < 300
        a = self.attrs(method, route, st)
        if not ok:
            a["error.type"] = c.status_error_type(st) if st is not None else c.OTHER
        self.ins.http_duration.record(dt, a)
        if method != "POST" or route not in ("/transactions", "/transactions_async"):
            return
        b = _body(resp)
        if route == "/transactions_async" and (ok or (b is not None and b.get("tx_status") is not None)):
            status = c.closed(c.SUBMIT_STATUSES, b.get("tx_status") if b is not None else None)
            s: Attrs = {"stellar.tx.status": status}
            if status == "ERROR":
                s["stellar.tx.result_class"] = _failure_class(b)
            self.submission(s)
        elif ok:
            self.submission({"stellar.tx.status": "SUCCESS"})
        else:
            self.submission({"stellar.tx.status": "FAILED", "stellar.tx.result_class": _failure_class(b)})

    def error(self, method: str, url: str, t0: float, err: BaseException) -> None:
        a = self.attrs(method, c.horizon_route(url), None)
        a["error.type"] = c.transport_error_type(err)
        self.ins.http_duration.record(max(0.0, time.perf_counter() - t0), a)


def _default_sync() -> BaseSyncClient:
    from stellar_sdk.client.requests_client import RequestsClient

    return RequestsClient()


def _default_async() -> BaseAsyncClient:
    from stellar_sdk.client.aiohttp_client import AiohttpClient  # needs the stellar-sdk[aiohttp] extra

    return AiohttpClient()


class StellarRpcClient(BaseSyncClient):
    """A ``BaseSyncClient`` for ``stellar_sdk.SorobanServer`` that records Stellar RPC metrics.

    ``SorobanServer(url, client=StellarRpcClient(network="testnet"))``. Emits ``rpc.client.call.duration`` (s) per
    JSON-RPC call, plus ``stellar.tx.submissions`` (sendTransaction), ``stellar.tx.polls`` (getTransaction) and
    ``stellar.tx.simulations`` (simulateTransaction). ``network`` is a name or passphrase; when omitted it is learnt
    from a ``getNetwork`` response (``unknown`` until then).
    """

    def __init__(
        self, inner: BaseSyncClient | None = None, *, network: str | None = None, meter: Meter | None = None
    ) -> None:
        self.inner = inner if inner is not None else _default_sync()
        self._r = _Rpc(network, meter)

    def get(self, url: str, params: dict[str, str] | None = None, *args: Any, **kwargs: Any) -> Response:
        return self.inner.get(url, params, *args, **kwargs)

    def post(
        self, url: str, data: dict[str, str] | None = None, json_data: dict[str, Any] | None = None
    ) -> Response:
        m = None
        try:
            m = self._r.method_of(json_data)
        except Exception:  # noqa: BLE001
            m = None
        t0 = time.perf_counter()
        try:
            resp = self.inner.post(url, data=data, json_data=json_data)
        except BaseException as err:
            if m is not None and isinstance(err, Exception):
                _safely(self._r.error, m, t0, err)
            raise
        if m is not None:
            _safely(self._r.response, m, t0, resp)
        return resp

    def stream(self, url: str, params: dict[str, str] | None = None) -> Generator[dict[str, Any], None, None]:
        return self.inner.stream(url, params)

    def close(self) -> None:
        self.inner.close()

    def __repr__(self) -> str:
        return f"<StellarRpcClient [inner={self.inner!r}]>"


class HorizonClient(BaseSyncClient):
    """A ``BaseSyncClient`` for ``stellar_sdk.Server`` (Horizon) that records Horizon metrics.

    ``Server(url, client=HorizonClient(network="testnet"))``. Emits ``http.client.request.duration`` with a closed
    Horizon route template, and ``stellar.tx.submissions`` (``stellar.tx.via = horizon``) for POST ``/transactions``
    and ``/transactions_async``. Account ids, hashes, ledger numbers, cursors, query parameters and any base-path
    prefix of the Horizon URL are replaced by the template, never recorded.
    """

    def __init__(
        self, inner: BaseSyncClient | None = None, *, network: str | None = None, meter: Meter | None = None
    ) -> None:
        self.inner = inner if inner is not None else _default_sync()
        self._h = _Horizon(network, meter)

    def _call(self, method: str, url: str, f: Any) -> Response:
        t0 = time.perf_counter()
        try:
            resp = f()
        except BaseException as err:
            if isinstance(err, Exception):
                _safely(self._h.error, method, url, t0, err)
            raise
        _safely(self._h.response, method, url, t0, resp)
        return resp

    def get(self, url: str, params: dict[str, str] | None = None, *args: Any, **kwargs: Any) -> Response:
        return self._call("GET", url, lambda: self.inner.get(url, params, *args, **kwargs))

    def post(
        self, url: str, data: dict[str, str] | None = None, json_data: dict[str, Any] | None = None
    ) -> Response:
        return self._call("POST", url, lambda: self.inner.post(url, data=data, json_data=json_data))

    def stream(self, url: str, params: dict[str, str] | None = None) -> Generator[dict[str, Any], None, None]:
        return self.inner.stream(url, params)

    def close(self) -> None:
        self.inner.close()

    def __repr__(self) -> str:
        return f"<HorizonClient [inner={self.inner!r}]>"


class StellarRpcAsyncClient(BaseAsyncClient):
    """The async twin of :class:`StellarRpcClient` for ``stellar_sdk.SorobanServerAsync``."""

    def __init__(
        self, inner: BaseAsyncClient | None = None, *, network: str | None = None, meter: Meter | None = None
    ) -> None:
        self.inner = inner if inner is not None else _default_async()
        self._r = _Rpc(network, meter)

    async def get(self, url: str, params: dict[str, str] | None = None, *args: Any, **kwargs: Any) -> Response:
        return await self.inner.get(url, params, *args, **kwargs)

    async def post(
        self, url: str, data: dict[str, str] | None = None, json_data: dict[str, Any] | None = None
    ) -> Response:
        m = None
        try:
            m = self._r.method_of(json_data)
        except Exception:  # noqa: BLE001
            m = None
        t0 = time.perf_counter()
        try:
            resp = await self.inner.post(url, data=data, json_data=json_data)
        except BaseException as err:
            if m is not None and isinstance(err, Exception):
                _safely(self._r.error, m, t0, err)
            raise
        if m is not None:
            _safely(self._r.response, m, t0, resp)
        return resp

    def stream(self, url: str, params: dict[str, str] | None = None) -> AsyncGenerator[dict[str, Any], None]:
        return self.inner.stream(url, params)

    async def close(self) -> None:
        await self.inner.close()


class HorizonAsyncClient(BaseAsyncClient):
    """The async twin of :class:`HorizonClient` for ``stellar_sdk.ServerAsync``."""

    def __init__(
        self, inner: BaseAsyncClient | None = None, *, network: str | None = None, meter: Meter | None = None
    ) -> None:
        self.inner = inner if inner is not None else _default_async()
        self._h = _Horizon(network, meter)

    async def _call(self, method: str, url: str, coro: Any) -> Response:
        t0 = time.perf_counter()
        try:
            resp = await coro
        except BaseException as err:
            if isinstance(err, Exception):
                _safely(self._h.error, method, url, t0, err)
            raise
        _safely(self._h.response, method, url, t0, resp)
        return resp

    async def get(self, url: str, params: dict[str, str] | None = None, *args: Any, **kwargs: Any) -> Response:
        return await self._call("GET", url, self.inner.get(url, params, *args, **kwargs))

    async def post(
        self, url: str, data: dict[str, str] | None = None, json_data: dict[str, Any] | None = None
    ) -> Response:
        return await self._call("POST", url, self.inner.post(url, data=data, json_data=json_data))

    def stream(self, url: str, params: dict[str, str] | None = None) -> AsyncGenerator[dict[str, Any], None]:
        return self.inner.stream(url, params)

    async def close(self) -> None:
        await self.inner.close()
