# Anchor flows from a wallet (Wallet SDK, SEP-1/10/24)

The wallet side of an anchor deposit with SDF's Wallet SDK (`@stellar/typescript-wallet-sdk` 6.0.0): resolve the
anchor's `stellar.toml`, authenticate with SEP-10, read SEP-24 info and start an interactive deposit on
`testanchor.stellar.org`. One line, `instrumentWalletSdk(wallet)`, records each SEP step's latency and outcome and
the funnel events per anchor home domain — never amounts, accounts, memos, KYC fields, tokens or URLs. Guide:
[Anchors, wallet side](../../docs/onboarding/anchors.md#wallet-side-scf-analyticsanchor-otel).

## Run it

1. **Install:** from the repository root, `pnpm --filter @usagemap/anchor-otel build && pnpm --dir examples install`.
2. **Set your key:** **Project → API services → Add** (service `my-wallet-backend`) and an ingest token:
   `export OTEL_SERVICE_NAME=my-wallet-backend OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://e1.usagemap.dev/v1/metrics OTEL_EXPORTER_OTLP_METRICS_HEADERS="Authorization=Bearer%20scfa_ing_…"`
3. **Run:** `cd examples/anchor-wallet-sdk && pnpm start` → `SEP-24 deposit of SRT enabled: true`,
   `interactive deposit started (…)`; exports once on exit. (`ANCHOR_HOME_DOMAIN` / `ASSET_CODE` for another anchor.)

## The lines that add UsageMap

`index.mjs`:

```js
import { instrumentWalletSdk } from "@usagemap/anchor-otel";
// …
const wallet = Wallet.TestNet();
instrumentWalletSdk(wallet); // UsageMap: before wallet.anchor(…)
```

## What you'll see in the portal

**API services → my-wallet-backend → anchor funnel**, for `testanchor.stellar.org` on testnet: the steps `toml`,
`challenge`, `token`, `info`, `deposit_interactive` with latency and outcome `ok`, and the events `toml_resolved`,
`challenge_received`, `authenticated`, `deposit_interactive_started`. The SEP-10 key is a throwaway generated per run.

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
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-wallet-backend"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` runs `node index.mjs` against a local stand-in anchor (stellar.toml,
a real SEP-10 challenge built with the SDK's `WebAuth`, SEP-24 info and deposit) and the UsageMap OTLP stand-in. It
checks the five steps and the funnel events, and that the JWT, the transaction id, the interactive URL and amounts
never arrive. Because the stand-in runs on `127.0.0.1`, its home domain is reported as `_OTHER` (addresses are never
sent as home domains); against `testanchor.stellar.org` it is the domain name. The test does not call the public anchor.
