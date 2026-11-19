# Anchor Platform event listener (business funnel)

Anchor Platform 5.x publishes an event for every transaction created, status change, SEP-12 customer update and
SEP-38 quote to its Kafka topic `TRANSACTION`. `tools/ap-listener` reads them with **its own consumer group** (nothing
in the platform changes) and exports the funnel as metrics: transfers created, status transitions, time per status,
customer updates, quotes. Amounts, accounts, memos, customers and messages are skipped while parsing. Guide:
[Anchors, Anchor Platform side](../../docs/onboarding/anchors.md#anchor-side-anchor-platform-5x).
For request counts per SEP route of the platform itself, see [`api-anchor-platform`](../api-anchor-platform/).

## Run it

1. **Install:** Go 1.27 (`mise install` in the repository); `run.sh` builds `tools/ap-listener` on first use
   (`CGO_ENABLED=0 go build`), or set `AP_LISTENER_BIN` to a binary you built.
2. **Set your key:** edit `listener.env` (your platform's Kafka brokers, network, the service name from **Project →
   API services**), then `export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20scfa_ing_…"`; variables in your
   shell win over the file.
3. **Run:** `cd examples/anchor-platform-listener && ./run.sh -check-config` (prints `configuration ok`), then
   `./run.sh` next to your platform. No platform at hand? Produce `sample-event.json` to any Kafka (below).

## The lines that add UsageMap

`listener.env`:

```sh
AP_KAFKA_BROKERS=127.0.0.1:9092
AP_KAFKA_TOPIC=TRANSACTION
AP_KAFKA_GROUP=usagemap-ap-listener
STELLAR_NETWORK=testnet
# UsageMap: the API service registered in the portal (Project → API services) and its ingest endpoint.
OTEL_SERVICE_NAME=my-anchor-events
OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev
```

## What you'll see in the portal

**API services → my-anchor-events → anchor funnel**: transfers created per SEP, kind and client wallet domain, status
transitions and time per status (`stellar.anchor.transfer.*`), customer updates and quotes. The sample event shows as
one SEP-24 deposit created by `wallet.example.org`.

## Test it without the app

The listener needs only a Kafka topic, so one event is enough:

```sh
kafka-console-producer.sh --bootstrap-server 127.0.0.1:9092 --topic TRANSACTION < sample-event.json
```

To check token and service without any Kafka, the portal's API test:

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
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-anchor-events"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

`HTTP 200` with `{"partialSuccess":{}}` means the token and service are right; `401` means the token is wrong.

## Tested by

`tests/quickstarts/integrations/server.spec.ts` builds `tools/ap-listener`, runs `./run.sh -check-config` with this
`listener.env` (and checks that a bad shell override is reported), then starts a **real single-node Kafka**
(`apache/kafka:4.4.0`, pinned by digest), produces the listener's recorded Anchor Platform 5.0.0 events
(`tools/ap-listener/testdata/events.jsonl`) plus `sample-event.json`, runs `./run.sh` against it and checks at the
UsageMap stand-in: only `stellar.anchor.*` metrics, the sample's transfer counted once, `service.name` from
`listener.env`, and no amount, name, IBAN, account or transaction id. Anchor Platform itself is not started here;
its own OTel recipe is tested by the backends suite (`api-anchor-platform`).
