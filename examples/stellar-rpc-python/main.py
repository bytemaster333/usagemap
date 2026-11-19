# SPDX-License-Identifier: Apache-2.0
# A Python backend that talks to Stellar RPC and Horizon with py-stellar-base. Wrapping the SDK's HTTP client once per
# server makes every RPC method and Horizon route measurable in UsageMap (latency, outcome class, network); no URL,
# address, hash or XDR is recorded.
import os

import otel_setup
from scf_stellar_otel import HorizonClient, StellarRpcClient
from stellar_sdk import Server, SorobanServer

RPC_URL = os.environ.get("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org")
HORIZON_URL = os.environ.get("HORIZON_URL", "https://horizon-testnet.stellar.org")

# UsageMap: pass the instrumented client to each server.
rpc = SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))
horizon = Server(HORIZON_URL, client=HorizonClient(network="testnet"))

health = rpc.get_health()
network = rpc.get_network()
fees = horizon.fee_stats().call()
print(f"rpc {health.status}, protocol {network.protocol_version}, fee p50 {fees['fee_charged']['p50']}")

otel_setup.shutdown()  # export now; a long-running server exports every 60 s instead
