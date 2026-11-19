# ap-listener

Consumes **Anchor Platform 5.x** events from its Kafka `TRANSACTION` topic with its **own consumer group** (no change to
the platform) and sends aggregate metrics over OTLP/HTTP to UsageMap: transactions created, status transitions, time
in each status, start-to-final duration, SEP-12 KYC status counts and SEP-38 firm quotes.

It decodes an allow-list of fields only (`type`, `sep`, `kind`, `status`, timestamps, `client_domain`/`client_name`;
the transaction `id` in a bounded in-memory map for transitions, never exported). Amounts, fees, accounts, memos,
external ids, Stellar transactions, customers, messages, instructions, refunds, `required_info_*` and
`request_client_ip_address` have no field in the decoder and are skipped while parsing.

```sh
go build -o ap-listener .
AP_KAFKA_BROKERS=kafka:9092 STELLAR_NETWORK=mainnet \
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example \
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_... \
./ap-listener            # -check-config validates the environment; -version
```

Configuration, metrics and limits: [docs/onboarding/anchors.md](../../docs/onboarding/anchors.md#anchor-side-anchor-platform-5x).

Tests: `go test -race ./...` (recorded events built from the Anchor Platform 5.0.0 types in `testdata/`; Kafka through
franz-go's in-process `kfake` broker; Kafka → OTLP/HTTP through the binary's `run`).
