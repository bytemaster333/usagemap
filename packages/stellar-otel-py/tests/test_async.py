# SPDX-License-Identifier: Apache-2.0
"""The async clients with a scripted BaseAsyncClient (the default AiohttpClient needs the stellar-sdk[aiohttp]
extra; the classification is the same code as the sync clients)."""

from __future__ import annotations

import asyncio
import json

import pytest
from conftest import HASH, RECORDED, bad_seq
from stellar_sdk.client.base_async_client import BaseAsyncClient
from stellar_sdk.client.response import Response
from stellar_sdk.exceptions import ConnectionError

from scf_stellar_otel import HorizonAsyncClient, StellarRpcAsyncClient


class Scripted(BaseAsyncClient):
    def __init__(self, answers):
        self.answers = answers
        self.closed = False

    async def get(self, url, params=None, max_content_size=None):
        return self._answer(url)

    async def post(self, url, data=None, json_data=None):
        return self._answer(json_data["method"] if json_data else url)

    def _answer(self, key):
        a = self.answers[key]
        if isinstance(a, Exception):
            raise a
        status, body = a
        return Response(status, json.dumps(body), {}, "")

    def stream(self, url, params=None):
        raise NotImplementedError

    async def close(self):
        self.closed = True


def test_async_rpc(metrics):
    inner = Scripted(
        {
            "getNetwork": (200, RECORDED["getNetwork"]),
            "sendTransaction": (200, {"result": {"status": "ERROR", "errorResultXdr": bad_seq()}}),
            "getHealth": ConnectionError(OSError("refused")),
        }
    )
    c = StellarRpcAsyncClient(inner, meter=metrics.meter)

    async def run():
        await c.post("u", json_data={"method": "getNetwork"})
        await c.post("u", json_data={"method": "sendTransaction"})
        with pytest.raises(ConnectionError):
            await c.post("u", json_data={"method": "getHealth"})
        await c.close()

    asyncio.run(run())
    assert inner.closed
    assert {a["rpc.method"]: a.get("error.type") for a in metrics.attrs("rpc.client.call.duration")} == {
        "getNetwork": None,
        "sendTransaction": None,
        "getHealth": "network",
    }
    assert metrics.attrs("stellar.tx.submissions") == [
        {"stellar.network": "testnet", "stellar.tx.result_class": "bad_seq", "stellar.tx.status": "ERROR", "stellar.tx.via": "rpc"}
    ]


def test_async_horizon(metrics):
    inner = Scripted({f"https://h/transactions/{HASH}": (404, {"status": 404}), "https://h/transactions_async": (201, {"tx_status": "DUPLICATE"})})
    c = HorizonAsyncClient(inner, meter=metrics.meter, network="mainnet")

    async def run():
        await c.get(f"https://h/transactions/{HASH}")
        await c.post("https://h/transactions_async", data={"tx": "AAAA"})

    asyncio.run(run())
    assert [a["url.template"] for a in metrics.attrs("http.client.request.duration")] == ["/transactions/{id}", "/transactions_async"]
    assert metrics.attrs("stellar.tx.submissions") == [
        {"stellar.network": "mainnet", "stellar.tx.status": "DUPLICATE", "stellar.tx.via": "horizon"}
    ]
