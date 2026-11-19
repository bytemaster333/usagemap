// SPDX-License-Identifier: Apache-2.0
// `@usagemap/payments-otel` — OpenTelemetry metrics for agent payments on the server: x402 resource servers and
// MPP servers built with mppx (including the Stellar methods of `@stellar/mpp`).
//
//   import { instrumentX402Http, instrumentMppx } from "@usagemap/payments-otel";
//   instrumentX402Http(httpServer);   // x402HTTPResourceServer (or instrumentX402(resourceServer))
//   instrumentMppx(mppx);             // Mppx.create({ methods: [stellar.charge(...)] , ... })
//
// One counter, `payment.server.events`, with closed attribute sets. Uses the application's own MeterProvider through
// `@opentelemetry/api` (peer dependency). Never records a payer, recipient, amount, transaction hash, credential,
// signature, URL or any part of the HTTP request.

export type {
  AmountBucket,
  AssetSymbol,
  PaymentNetwork,
  Protocol,
  ReasonClass,
  Stage,
} from "./classify.ts";
export {
  AMOUNT_BUCKETS,
  ASSETS,
  amountBucket,
  MPP_ERROR_TYPES,
  MPP_INTENTS,
  MPP_METHODS,
  mppError,
  NETWORKS,
  PROTOCOLS,
  REASON_CLASSES,
  STAGES,
  X402_ERROR_TYPES,
  X402_SCHEMES,
  x402ReasonClass,
} from "./classify.ts";
export type { InstrumentOptions } from "./common.ts";
export { ATTRIBUTE_KEYS, METRIC_PAYMENT_EVENTS, SCOPE_NAME, SCOPE_VERSION } from "./common.ts";
export type { MppxLike } from "./mppx.ts";
export { instrumentMppx } from "./mppx.ts";
export type {
  PaymentInstrumentation,
  X402HttpServerLike,
  X402RequirementsLike,
  X402ResourceServerLike,
} from "./x402.ts";
export { instrumentX402, instrumentX402Http } from "./x402.ts";
