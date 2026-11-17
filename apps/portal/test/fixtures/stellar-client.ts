// SPDX-License-Identifier: Apache-2.0
// Fixture of known value for the "Stellar RPC & Horizon (from your backend)" panel (C-153): the answer of
// getStellarClientMetrics for the mock's Horizon-proxy service. Every figure is FAKE.

import type { ControlPlane } from "@usagemap/api-types";

export function stellarClientFixture(
  range: ControlPlane.StellarClientMetrics["range"],
): ControlPlane.StellarClientMetrics {
  return {
    range,
    networks: ["mainnet", "testnet"],
    rpc_methods: [
      {
        method: "sendTransaction",
        network: "mainnet",
        calls: 1200,
        errors: 36,
        error_rate: 0.03,
        p50_ms: 180,
        p95_ms: 740,
        mean_ms: 230,
        accuracy_class: "explicit15",
        outcomes: [
          { outcome: "ok", count: 1164 },
          { outcome: "-32602", count: 30 },
          { outcome: "timeout", count: 6 },
        ],
      },
      {
        method: "getLatestLedger",
        network: "testnet",
        calls: 300,
        errors: 0,
        error_rate: 0,
        p50_ms: 4,
        p95_ms: 9,
        mean_ms: 5,
        accuracy_class: "explicit15",
        outcomes: [{ outcome: "ok", count: 300 }],
      },
    ],
    horizon_routes: [
      {
        route: "/accounts/{id}",
        http_method: "GET",
        network: "mainnet",
        calls: 900,
        errors: 45,
        error_rate: 0.05,
        p50_ms: 60,
        p95_ms: 240,
        mean_ms: 80,
        accuracy_class: "explicit15",
        outcomes: [
          { outcome: "200", count: 855 },
          { outcome: "404", count: 45 },
        ],
      },
    ],
    transactions: {
      submissions: [
        { network: "mainnet", via: "rpc", status: "PENDING", result_class: null, count: 1100 },
        { network: "mainnet", via: "rpc", status: "ERROR", result_class: "bad_seq", count: 12 },
      ],
      polls: [
        { network: "mainnet", via: null, status: "SUCCESS", result_class: null, count: 1050 },
        {
          network: "mainnet",
          via: null,
          status: "FAILED",
          result_class: "contract_error",
          count: 9,
        },
      ],
      simulations: [
        { network: "mainnet", outcome: "success", error_class: null, count: 1300 },
        { network: "mainnet", outcome: "restore_required", error_class: null, count: 4 },
      ],
    },
  };
}

export function emptyStellarClient(
  range: ControlPlane.StellarClientMetrics["range"],
): ControlPlane.StellarClientMetrics {
  return {
    range,
    networks: [],
    rpc_methods: [],
    horizon_routes: [],
    transactions: { submissions: [], polls: [], simulations: [] },
  };
}
