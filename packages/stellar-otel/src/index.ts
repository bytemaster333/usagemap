// SPDX-License-Identifier: Apache-2.0
// `@usagemap/stellar-otel` — OpenTelemetry metrics for js-stellar-sdk (server side; supported SDK majors: 13 to 17).
//
//   import { rpc, Horizon } from "@stellar/stellar-sdk";
//   import { instrumentStellarRpc, instrumentHorizon } from "@usagemap/stellar-otel";
//   instrumentStellarRpc(new rpc.Server(RPC_URL), { network: "testnet" });   // SDK 14.3.1 … 17.x
//   instrumentStellarRpc(rpc, { network: "testnet" });                        // SDK 13.x … 14.3.0 (module-wide)
//
// Uses the application's own MeterProvider through `@opentelemetry/api` (peer dependency). Emits aggregates only:
// no address, transaction hash, XDR, key, URL or user identifier is ever an attribute.

export type { Network, ResultClass, RpcMethod, SimErrorClass } from "./classify.ts";
export {
  HORIZON_TEMPLATES,
  horizonRoute,
  NETWORKS,
  POLL_STATUSES,
  RESULT_CLASSES,
  RPC_METHODS,
  SIM_ERROR_CLASSES,
  SIM_OUTCOMES,
  SUBMIT_STATUSES,
  simErrorClass,
  txResultClass,
} from "./classify.ts";
export type { HttpClientLike, Instrumentation, InstrumentOptions, ServerLike } from "./common.ts";
export {
  DURATION_BUCKETS,
  METRIC_HTTP_DURATION,
  METRIC_POLLS,
  METRIC_RPC_DURATION,
  METRIC_SIMULATIONS,
  METRIC_SUBMISSIONS,
  SCOPE_NAME,
  SCOPE_VERSION,
} from "./common.ts";
export { instrumentHorizon } from "./horizon.ts";
export { instrumentStellarRpc } from "./rpc.ts";
