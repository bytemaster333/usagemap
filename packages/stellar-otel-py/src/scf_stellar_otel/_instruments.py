# SPDX-License-Identifier: Apache-2.0
"""Metric names, the meter and the instruments (the same names, units and buckets as the JavaScript package)."""

from __future__ import annotations

import threading
import weakref
from dataclasses import dataclass
from typing import Final

from opentelemetry import metrics
from opentelemetry.metrics import Counter, Histogram, Meter

from ._version import __version__

#: Instrumentation scope name of every instrument this package creates.
SCOPE_NAME: Final = "scf_stellar_otel"
SCOPE_VERSION: Final = __version__

# Metric names (wire-formats §f.5 step 4a).
METRIC_RPC_DURATION: Final = "rpc.client.call.duration"
METRIC_HTTP_DURATION: Final = "http.client.request.duration"
METRIC_SUBMISSIONS: Final = "stellar.tx.submissions"
METRIC_POLLS: Final = "stellar.tx.polls"
METRIC_SIMULATIONS: Final = "stellar.tx.simulations"

#: Histogram bucket boundaries in seconds (semantic-conventions advice for durations, plus 30 s for slow RPCs).
DURATION_BUCKETS: Final = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0)


@dataclass(frozen=True)
class Instruments:
    rpc_duration: Histogram
    http_duration: Histogram
    submissions: Counter
    polls: Counter
    simulations: Counter


_cache: weakref.WeakKeyDictionary[Meter, Instruments] = weakref.WeakKeyDictionary()
_default: Instruments | None = None
_lock = threading.Lock()


def _make(m: Meter) -> Instruments:
    b = DURATION_BUCKETS
    return Instruments(
        rpc_duration=m.create_histogram(
            METRIC_RPC_DURATION,
            unit="s",
            description="Duration of outbound Stellar RPC calls, by JSON-RPC method",
            explicit_bucket_boundaries_advisory=b,
        ),
        http_duration=m.create_histogram(
            METRIC_HTTP_DURATION,
            unit="s",
            description="Duration of outbound Horizon requests, by route template",
            explicit_bucket_boundaries_advisory=b,
        ),
        submissions=m.create_counter(
            METRIC_SUBMISSIONS, unit="{transaction}", description="Transaction submissions by status class"
        ),
        polls=m.create_counter(METRIC_POLLS, unit="{call}", description="getTransaction results by status class"),
        simulations=m.create_counter(
            METRIC_SIMULATIONS, unit="{call}", description="simulateTransaction results by outcome class"
        ),
    )


def instruments(meter: Meter | None) -> Instruments:
    """The five instruments of ``meter`` (default: the global provider's meter for this package), created once."""
    global _default
    with _lock:
        if meter is None:
            if _default is None:
                _default = _make(metrics.get_meter(SCOPE_NAME, SCOPE_VERSION))
            return _default
        hit = _cache.get(meter)
        if hit is None:
            hit = _make(meter)
            _cache[meter] = hit
        return hit
