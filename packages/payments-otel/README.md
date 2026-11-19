# @usagemap/payments-otel

OpenTelemetry metrics for **agent payments on your server**: how many requests got a `402`, how many payments were
verified, settled (x402) or paid (MPP), and why the others failed. It works with **x402** resource servers
(`@x402/core`, so also `@x402/express`, `@x402/hono`, `@x402/next`) and **MPP** servers built with **mppx**
(including the Stellar methods of `@stellar/mpp`). It records with **your own MeterProvider** (`@opentelemetry/api`
peer dependency) into **one counter** with closed attribute sets, and never records a payer, recipient, amount,
transaction hash, credential, signature, URL or anything from the HTTP request.

> Not on npm yet. Build it from this repository (`pnpm --filter @usagemap/payments-otel build`) and vendor
> `dist/`, or `npm pack` it.

Guide with the UsageMap setup: [`docs/onboarding/payments.md`](../../docs/onboarding/payments.md).

## Quickstart

```ts
// x402 (what @x402/express's paymentMiddlewareFromHTTPServer takes)
import { instrumentX402Http } from "@usagemap/payments-otel";
const httpServer = new x402HTTPResourceServer(resourceServer, routes);
instrumentX402Http(httpServer);                   // required + verified + settled + failed + canceled
app.use(paymentMiddlewareFromHTTPServer(httpServer));

// Only an x402ResourceServer at hand (paymentMiddleware(routes, resourceServer)):
instrumentX402(resourceServer);                   // everything except `required`

// MPP
import { instrumentMppx } from "@usagemap/payments-otel";
const mppx = Mppx.create({ methods: [stellar.charge({ /* … */ })], secretKey });
instrumentMppx(mppx);                             // required + paid + failed
```

Each function returns `{ instrumented, detach() }`, never throws and never changes a payment: every hook returns
nothing (no abort, recover, skip or grant), and recording errors are swallowed. Calling it twice on the same server
returns the first handle. `instrumented: false` means the object lacks the hook API and nothing was registered.

## Supported versions

| Library | Peer range | Tested at | Hook points (public API) |
|---|---|---|---|
| `@x402/core` | `>=2.31.0 <3` (optional) | 2.31.0, with `@x402/stellar` 2.31.0 and `@x402/express` 2.31.0 | `x402ResourceServer.onAfterVerify`, `onVerifyFailure`, `onAfterSettle`, `onSettleFailure`, `onVerifiedPaymentCanceled`; `x402HTTPResourceServer.onProtectedRequest` |
| `mppx` | `>=0.19.0 <1` (optional) | 0.19.0 | `Mppx#onChallengeCreated`, `onPaymentSuccess`, `onPaymentFailed` (unsubscribed by `detach()`) |
| `@opentelemetry/api` | `>=1.9.0 <2` | 1.10.0 | |

x402 has no API to remove a hook: after `detach()` the x402 hooks stay registered and do nothing.

## What is recorded

One counter, **`payment.server.events`** (`{event}`, monotonic), scope `@usagemap/payments-otel`.

| Attribute | When | Values (closed) |
|---|---|---|
| `payment.protocol` | always | `x402`, `mpp` |
| `payment.stage` | always | `required`, `verified`, `settled`, `paid`, `failed`, `canceled` |
| `payment.scheme` | x402 | `exact`, `upto`, `_OTHER` |
| `payment.method` | mpp | `stellar`, `tempo`, `stripe`, `evm`, `_OTHER` |
| `payment.intent` | mpp | `charge`, `session`, `channel`, `subscription`, `_OTHER` |
| `payment.network` | always | `stellar:pubnet`, `stellar:testnet`, `other` (any other chain or rail), `unknown` |
| `payment.asset` | when known | `USDC`, `XLM`, `USD`, `EUR`, `_OTHER` |
| `payment.amount_bucket` | opt-in, not on failures | `lt_0.001`, `0.001_0.01`, `0.01_0.1`, `0.1_1`, `1_10`, `ge_10` (whole units of USDC/XLM) |
| `payment.reason_class` | `failed`, `canceled` | 27 classes, e.g. `wrong_amount`, `bad_signature`, `expired`, `settle_failed`, `timeout`, `other` |
| `error.type` | `failed`, `canceled` | x402: one of 50 reason codes of `@x402/core` / `@x402/stellar` 2.31.0, `timeout`, `facilitator_error` or `_OTHER`; mpp: one of the 19 problem types of mppx (`verification-failed`, `session/insufficient-balance`, …), `credential-replayed` or `_OTHER` |

The exported lists (`STAGES`, `REASON_CLASSES`, `X402_ERROR_TYPES`, `MPP_ERROR_TYPES`, …) are the complete sets.

**Stages.** `required`: a 402 was issued (x402: a protected request without a payment header; mpp: a challenge was
created, including the new challenge after a rejected credential). `verified`: the x402 facilitator accepted the
signed payment. `settled`: x402 settlement succeeded. `paid`: mppx reported a successful payment (for a Stellar
charge that is the verified transfer; for a session an accepted voucher). `failed`: verification or settlement
failed, or the facilitator call threw. `canceled`: a verified x402 payment was canceled before settlement (your
handler failed, a hook aborted, preflight failed).

**Assets.** Stellar assets are recognised by their Stellar Asset Contract id (USDC and native XLM on pubnet and
testnet, ids derived with `Asset#contractId` and identical to the ids in `@x402/stellar` 2.31.0), by `native` and by
the classic `USDC:<Circle issuer>` form; every other token is `_OTHER`. Note: `@stellar/mpp` 0.7.1 `constants.js`
ships mainnet `USDC_SAC_MAINNET` and `XLM_SAC_MAINNET` values that are not valid contract ids (54 and 55
characters); payments configured with them are counted as `_OTHER`.

**Never recorded:** `payer`, `payTo` / `recipient`, `transaction` and `receipt.reference` (transaction hashes),
`amount` (only the opt-in bucket), credentials and signatures, `externalId`, `description`, challenge ids, the
resource URL and query string, headers, `invalidMessage` / `errorMessage` / problem `detail`. The UsageMap Collector
applies the same closed sets again on ingest and drops everything else.

## Caveats

- x402 `required` is counted in an `onProtectedRequest` hook. Register your own access hooks first: when an earlier
  hook grants access the chain stops and the request is (correctly) not counted; a hook registered after ours that
  grants access would still have been counted as `required`.
- x402 verification aborted by an `onBeforeVerify` hook returns `isValid: false` without running the after-verify
  hooks, so it is not counted. If another `onVerifyFailure` hook recovers a thrown verification, it is counted as
  both `failed` and `verified`.
- A settlement in the `cancel` phase is not counted as `settled` or `failed`; the cancellation is counted once as
  `canceled`.
- mppx awaits event handlers inline on the request path; ours are synchronous and do one counter add.
