// SPDX-License-Identifier: Apache-2.0
// x402 resource servers (`@x402/core` ≥ 2.31.0 `x402ResourceServer` and `x402HTTPResourceServer`, which
// `@x402/express`, `@x402/hono` and `@x402/next` build on).
//
// Hook points (public API, `@x402/core` 2.31.0 dist/esm/x402Client-*.d.mts, class x402ResourceServer):
//   onAfterVerify (also runs for `isValid: false`), onVerifyFailure (facilitator call threw), onAfterSettle (success
//   only), onSettleFailure (`success: false` or a throw after the facilitator was called), onVerifiedPaymentCanceled;
//   and x402HTTPResourceServer#onProtectedRequest for the unpaid request that gets the 402.
// Every hook here returns `undefined`: it never aborts, recovers, skips or changes a payment.
//
// Never read into an attribute: `payer`, `payTo`, `transaction`, `amount` (only an opt-in bucket), the payment
// payload, signatures, the resource URL, `invalidMessage`/`errorMessage`, extensions, headers.

import {
  amountBucket,
  assetOf,
  closed,
  networkOf,
  OTHER,
  type PaymentNetwork,
  type ReasonClass,
  type Stage,
  X402_SCHEMES,
  x402ErrorType,
  x402ReasonClass,
} from "./classify.ts";
import {
  attributes,
  counter,
  get,
  type InstrumentOptions,
  type PaymentEvent,
  safely,
} from "./common.ts";

/** The fields of x402 `PaymentRequirements` this package reads (structural; the real type has more). */
export interface X402RequirementsLike {
  readonly scheme?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly amount?: string;
}
interface X402Ctx {
  readonly requirements?: X402RequirementsLike | undefined;
}
interface X402SettleCtx extends X402Ctx {
  readonly phase?: string;
}
type Hook<C> = (ctx: C) => Promise<void>;

/** Structural view of `x402ResourceServer` (the hook registration methods). */
export interface X402ResourceServerLike {
  onAfterVerify(
    hook: Hook<
      X402Ctx & {
        readonly result: { readonly isValid: boolean; readonly invalidReason?: string | undefined };
      }
    >,
  ): unknown;
  onVerifyFailure(hook: Hook<X402Ctx & { readonly error: Error }>): unknown;
  onAfterSettle(
    hook: Hook<X402SettleCtx & { readonly result: { readonly amount?: string | undefined } }>,
  ): unknown;
  onSettleFailure(hook: Hook<X402SettleCtx & { readonly error: Error }>): unknown;
  onVerifiedPaymentCanceled?(hook: Hook<X402SettleCtx & { readonly reason: string }>): unknown;
}

/** Structural view of `x402HTTPResourceServer`. */
export interface X402HttpServerLike {
  readonly server: X402ResourceServerLike;
  onProtectedRequest(
    hook: (
      ctx: { readonly paymentHeader?: string | undefined },
      routeConfig: unknown,
    ) => Promise<void>,
  ): unknown;
}

export interface PaymentInstrumentation {
  /** False when the object lacks the hook API (nothing was registered). */
  readonly instrumented: boolean;
  /**
   * Stop recording. x402 has no API to remove a hook, so the hooks stay registered and become no-ops; mppx
   * handlers are unsubscribed. Idempotent.
   */
  detach(): void;
}

const NOT_INSTRUMENTED: PaymentInstrumentation = Object.freeze({
  instrumented: false,
  detach() {},
});

const resourceHandles = new WeakMap<object, PaymentInstrumentation>();
const httpHandles = new WeakMap<object, PaymentInstrumentation>();

const isFn = (o: unknown, k: string) => typeof get(o, k) === "function";

function fromRequirements(
  req: unknown,
  amountOverride?: unknown,
): Pick<PaymentEvent, "scheme" | "network" | "asset" | "amountBucket"> {
  const asset = assetOf(get(req, "asset"));
  const amount = typeof amountOverride === "string" ? amountOverride : get(req, "amount");
  return {
    scheme: closed(X402_SCHEMES, get(req, "scheme"), OTHER),
    network: networkOf(get(req, "network")),
    asset: asset?.symbol,
    amountBucket: amountBucket(amount, asset?.decimals),
  };
}

/** Error thrown by a facilitator call → x402 reason (or our `timeout` / `facilitator_error`). */
function thrownReason(err: unknown, field: "invalidReason" | "errorReason"): string {
  const name = get(err, "name");
  if (name === "FacilitatorTimeoutError") return "timeout";
  const r = get(err, field);
  return typeof r === "string" && r.length > 0 ? r : "facilitator_error";
}

function failure(reason: string): { reasonClass: ReasonClass; errorType: string } {
  return { reasonClass: x402ReasonClass(reason), errorType: x402ErrorType(reason) };
}

/**
 * Instrument an `x402ResourceServer`: `verified`, `settled`, `failed` and `canceled` events. Call it once at
 * start-up, before serving. Idempotent per server. Use {@link instrumentX402Http} instead when you have the
 * `x402HTTPResourceServer` (it also counts `required`).
 */
export function instrumentX402(
  server: X402ResourceServerLike,
  opts: InstrumentOptions = {},
): PaymentInstrumentation {
  if (
    !server ||
    typeof server !== "object" ||
    !["onAfterVerify", "onVerifyFailure", "onAfterSettle", "onSettleFailure"].every((k) =>
      isFn(server, k),
    )
  )
    return NOT_INSTRUMENTED;
  const prior = resourceHandles.get(server);
  if (prior) return prior;

  const c = counter(opts.meter);
  const buckets = opts.amountBuckets === true;
  let on = true;
  const emit = (e: PaymentEvent) => {
    if (on) safely(() => c.add(1, attributes(e, buckets)));
  };
  const ev = (stage: Stage, req: unknown, extra: Partial<PaymentEvent> = {}, amount?: unknown) =>
    safely(() => emit({ protocol: "x402", stage, ...fromRequirements(req, amount), ...extra }));

  try {
    server.onAfterVerify(async (ctx) => {
      safely(() => {
        const result = get(ctx, "result");
        if (get(result, "isValid") === true) ev("verified", get(ctx, "requirements"));
        else {
          const r = get(result, "invalidReason");
          ev("failed", get(ctx, "requirements"), failure(typeof r === "string" ? r : ""));
        }
      });
    });
    server.onVerifyFailure(async (ctx) => {
      ev(
        "failed",
        get(ctx, "requirements"),
        failure(thrownReason(get(ctx, "error"), "invalidReason")),
      );
    });
    server.onAfterSettle(async (ctx) => {
      if (get(ctx, "phase") === "cancel") return; // a cancellation settles nothing new (see `canceled`)
      ev("settled", get(ctx, "requirements"), {}, get(get(ctx, "result"), "amount"));
    });
    server.onSettleFailure(async (ctx) => {
      if (get(ctx, "phase") === "cancel") return;
      ev(
        "failed",
        get(ctx, "requirements"),
        failure(thrownReason(get(ctx, "error"), "errorReason")),
      );
    });
    if (isFn(server, "onVerifiedPaymentCanceled"))
      server.onVerifiedPaymentCanceled?.(async (ctx) => {
        const r = get(ctx, "reason");
        ev("canceled", get(ctx, "requirements"), failure(typeof r === "string" ? r : ""));
      });
  } catch {
    return NOT_INSTRUMENTED;
  }
  const handle: PaymentInstrumentation = Object.freeze({
    instrumented: true,
    detach() {
      on = false;
    },
  });
  resourceHandles.set(server, handle);
  return handle;
}

/** Route config `accepts` (one option or a list) → network/scheme when every option agrees; asset if explicit. */
function fromRoute(
  routeConfig: unknown,
): Pick<PaymentEvent, "scheme" | "network" | "asset" | "amountBucket"> {
  const a = get(routeConfig, "accepts");
  const options: unknown[] = Array.isArray(a) ? a.slice(0, 32) : a === undefined ? [] : [a];
  const nets = new Set<PaymentNetwork>();
  const schemes = new Set<string>();
  for (const o of options) {
    nets.add(networkOf(get(o, "network")));
    schemes.add(closed(X402_SCHEMES, get(o, "scheme"), OTHER));
  }
  const out: Pick<PaymentEvent, "scheme" | "network" | "asset" | "amountBucket"> = {
    network: nets.size === 1 ? [...nets][0] : "unknown",
  };
  if (schemes.size === 1) out.scheme = [...schemes][0];
  if (options.length === 1) {
    // Only an explicit `{ asset, amount }` price names the asset; a money price ("$0.01") is resolved by the scheme.
    const price = get(options[0], "price");
    const asset = assetOf(get(price, "asset"));
    if (asset) {
      out.asset = asset.symbol;
      out.amountBucket = amountBucket(get(price, "amount"), asset.decimals);
    }
  }
  return out;
}

/**
 * Whether the request carries a payment. Framework middlewares fill `paymentHeader`; a direct `processHTTPRequest`
 * caller may not, so the adapter's `PAYMENT-SIGNATURE` (v2) / `X-PAYMENT` (v1) header is checked too. Only presence
 * is read; the value is never kept.
 */
function hasPayment(ctx: unknown): boolean {
  const h = get(ctx, "paymentHeader");
  if (typeof h === "string" && h.length > 0) return true;
  const adapter = get(ctx, "adapter");
  const getHeader = get(adapter, "getHeader");
  if (typeof getHeader !== "function") return false;
  for (const name of ["payment-signature", "x-payment"]) {
    const v: unknown = getHeader.call(adapter, name);
    if (typeof v === "string" && v.length > 0) return true;
  }
  return false;
}

/**
 * Instrument an `x402HTTPResourceServer` (what `paymentMiddlewareFromHTTPServer` of `@x402/express`, `@x402/hono`
 * and `@x402/next` takes): `required` for each protected request that arrives without a payment header, plus
 * everything {@link instrumentX402} records on its `server`. Register your own `onProtectedRequest` hooks first: a
 * hook that grants access ends the chain, and such a request is then not counted.
 */
export function instrumentX402Http(
  httpServer: X402HttpServerLike,
  opts: InstrumentOptions = {},
): PaymentInstrumentation {
  if (!httpServer || typeof httpServer !== "object" || !isFn(httpServer, "onProtectedRequest"))
    return NOT_INSTRUMENTED;
  const prior = httpHandles.get(httpServer);
  if (prior) return prior;
  let inner: PaymentInstrumentation;
  try {
    inner = instrumentX402(httpServer.server, opts);
  } catch {
    inner = NOT_INSTRUMENTED;
  }
  const c = counter(opts.meter);
  const buckets = opts.amountBuckets === true;
  let on = true;
  try {
    httpServer.onProtectedRequest(async (ctx, routeConfig) => {
      if (!on) return;
      safely(() => {
        if (hasPayment(ctx)) return; // a paid attempt: the verify/settle hooks count it
        c.add(
          1,
          attributes({ protocol: "x402", stage: "required", ...fromRoute(routeConfig) }, buckets),
        );
      });
    });
  } catch {
    return inner;
  }
  const handle: PaymentInstrumentation = Object.freeze({
    instrumented: true,
    detach() {
      on = false;
      inner.detach();
    },
  });
  httpHandles.set(httpServer, handle);
  return handle;
}
