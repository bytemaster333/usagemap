# Anchors and anchor-using wallets: SEP funnels without personal data

Anchors (SEP-6/24/31 on- and off-ramps) are measured from two sides, and a project can use either or both:

| You are | What you add | What UsageMap shows |
|---|---|---|
| A **wallet or app that uses anchors** through SDF's Wallet SDK | [`@usagemap/anchor-otel`](../../packages/anchor-otel/): one call at start-up | Per anchor (public home domain): every SEP step's latency and outcome class, the funnel (authenticated → KYC → interactive started → deposit completed …) |
| An **anchor running Anchor Platform 5.x** | The [OTel Java agent recipe](api-anchor-platform.md) for API usage, plus [`tools/ap-listener`](../../tools/ap-listener/) for the business funnel | Transactions created per SEP/kind/client wallet, status transitions, time spent in each status, start-to-final duration, KYC status counts, firm quotes |
| An **anchor running Polaris** | The Django OTel instrumentation for API usage; the funnel is a sketch only (see [Polaris](#polaris-sketch-not-tested)) | API usage per SEP route |

**Never stored, by either side:** amounts, fees, prices, accounts (G…/M…/C…), memos, transaction ids, external ids,
Stellar transaction hashes or envelopes, customer ids or KYC fields, messages, instructions, refunds, tokens, client
IP addresses and URLs or query strings. Each value UsageMap receives is one of a fixed list (SEP, step, outcome,
status, kind), a network name, or a public DNS name (the anchor's home domain, the client wallet's domain).

> **Status of the UsageMap side.** The Collector allow-list that accepts these metrics and the storage behind it are
> part of the same release as these tools; the portal shows them as the anchor funnel. A host that still runs an older
> release counts them as ignored (`metric_not_allowed` in `scf.ingest.dropped`) and stores nothing.

## Never put a tracker on SEP-24 interactive or KYC pages

The SEP-24 interactive flow opens a web page from the anchor (`url` in the interactive response). That URL carries a
short-lived token and the page collects identity documents, bank details and addresses. **Do not load the UsageMap web
tracker (or any analytics script) on those pages**, on the anchor's side or as a wallet wrapping them in a web view:

- the URL itself is a bearer credential (UsageMap strips query strings, but the token should not leave the page at all);
- KYC pages are exactly where a field value, a document name or a page title can identify a person;
- the funnel you want ("did the user finish KYC?") is already measured without them: `customer_*` events on the
  wallet side, `pending_user_transfer_start` transitions and `customer.updates` on the anchor side.

Measure the anchor's *website* (landing, pricing, docs) with the tracker as usual; exclude the interactive path prefix.

## Wallet side: `@usagemap/anchor-otel`

Works with `@stellar/typescript-wallet-sdk` **6.x** (tested with 6.0.0) in Node and in the browser. The Wallet SDK
sends all its SEP-6/10/12/24/38 calls through one axios instance (`ApplicationConfiguration.defaultClient`, verified in
the SDK's source at tag `v6.0.0`, commit `12b0ce5`); the package adds interceptors to that instance and times SEP-1
around `anchor.sep1()` (the SDK resolves `stellar.toml` through js-stellar-sdk, not that instance).

```ts
import { Wallet } from "@stellar/typescript-wallet-sdk";
import { instrumentWalletSdk } from "@usagemap/anchor-otel";

const wallet = Wallet.MainNet();
instrumentWalletSdk(wallet); // before wallet.anchor(…); uses your global OTel MeterProvider

const anchor = wallet.anchor({ homeDomain: "testanchor.stellar.org" });
const auth = await anchor.sep10();
// … everything the SDK does from here is measured
```

Export with your usual OTel metrics SDK to UsageMap (service name and ingest token from the portal's **Add an API**):

```sh
OTEL_SERVICE_NAME=my-wallet-backend
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://ingest.scf.example/v1/metrics
OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer%20scfa_ing_...
```

In a browser wallet, the same metrics are aggregates per anchor and day: they are never tied to a visitor, a session or
a page view (design rule for browser-side telemetry). Point the browser exporter at your own backend or
Collector if you prefer not to expose an ingest token in the page.

Options: `meter`, `network` (default: the wallet's passphrase), `homeDomains` (only these anchors are reported by
name), `maxHomeDomains` (default 50 per process; later ones become `_OTHER`). Anchors created before the call, or with
`new Anchor(…)`, are added with `telemetry.instrumentAnchor(anchor)`. `detach()` removes everything.

**SEP-31 senders and plain axios.** The Wallet SDK has no SEP-31 client. If you call a receiving anchor with your own
axios instance:

```ts
const t = instrumentAnchorClient(myAxios, { network: "mainnet" });
t.register("receiver.example.com", toml); // the anchor's parsed stellar.toml (DIRECT_PAYMENT_SERVER, …)
```

Requests to URLs that are not a registered anchor server are not observed at all.

### What is sent

`stellar.anchor.request.duration` (histogram, seconds; count = requests):

| Attribute | Values |
|---|---|
| `stellar.anchor.home_domain` | the anchor's public home domain, lower case, no port; `_OTHER` for `localhost`, IPs, reserved TLDs, key-like labels, or over the cap |
| `stellar.sep` | `1`, `6`, `10`, `12`, `24`, `31`, `38` |
| `stellar.anchor.step` | `toml`, `challenge`, `token`, `info`, `fee`, `deposit`, `withdraw`, `deposit_exchange`, `withdraw_exchange`, `transactions`, `transaction`, `customer_get`, `customer_put`, `customer_delete`, `customer_callback`, `customer_verification`, `customer_files`, `deposit_interactive`, `withdraw_interactive`, `transaction_create`, `transaction_update`, `transaction_callback`, `prices`, `price`, `quote_create`, `quote`, `other` |
| `stellar.anchor.outcome` | `ok`, `bad_request`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `client_error`, `server_error`, `timeout`, `network`, `canceled`, `invalid_response` |
| `stellar.network` | `mainnet`, `testnet`, `futurenet`, `local`, `unknown` |

`stellar.anchor.events` (counter): `stellar.anchor.home_domain`, `stellar.sep`, `stellar.network` and
`stellar.anchor.event`:

| SEP | Events |
|---|---|
| 1 | `toml_resolved`, `toml_failed` |
| 10 | `challenge_received`, `authenticated`, `auth_failed` |
| 12 | `customer_needs_info`, `customer_processing`, `customer_accepted`, `customer_rejected` (from the anchor's `status`), `customer_submitted`, `customer_deleted` |
| 6 | `deposit_requested`, `withdraw_requested`, `kyc_required` (403 `non_interactive_customer_info_needed` / `customer_info_status`), `deposit_request_failed`, `withdraw_request_failed` |
| 24 | `deposit_interactive_started`, `withdraw_interactive_started`, `deposit_request_failed`, `withdraw_request_failed` |
| 31 | `receive_requested`, `receive_request_failed` |
| 38 | `price_quoted`, `quote_created`, `quote_failed` |
| 6/24/31 | `{deposit,withdraw,receive}_{started,pending_user,pending_anchor,completed,refunded,expired,failed}` — each transaction's lifecycle step once, from the `status` the anchor reports when the wallet polls `/transaction(s)` |

The lifecycle events need the transaction `id` to count each step once: it is kept in a bounded in-memory map (10,000
transactions per process) and never sent. A wallet that never polls sees no lifecycle events, only the request funnel.

## Anchor side: Anchor Platform 5.x

**API usage** (requests per SEP route, latency, errors) needs no code: [api-anchor-platform.md](api-anchor-platform.md).

**Business funnel: `tools/ap-listener`.** Anchor Platform publishes an event for every transaction created, every
status change, every SEP-12 customer update and every SEP-38 firm quote to its event queue. The listener reads them
with **its own Kafka consumer group** — the platform and your business server keep their own groups and see every
event as before; nothing in Anchor Platform changes.

Verified in `stellar/anchor-platform` at tag `5.0.0` (commit `be20b62`): events go to the Kafka topic named after the
queue, **`TRANSACTION`** (`KafkaSession`, key = event id, header `type`, value = the `AnchorEvent` as JSON); **SQS and
MSK are not implemented** in 5.0.0 (`DefaultEventService`: "SQS is not implemented yet"), so the listener speaks Kafka
only, with the same security options as the platform (`PLAINTEXT`, `SASL_PLAINTEXT`, `SASL_SSL` with `PLAIN`).

```sh
cd tools/ap-listener && go build -o ap-listener .   # Go 1.27, no CGO

AP_KAFKA_BROKERS=kafka:9092 \
AP_KAFKA_GROUP=usagemap-ap-listener \
STELLAR_NETWORK=mainnet \
OTEL_SERVICE_NAME=my-anchor-events \
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example \
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_... \
./ap-listener
```

| Variable | Default | Meaning |
|---|---|---|
| `AP_KAFKA_BROKERS` | — (required) | Comma-separated `host:port`, the platform's `events.queue.kafka.bootstrap_server` |
| `AP_KAFKA_TOPIC` | `TRANSACTION` | Topic |
| `AP_KAFKA_GROUP` | `usagemap-ap-listener` | Our consumer group; must differ from the platform's own |
| `AP_KAFKA_SECURITY_PROTOCOL` | `PLAINTEXT` | `PLAINTEXT`, `SASL_PLAINTEXT`, `SASL_SSL` |
| `AP_KAFKA_SASL_USERNAME`, `AP_KAFKA_SASL_PASSWORD` (or `_FILE`) | — | SASL `PLAIN` credentials |
| `AP_KAFKA_CA_FILE` | system roots | PEM CA for `SASL_SSL` |
| `AP_KAFKA_START` | `latest` | Where a new group starts: `latest` (no backfill) or `earliest` (count the retained history once) |
| `STELLAR_NETWORK` | `unknown` | `mainnet`, `testnet`, `futurenet`, `local` |
| `AP_LISTENER_MAX_CLIENTS` | `50` | Distinct client wallets reported by name; later ones `_OTHER` |
| `OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME`, `OTEL_METRIC_EXPORT_INTERVAL` | SDK defaults; service `anchor-platform-events` | Standard OTel variables |

`./ap-listener -check-config` validates the environment and exits. Offsets are committed after each event is handled:
a crash can count an event twice, never skip one.

**Read (allow-list)**: event `type`, `sep`, `clientDomain`/`clientName`; transaction `sep`, `kind`, `status`,
`started_at`, `updated_at`, `completed_at`, `client_domain`/`client_name`, and `id` (in memory only, see below);
customer `status` only; quote presence only. **Never read (drop list)**: amounts, fees, accounts, memos, external ids,
Stellar transactions, customers, creator, message, instructions, refunds, `required_info_*`,
`request_client_ip_address`, quote prices and assets, customer fields. The decoder has no field for them, so they are
skipped while parsing.

| Metric | Type | Attributes |
|---|---|---|
| `stellar.anchor.transfer.created` | counter | `stellar.sep` (6, 24, 31), `stellar.anchor.kind`, `stellar.anchor.client`, `stellar.network` |
| `stellar.anchor.transfer.transitions` | counter | `stellar.sep`, `stellar.anchor.kind`, `stellar.anchor.status_from`, `stellar.anchor.status`, `stellar.network` |
| `stellar.anchor.transfer.status.duration` | histogram (s) | `stellar.sep`, `stellar.anchor.kind`, `stellar.anchor.status` (the status that was left), `stellar.network` |
| `stellar.anchor.transfer.duration` | histogram (s) | `stellar.sep`, `stellar.anchor.kind`, `stellar.anchor.status` (final), `stellar.network` |
| `stellar.anchor.customer.updates` | counter | `stellar.anchor.status` (`NEEDS_INFO`, `ACCEPTED`, `PROCESSING`, `REJECTED`), `stellar.anchor.client`, `stellar.network` |
| `stellar.anchor.quotes.created` | counter | `stellar.anchor.client`, `stellar.network` |

`stellar.anchor.kind`: `deposit`, `deposit-exchange`, `withdrawal`, `withdrawal-exchange`, `receive`. Statuses: the 20
of Anchor Platform's `SepTransactionStatus`; `status_from` adds `_new` (created) and `_unknown`. `stellar.anchor.client`
is the wallet's public `client_domain`, else the platform's configured client name, else `_none`. Durations come from
the event's own timestamps (a wallet waiting a day shows as a day), bounded to 90 days.

**Limits (stated, not hidden).** Transitions need the previous status of a transaction: the listener keeps the last
status of up to 100,000 transactions in memory. After a restart, the first change of an older transaction is counted
from `_unknown` and its status time is not measured. A status-changed event that repeats the current status (a
`PATCH` of other fields) is not a transition. Durations are recorded once per transaction while it is in memory.

## Polaris (sketch, not tested)

Django Polaris 2.6.0 has no event bus. Its API usage is measured with `opentelemetry-instrumentation-django` like any
Django app. A funnel would hang a `post_save` receiver on `polaris.models.Transaction` and count
`(protocol, kind, status)` with an OTel counter (the same names as above). **Known gap:** Django's `post_save` does
not fire for `QuerySet.update()`, and Polaris itself completes outgoing transactions that way —
`poll_outgoing_transactions` runs `Transaction.objects.filter(id__in=ids).update(status=completed, …)` (verified at
tag `v2.6.0`, `polaris/management/commands/poll_outgoing_transactions.py` line 114). A `post_save` funnel therefore
under-counts completed withdrawals and SEP-31 payments, as does any anchor code that bulk-updates. Close the gap by
also counting in your `poll_outgoing_transactions` integration (the transactions it returns are the ones being
completed), or count terminal statuses with a periodic `COUNT(*) … GROUP BY status` instead of signals. We have not
built or tested a Polaris package; say so if you need one.

## Tests

- `pnpm --filter @usagemap/anchor-otel test`: the real Wallet SDK 6.0.0 against an in-process anchor (SEP-1, 10,
  12, 24, 6, 38; SEP-31 through plain axios): every step's request and outcome, the funnel, lifecycle events counted
  once while polling, closed attribute sets, and a privacy beacon over every attribute (no addresses, seeds, hashes,
  XDR, JWTs, URLs, IPs, ports, amounts, memos or KYC values).
- `cd tools/ap-listener && go test -race ./...`: recorded events built from the Anchor Platform 5.0.0 types
  (`testdata/events.jsonl`: SEP-24 deposit to completion, SEP-31 error, SEP-6 seen mid-flight, KYC, quote, a repeated
  status and a redelivered terminal event), the drop list never exported, malformed input, caps; the Kafka consumer
  against franz-go's in-process broker (`kfake`, the real Kafka protocol) showing the platform's own consumer group
  still reads every record and a restart does not re-count; and the binary's Kafka → OTLP/HTTP path.
- Not tested: a real Anchor Platform container publishing to a real Kafka broker; Polaris.
