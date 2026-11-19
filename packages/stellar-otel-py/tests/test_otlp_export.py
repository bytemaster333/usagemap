# SPDX-License-Identifier: Apache-2.0
"""The OTLP export of a realistic session: only the five metric names, only closed-set attribute values, nothing
from a URL, key, address, hash or error text; and the Collector fixture committed for step 4a has the same shape."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import ACCOUNT, API_KEY, HASH
from scenario import run_scenario

from scf_stellar_otel import classify as c

FIXTURE = Path(__file__).parents[3] / "collector/processor/scfsanitizeprocessor/testdata/sdk/stellar-otel-py.metrics.json"

ALLOWED: dict[str, dict[str, object]] = {
    "rpc.client.call.duration": {
        "rpc.system.name": {"jsonrpc"},
        "rpc.method": {*c.RPC_METHODS, c.OTHER},
        "error.type": {*c.JSONRPC_CODES, "timeout", "network", c.OTHER, *(str(s) for s in c.HTTP_STATUSES if s >= 400)},
        "rpc.status_code": set(c.JSONRPC_CODES),
        "stellar.network": set(c.NETWORKS),
    },
    "http.client.request.duration": {
        "http.request.method": {"GET", "POST", c.OTHER},
        "url.template": {*c.HORIZON_TEMPLATES, c.OTHER},
        "http.response.status_code": set(c.HTTP_STATUSES),
        "error.type": {"timeout", "network", c.OTHER, *(str(s) for s in c.HTTP_STATUSES if s >= 400)},
        "stellar.network": set(c.NETWORKS),
    },
    "stellar.tx.submissions": {
        "stellar.tx.via": {"rpc", "horizon"},
        "stellar.tx.status": {*c.SUBMIT_STATUSES, c.OTHER},
        "stellar.tx.result_class": set(c.RESULT_CLASSES),
        "stellar.network": set(c.NETWORKS),
    },
    "stellar.tx.polls": {
        "stellar.tx.status": {*c.POLL_STATUSES, c.OTHER},
        "stellar.tx.result_class": set(c.RESULT_CLASSES),
        "stellar.network": set(c.NETWORKS),
    },
    "stellar.tx.simulations": {
        "stellar.sim.outcome": {*c.SIM_OUTCOMES, c.OTHER},
        "stellar.sim.error_class": set(c.SIM_ERROR_CLASSES),
        "stellar.network": set(c.NETWORKS),
    },
}


def _value(v: dict) -> object:
    if "stringValue" in v:
        return v["stringValue"]
    if "intValue" in v:
        return int(v["intValue"])
    raise AssertionError(f"unexpected attribute value type {v}")


def _shape(body: dict) -> dict[str, int]:
    """metric name → number of points; checks every attribute against ALLOWED on the way."""
    out: dict[str, int] = {}
    for rm in body["resourceMetrics"]:
        for sm in rm["scopeMetrics"]:
            assert sm["scope"]["name"] == "scf_stellar_otel"
            for m in sm["metrics"]:
                allowed = ALLOWED[m["name"]]
                kind = "histogram" if "histogram" in m else "sum"
                pts = m[kind]["dataPoints"]
                if kind == "sum":
                    assert m["sum"]["isMonotonic"] is True
                for p in pts:
                    for a in p.get("attributes", []):
                        assert a["key"] in allowed, (m["name"], a["key"])
                        assert _value(a["value"]) in allowed[a["key"]], (m["name"], a)
                    assert any(a["key"] == "stellar.network" for a in p["attributes"])
                out[m["name"]] = out.get(m["name"], 0) + len(pts)
    return out


def test_export_is_closed_and_clean():
    raw = run_scenario()
    for leak in (ACCOUNT, HASH, API_KEY, "apikey", "127.0.0.1", "Error(Contract", "now", "tx_bad_seq"):
        assert leak not in raw, leak
    body = json.loads(raw)
    assert _shape(body) == {
        "rpc.client.call.duration": 7,  # points = distinct attribute sets
        "stellar.tx.submissions": 4,
        "stellar.tx.polls": 2,
        "stellar.tx.simulations": 2,
        "http.client.request.duration": 3,
    }


def test_collector_fixture_matches_the_scenario():
    """The committed Collector fixture is an export of this scenario (regenerate: scripts/collector_fixture.py)."""
    fixture = json.loads(FIXTURE.read_text())
    assert _shape(fixture) == _shape(json.loads(run_scenario()))
