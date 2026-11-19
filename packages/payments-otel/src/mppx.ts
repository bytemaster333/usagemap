// SPDX-License-Identifier: Apache-2.0
// MPP (Machine Payments Protocol) servers built with `mppx` (≥ 0.19.0, `Mppx.create` from `mppx/server`), including
// the Stellar methods of `@stellar/mpp` (`stellar` / `charge` and `channel`).
//
// Hook points (public API, mppx 0.19.0 dist/server/Mppx.d.ts): `onChallengeCreated`, `onPaymentSuccess`,
// `onPaymentFailed`, each returning an unsubscribe function. mppx awaits handlers inline on the request path and
// swallows their errors; the handlers here are synchronous and never throw.
//
// Kept: method name, intent, network (`methodDetails.network`), currency (a public asset → symbol), status, problem
// type, and on request an amount bucket. Dropped, never read into an attribute: `payer`, `credential`, `receipt`
// (its `reference` is a transaction hash), `recipient`, `externalId`, `description`, the challenge id/realm/opaque,
// `input` / `capturedRequest` (the HTTP request) and the error message, `details` and `fundingUrl`.

import {
  amountBucket,
  assetOf,
  closed,
  MPP_INTENTS,
  MPP_METHODS,
  mppError,
  networkOf,
  OTHER,
  type PaymentNetwork,
  type Stage,
} from "./classify.ts";
import {
  attributes,
  counter,
  get,
  type InstrumentOptions,
  type PaymentEvent,
  safely,
} from "./common.ts";
import type { PaymentInstrumentation } from "./x402.ts";

interface MppCtx {
  readonly method: { readonly name: string; readonly intent: string };
  readonly request: unknown;
}
type Handler<C> = (ctx: C) => void;
type Unsubscribe = () => void;

/** Structural view of an mppx server instance (`Mppx.create(...)` from `mppx/server`). */
export interface MppxLike {
  onChallengeCreated(handler: Handler<MppCtx>): Unsubscribe;
  onPaymentSuccess(handler: Handler<MppCtx>): Unsubscribe;
  onPaymentFailed(handler: Handler<MppCtx & { readonly error: unknown }>): Unsubscribe;
}

/** Methods that are never on a Stellar network; their network is `other` even without `methodDetails.network`. */
const NON_STELLAR = new Set(["tempo", "stripe", "evm"]);

function fromContext(ctx: unknown): Omit<PaymentEvent, "protocol" | "stage"> {
  const m = get(ctx, "method");
  const method = closed(MPP_METHODS, get(m, "name"), OTHER);
  const intent = closed(MPP_INTENTS, get(m, "intent"), OTHER);
  const request = get(ctx, "request");
  const net = get(get(request, "methodDetails"), "network");
  let network: PaymentNetwork = networkOf(net);
  if (network === "unknown" && NON_STELLAR.has(method)) network = "other";
  const asset = assetOf(get(request, "currency"));
  return {
    method,
    intent,
    network,
    asset: asset?.symbol,
    amountBucket: amountBucket(get(request, "amount"), asset?.decimals),
  };
}

const handles = new WeakMap<object, PaymentInstrumentation>();

/**
 * Instrument an mppx server: `required` (challenge created), `paid` (payment success) and `failed` (payment failed,
 * with the problem type as `error.type`). Idempotent per instance; `detach()` unsubscribes.
 */
export function instrumentMppx(
  mppx: MppxLike,
  opts: InstrumentOptions = {},
): PaymentInstrumentation {
  const ok = (k: string) => typeof get(mppx, k) === "function";
  if (
    !mppx ||
    typeof mppx !== "object" ||
    !ok("onChallengeCreated") ||
    !ok("onPaymentSuccess") ||
    !ok("onPaymentFailed")
  )
    return { instrumented: false, detach() {} };
  const prior = handles.get(mppx);
  if (prior) return prior;

  const c = counter(opts.meter);
  const buckets = opts.amountBuckets === true;
  const record = (stage: Stage, ctx: unknown, extra: Partial<PaymentEvent> = {}) =>
    safely(() =>
      c.add(1, attributes({ protocol: "mpp", stage, ...fromContext(ctx), ...extra }, buckets)),
    );

  const subs: Unsubscribe[] = [];
  try {
    subs.push(mppx.onChallengeCreated((ctx) => record("required", ctx)));
    subs.push(mppx.onPaymentSuccess((ctx) => record("paid", ctx)));
    subs.push(
      mppx.onPaymentFailed((ctx) =>
        safely(() => {
          const { errorType, reasonClass } = mppError(get(ctx, "error"));
          record("failed", ctx, { errorType, reasonClass });
        }),
      ),
    );
  } catch {
    for (const u of subs) safely(u);
    return { instrumented: false, detach() {} };
  }
  let detached = false;
  const handle: PaymentInstrumentation = Object.freeze({
    instrumented: true,
    detach() {
      if (detached) return;
      detached = true;
      for (const u of subs) safely(() => u());
      handles.delete(mppx);
    },
  });
  handles.set(mppx, handle);
  return handle;
}
