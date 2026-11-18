# Paid APIs on Stellar (x402, MPP): payment metrics in 10 minutes

You sell API calls to agents with **x402** (`@x402/express`, `@x402/hono`, `@x402/next`, or `@x402/core` directly)
or with **MPP** through **mppx** (for example with the Stellar `charge` method of `@stellar/mpp`). One function call
adds payment counts to the OpenTelemetry metrics you already send to UsageMap: how many requests got a `402`, how many
payments were verified, settled or paid, and a closed reason class for every failure.

**Tested:** the example service [`examples/api-x402`](../../examples/api-x402/) (Express 5.3.0, `@x402/express`
2.31.0, `@x402/stellar` 2.31.0, Node 24) is started as a real process by
`packages/payments-otel/test/example-x402.test.ts`, against a local stand-in of an x402 facilitator and of the
UsageMap OTLP endpoint. The test pays like an agent (402 → signed payment → 200, and one payment the facilitator
rejects), stops the service with `SIGTERM` and checks the one export it sends: exactly 2 `required`, 1 `verified`,
1 `settled`, 1 `failed` (`invalid_exact_stellar_payload_wrong_amount`), and no payer, payee, transaction hash,
amount, path or query string anywhere in the payload. The mppx hooks are tested against a real `Mppx.create` server
in `packages/payments-otel/test/mppx.test.ts`.

| Minute | Step |
|---|---|
| 0–2 | Your API already sends OpenTelemetry metrics to UsageMap ([Node.js / Express](api-node-express.md) or [dual export](api-dual-export.md)) |
| 2–4 | Add the package |
| 4–6 | One line next to your x402 or mppx setup |
| 6–10 | Pay once on testnet; after one export interval the counts are in UsageMap |

## 1. Package

`@usagemap/payments-otel` is not on npm yet: build it from the UsageMap repository and vendor `dist/`, or
`npm pack` it.

```sh
pnpm --filter @usagemap/payments-otel build      # in the UsageMap repository
```

Peer dependencies: `@opentelemetry/api` `>=1.9.0 <2`, and the payment library you use: `@x402/core` `>=2.31.0 <3`
or `mppx` `>=0.19.0 <1`. The package has no runtime dependencies of its own.

## 2. x402

Instrument the `x402HTTPResourceServer` and hand it to the middleware with `paymentMiddlewareFromHTTPServer`
(available in `@x402/express`, `@x402/hono` and `@x402/next`):

```js
import { instrumentX402Http } from "@usagemap/payments-otel";
import { HTTPFacilitatorClient, x402HTTPResourceServer } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL }));
resourceServer.register("stellar:testnet", new ExactStellarScheme());
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /report": {
    accepts: { scheme: "exact", network: "stellar:testnet", payTo: process.env.PAY_TO, price: "$0.01" },
    description: "One market report",
  },
});
instrumentX402Http(httpServer);                       // ← the one line
app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

Using `paymentMiddleware(routes, resourceServer)` instead? Call `instrumentX402(resourceServer)`: you get everything
except `required`, which UsageMap then shows from the `402` share of your HTTP server metrics.

If you register your own `onProtectedRequest` hooks (API keys, free tiers), register them **before**
`instrumentX402Http`, so requests they let through are not counted as `required`.

## 3. MPP (mppx)

```js
import { instrumentMppx } from "@usagemap/payments-otel";
import { Mppx } from "mppx/server";

const mppx = Mppx.create({ methods: [/* e.g. stellar.charge({ … }) from @stellar/mpp */], secretKey });
instrumentMppx(mppx);                                 // ← the one line
```

It subscribes to `onChallengeCreated`, `onPaymentSuccess` and `onPaymentFailed`. `@stellar/mpp` 0.7.1 declares a
peer range of `mppx ^0.6.29`, while this package needs mppx 0.19.0 or later (the version it is tested with; typed
server events date from mppx 0.6.21 according to its CHANGELOG, but older versions are not tested). Check which
mppx your server loads with `npm ls mppx`.

## 4. Export

Nothing changes in your OpenTelemetry setup: the package records with the global `MeterProvider` (or the `meter`
you pass). The example's [`otel.mjs`](../../examples/api-x402/otel.mjs) is a complete metrics-only setup:

```sh
OTEL_SERVICE_NAME=paid-api \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://ingest.scf.example/v1/metrics \
OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20${SCF_OTLP_TOKEN}" \
PAY_TO=G… FACILITATOR_URL=https://… \
node --import ./otel.mjs server.mjs
```

## 5. What UsageMap receives

One counter, `payment.server.events`, with these attributes and nothing else (the full value lists are in the
[package README](../../packages/payments-otel/README.md#what-is-recorded)):

| Attribute | Example values |
|---|---|
| `payment.protocol` | `x402`, `mpp` |
| `payment.stage` | `required`, `verified`, `settled`, `paid`, `failed`, `canceled` |
| `payment.scheme` (x402) · `payment.method`, `payment.intent` (mpp) | `exact` · `stellar`, `charge` |
| `payment.network` | `stellar:pubnet`, `stellar:testnet`, `other`, `unknown` |
| `payment.asset` | `USDC`, `XLM`, `USD`, `EUR`, `_OTHER` |
| `payment.reason_class`, `error.type` (failures only) | `wrong_amount`, `invalid_exact_stellar_payload_wrong_amount`; `verification_failed`, `verification-failed` |
| `payment.amount_bucket` (opt-in) | `0.001_0.01` (whole USDC/XLM) |

**Never sent:** payer and recipient addresses, transaction hashes (`transaction`, `receipt.reference`), amounts,
credentials and signatures, `externalId`, the resource URL, query strings, headers and error messages. The amount
bucket is off by default because even a bucket is commercial information; turn it on with
`instrumentX402Http(httpServer, { amountBuckets: true })` (same option for the other two functions).

What the numbers mean, honestly:

- **These are your server's own counts.** Like all API telemetry, UsageMap cannot prove them. A settled x402
  payment on Stellar is also an on-chain transfer to your `payTo` account, which anyone can check on the ledger; the
  metrics deliberately do not carry the hash or the account, so the two are not linked per payment.
- `required` counts 402 answers, not distinct agents: an agent that retries is counted each time.
- `verified` without a later `settled` usually means settlement failed (`failed` with a `settle_*` reason) or the
  payment was `canceled` because your handler failed.

## Troubleshooting

| Symptom | Check |
|---|---|
| `instrumented: false` | You passed something other than an `x402ResourceServer`, `x402HTTPResourceServer` or `Mppx.create` result, or an x402 version before 2.31.0. |
| No `required` counts with x402 | You used `instrumentX402` (no HTTP server), or one of your own `onProtectedRequest` hooks grants access first. |
| `payment.asset` is `_OTHER` | The asset is not USDC or XLM on Stellar (by contract id, `native` or `USDC:<Circle issuer>`). With `@stellar/mpp` 0.7.1, its `USDC_SAC_MAINNET` / `XLM_SAC_MAINNET` constants are malformed; use the contract ids from the package README. |
| Counts arrive only after a minute | That is the default export interval (`OTEL_METRIC_EXPORT_INTERVAL`, 60 s); the example flushes on `SIGTERM`. |
