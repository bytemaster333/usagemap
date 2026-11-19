// SPDX-License-Identifier: Apache-2.0
// The meter, the one counter and the shared recording path.

import { type Attributes, type Counter, type Meter, metrics, ValueType } from "@opentelemetry/api";
import type {
  AmountBucket,
  AssetSymbol,
  PaymentNetwork,
  Protocol,
  ReasonClass,
  Stage,
} from "./classify.ts";

/** Instrumentation scope name and version of the counter this package creates. */
export const SCOPE_NAME = "@usagemap/payments-otel";
export const SCOPE_VERSION = "0.1.0";

/** The only metric: a monotonic counter of payment lifecycle events on the server. */
export const METRIC_PAYMENT_EVENTS = "payment.server.events";

/** Every attribute key the counter can carry (the Collector allow-list for `payment.server.events`). */
export const ATTRIBUTE_KEYS = [
  "payment.protocol",
  "payment.stage",
  "payment.scheme",
  "payment.method",
  "payment.intent",
  "payment.network",
  "payment.asset",
  "payment.amount_bucket",
  "payment.reason_class",
  "error.type",
] as const;

export interface InstrumentOptions {
  /** OTel `Meter` to record with; default `metrics.getMeter("@usagemap/payments-otel")` (the global provider). */
  meter?: Meter;
  /**
   * Add `payment.amount_bucket` (amount in whole units, bucketed: `lt_0.001` … `ge_10`) to `required`, `verified`,
   * `settled` and `paid` events of USDC/XLM on Stellar. Off by default: even a bucket is commercial information.
   */
  amountBuckets?: boolean;
}

export interface PaymentEvent {
  protocol: Protocol;
  stage: Stage;
  scheme?: string | undefined;
  method?: string | undefined;
  intent?: string | undefined;
  network?: PaymentNetwork | undefined;
  asset?: AssetSymbol | undefined;
  amountBucket?: AmountBucket | undefined;
  reasonClass?: ReasonClass | undefined;
  errorType?: string | undefined;
}

const cache = new WeakMap<Meter, Counter>();
export function counter(meter: Meter | undefined): Counter {
  const m = meter ?? metrics.getMeter(SCOPE_NAME, SCOPE_VERSION);
  const hit = cache.get(m);
  if (hit) return hit;
  const c = m.createCounter(METRIC_PAYMENT_EVENTS, {
    unit: "{event}",
    valueType: ValueType.INT,
    description:
      "Agent payment lifecycle events on the server (x402, MPP): required, verified, settled, paid, failed, canceled",
  });
  cache.set(m, c);
  return c;
}

/** Build the attribute set; values are already closed (classify.ts). */
export function attributes(e: PaymentEvent, amountBuckets: boolean): Attributes {
  const a: Attributes = { "payment.protocol": e.protocol, "payment.stage": e.stage };
  if (e.scheme !== undefined) a["payment.scheme"] = e.scheme;
  if (e.method !== undefined) a["payment.method"] = e.method;
  if (e.intent !== undefined) a["payment.intent"] = e.intent;
  a["payment.network"] = e.network ?? "unknown";
  if (e.asset !== undefined) a["payment.asset"] = e.asset;
  const ok = e.stage !== "failed" && e.stage !== "canceled";
  if (amountBuckets && ok && e.amountBucket !== undefined)
    a["payment.amount_bucket"] = e.amountBucket;
  if (!ok) {
    a["payment.reason_class"] = e.reasonClass ?? "other";
    if (e.errorType !== undefined) a["error.type"] = e.errorType;
  }
  return a;
}

/** Run instrumentation code; it must never break, delay or alter the payment flow. */
export const safely = (f: () => void): void => {
  try {
    f();
  } catch {
    /* instrumentation never breaks a payment */
  }
};

/** Read a property without letting a hostile getter escape. */
export const get = (o: unknown, k: string): unknown => {
  try {
    return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  } catch {
    return undefined;
  }
};
