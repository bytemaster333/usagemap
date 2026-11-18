# OpenZeppelin Relayer (and Channels): what to send, what to keep local

**Short answer:** UsageMap does not take the Relayer's Prometheus metrics. Keep them in your own monitoring. Your
relayed usage reaches UsageMap by two other routes:

- **On chain:** register the relayer's signing accounts, and the channel accounts if you run the Channels plugin, as
  *app-operated wallets* in your Registered Footprint. UsageMap then counts the transactions they submit from public
  ledger data.
- **Your API:** the endpoint your users call (the one that asks the Relayer to submit) is measured with the OTLP
  recipe for its language.

**Checked against:** `OpenZeppelin/openzeppelin-relayer` v1.9.0 (`2c0c317`, 2026-11-10, AGPL-3.0),
`src/metrics/mod.rs`, `src/repositories/transaction/transaction_redis.rs`, `src/config/server_config.rs`, README
"Metrics". Read only. UsageMap ships no Relayer code: this page names metrics, it does not copy any.

## What the Relayer exposes

The Relayer exposes these with `METRICS_ENABLED=true`, on `METRICS_PORT` (default 8081), at `/metrics` and
`/debug/metrics/scrape`.

| Metric | Labels | Notes |
|---|---|---|
| **`raw_requests_total`** | **`raw_uri`**, `method`, `status` | The raw request URI: relayer ids, transaction ids, query strings. **Always drop.** |
| `requests_total`, `error_requests_total`, `request_latency_seconds`, `request_timeouts_total`, `in_flight_requests` | `endpoint`, `method`, `status` / `timeout_type` | Its own API's HTTP traffic. Operational |
| `transactions_created_total`, `transactions_submitted_total`, `transactions_success_total` | `relayer_id`, `network_type` | `relayer_id` is your configured relayer name (free text) |
| `transactions_failed_total` | `relayer_id`, `network_type`, `failure_reason`, `previous_status` | `failure_reason` takes values such as `failed`, `preparation_failed`, `expired`, `canceled` |
| `api_rpc_failures_total` | `relayer_id`, `network_type`, `operation_name`, `error_type` | |
| `transactions_by_status` (gauge), `transaction_processing_seconds`, queue, worker and process gauges | `relayer_id`, `network_type`, `stage`; `queue_type`, `backend` | Operational |

## Why our Collector does not accept them

1. **`raw_requests_total` is a URI log in metric form.** It must never leave your network, whatever we decide about
   the others.
2. **The rest is either operations, or on chain anyway.** Created, submitted, success and failed counts describe
   transactions that land on the ledger from accounts you control. Footprint counting reports them verifiably and
   without your configuration names (`relayer_id`).
3. **The schema is not ours to pin.** The label sets change between releases: the source comments mark
   `previous_status` as a label added to `transactions_failed_total` later. The Relayer also serves EVM and Solana
   as well as Stellar (`network_type`). A UsageMap allow-list keyed on these labels would trail every release.

UsageMap's Collector drops all of these names as `metric_not_allowed` and reports the count to you as
`scf.ingest.dropped` (test `TestPlatformPrometheusMetricsNotAccepted`).

## If you forward Relayer metrics elsewhere: the minimum to drop

```yaml
receivers:
  prometheus/relayer:
    config:
      scrape_configs:
        - job_name: oz-relayer
          scrape_interval: 60s
          metrics_path: /metrics
          static_configs:
            - targets: ["relayer:8081"]
          metric_relabel_configs:
            - action: drop                       # raw URIs: never export
              source_labels: [__name__]
              regex: "raw_requests_total"
processors:
  metricstransform/relayer:                      # contrib: sums your relayer names away (relabel labeldrop cannot)
    transforms:
      - include: "^transactions_(created|submitted|success|failed)_total$"
        match_type: regexp
        action: update
        operations:
          - action: aggregate_labels
            label_set: [network_type, failure_reason, previous_status]
            aggregation_type: sum
  resource/relayer:
    attributes:
      - { key: service.instance.id, action: delete }   # host:port of the scrape target
      - { key: server.address, action: delete }
      - { key: server.port, action: delete }
```

Written from the sources and the processors' documentation; not run against a Relayer. Check the output with the
`debug` exporter first.
