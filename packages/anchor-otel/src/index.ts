// SPDX-License-Identifier: Apache-2.0
// `@usagemap/anchor-otel` — OpenTelemetry metrics for the wallet side of Stellar anchor flows.
//
//   import { Wallet } from "@stellar/typescript-wallet-sdk";
//   import { instrumentWalletSdk } from "@usagemap/anchor-otel";
//   const wallet = Wallet.MainNet();
//   instrumentWalletSdk(wallet);            // before wallet.anchor(…)
//
// Uses the application's own MeterProvider through `@opentelemetry/api` (peer dependency). Emits aggregates only:
// SEP, step, outcome class, funnel event, network and the anchor's public home domain. Never amounts, accounts, memos,
// KYC fields, tokens, transaction ids or URLs.

export type { AnchorEvent, Kind, Lifecycle, Network, Outcome, Sep, Step } from "./classify.ts";
export {
  EVENTS,
  homeDomainOf,
  KINDS,
  kindOf,
  LIFECYCLE,
  lifecycleOf,
  NETWORKS,
  networkOf,
  OTHER,
  OUTCOMES,
  outcomeOfError,
  outcomeOfStatus,
  RULES,
  SEPS,
  STEPS,
  stepOf,
} from "./classify.ts";
export type {
  AnchorLike,
  AnchorOtelOptions,
  AnchorTelemetry,
  AxiosLike,
  WalletLike,
} from "./instrument.ts";
export {
  ATTR_EVENT,
  ATTR_HOME_DOMAIN,
  ATTR_NETWORK,
  ATTR_OUTCOME,
  ATTR_SEP,
  ATTR_STEP,
  DURATION_BUCKETS,
  eventsOf,
  instrumentAnchorClient,
  instrumentWalletSdk,
  METRIC_EVENTS,
  METRIC_REQUEST_DURATION,
  SCOPE_NAME,
  SCOPE_VERSION,
} from "./instrument.ts";
export type { DomainPolicy } from "./registry.ts";
