# Paid API with MPP (mppx)

A paid HTTP API: `GET /report` costs 0.01 USDC on Stellar testnet through the Machine Payments Protocol (`mppx`
0.19.0). One line, `instrumentMppx(mppx)`, counts payments **required**, **paid** and **failed** (with a closed reason
class) — never payers, recipients, amounts, transaction hashes or credentials. Guide:
[Agent payments §3 (MPP)](../../docs/onboarding/payments.md#3-mpp-mppx).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/payments-otel build && pnpm --dir examples install`.
2. **Set your key:** **Project → API services → Add** (service `paid-api`) and an ingest token:
   `export OTEL_SERVICE_NAME=paid-api OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20scfa_ing_…"`
   (optional: `PAY_TO=G…` your account, `MPP_SECRET_KEY=$(openssl rand -base64 32)`).
3. **Run:** `cd examples/payments-mpp && pnpm start`, then in a second shell `pnpm run pay` (402, then paid → 200) and
   `pnpm run pay bad` (a payment the server refuses). Stop the server with Ctrl-C: the last counts are exported.

## The lines that add UsageMap

`server.mjs`:

```js
import "./otel.mjs";
// …
import { instrumentMppx } from "@usagemap/payments-otel";
// …
// UsageMap: payment required / paid / failed counts.
instrumentMppx(mppx);
```

**Honest note:** `stellar-charge.mjs` is a stand-in for `stellar.charge` from `@stellar/mpp` so that the example runs
offline: same method name, intent and request schema, but `verify` accepts one demo hash instead of checking the
ledger. `@stellar/mpp` 0.7.1 declares `mppx ^0.6.29`, older than the 0.19.0 this package is tested with (see the
guide). In your server, put `stellar.charge({ … })` in `methods`; the UsageMap line does not change.

## What you'll see in the portal

**API services → paid-api**: the payments counter `payment.server.events` — `required` (each 402 challenge, so
retries count), `paid`, and `failed` with `verification_failed`, all `mpp` / `stellar` / `charge` / `stellar:testnet`
/ `USDC`. These are your server's own counts (self-reported); a settled payment is also an on-chain transfer that
anyone can check.

## Test it without the app

The portal's API test (**Integrations → the card → Test**) sends one marked data point for your service through
the same endpoint. It is recorded as a baseline point in the service's data-quality table and never counted:

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://e1.usagemap.dev/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"paid-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` starts `server.mjs`, runs `pay.mjs` (paid) and `pay.mjs bad`
(refused), stops the server with SIGTERM and checks at the UsageMap stand-in: required ≥ 2, paid 1, failed 1
(`verification_failed`), bearer token, and that the payee, the secret, the credential hashes and the amount never
arrive. No real Stellar payment is made.
