# SPDX-License-Identifier: Apache-2.0
"""The closed sets, metric names and buckets here are identical to the JavaScript package's (which the Collector
test TestStellarSetsMatchPackage pins to the Collector's step 4a): a value this package emits is never rewritten to
_OTHER by the Collector."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import scf_stellar_otel as p
from scf_stellar_otel import classify as c

JS = Path(__file__).parents[2] / "stellar-otel/src"


def _array(src: str, name: str) -> list[str]:
    m = re.search(r"export const " + name + r" = \[(.*?)\] as const;", src, re.S)
    assert m, f"{name} not found in classify.ts"
    return [a or b for a, b in re.findall(r'"([^"]*)"|(-?\d+)', m.group(1))]


@pytest.mark.parametrize(
    ("name", "ours"),
    [
        ("RPC_METHODS", c.RPC_METHODS),
        ("NETWORKS", c.NETWORKS),
        ("RESULT_CLASSES", c.RESULT_CLASSES),
        ("SIM_ERROR_CLASSES", c.SIM_ERROR_CLASSES),
        ("SUBMIT_STATUSES", c.SUBMIT_STATUSES),
        ("POLL_STATUSES", c.POLL_STATUSES),
        ("SIM_OUTCOMES", c.SIM_OUTCOMES),
        ("JSONRPC_CODES", c.JSONRPC_CODES),
        ("HORIZON_TEMPLATES", c.HORIZON_TEMPLATES),
        ("HTTP_STATUSES", tuple(str(s) for s in c.HTTP_STATUSES)),
    ],
)
def test_closed_sets_equal_the_js_package(name, ours):
    assert tuple(_array((JS / "classify.ts").read_text(), name)) == tuple(ours)


def test_tables_equal_the_js_package():
    src = (JS / "classify.ts").read_text()
    js_tx = {int(k): v for k, v in re.findall(r'^\s*\[?(-?\d+)\]?: "([a-z_]+)", // tx', src, re.M)}
    assert js_tx == dict(c._TX_CODE)
    js_hz = dict(re.findall(r'^\s*(tx_[a-z_]+): "([a-z_]+)",', src, re.M))
    assert js_hz == dict(c.HORIZON_TX_CODES)


def test_names_and_buckets_equal_the_js_package():
    src = (JS / "common.ts").read_text()
    consts = dict(re.findall(r'export const (METRIC_[A-Z_]+) = "([^"]+)";', src))
    assert consts == {k: getattr(p, k) for k in consts} and len(consts) == 5
    m = re.search(r"DURATION_BUCKETS = \[([^\]]*)\]", src)
    assert m and tuple(float(x) for x in m.group(1).split(",")) == p.DURATION_BUCKETS
