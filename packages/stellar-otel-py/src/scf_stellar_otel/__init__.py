# SPDX-License-Identifier: Apache-2.0
"""OpenTelemetry metrics for py-stellar-base (``stellar-sdk``) RPC and Horizon calls, server side.

    from stellar_sdk import Server, SorobanServer
    from scf_stellar_otel import HorizonClient, StellarRpcClient

    rpc = SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))
    horizon = Server(HORIZON_URL, client=HorizonClient(network="testnet"))

Uses the application's own MeterProvider through ``opentelemetry-api``. Emits aggregates only, under the same metric
names and closed attribute sets as the JavaScript package ``@usagemap/stellar-otel``: no address, transaction
hash, XDR, key, URL or user identifier is ever an attribute.
"""

from ._instruments import (
    DURATION_BUCKETS,
    METRIC_HTTP_DURATION,
    METRIC_POLLS,
    METRIC_RPC_DURATION,
    METRIC_SIMULATIONS,
    METRIC_SUBMISSIONS,
    SCOPE_NAME,
    SCOPE_VERSION,
)
from ._version import __version__
from .classify import (
    HORIZON_TEMPLATES,
    NETWORKS,
    POLL_STATUSES,
    RESULT_CLASSES,
    RPC_METHODS,
    SIM_ERROR_CLASSES,
    SIM_OUTCOMES,
    SUBMIT_STATUSES,
    horizon_route,
    sim_error_class,
    tx_result_class,
)
from .clients import HorizonAsyncClient, HorizonClient, StellarRpcAsyncClient, StellarRpcClient

__all__ = [
    "DURATION_BUCKETS",
    "HORIZON_TEMPLATES",
    "METRIC_HTTP_DURATION",
    "METRIC_POLLS",
    "METRIC_RPC_DURATION",
    "METRIC_SIMULATIONS",
    "METRIC_SUBMISSIONS",
    "NETWORKS",
    "POLL_STATUSES",
    "RESULT_CLASSES",
    "RPC_METHODS",
    "SCOPE_NAME",
    "SCOPE_VERSION",
    "SIM_ERROR_CLASSES",
    "SIM_OUTCOMES",
    "SUBMIT_STATUSES",
    "HorizonAsyncClient",
    "HorizonClient",
    "StellarRpcAsyncClient",
    "StellarRpcClient",
    "__version__",
    "horizon_route",
    "sim_error_class",
    "tx_result_class",
]
