# Stellar Disbursement Platform (SDP): what to send, what to keep local

**Short answer:** UsageMap does not take SDP's Prometheus metrics. Keep them in your own Prometheus or Grafana. Your
disbursement usage reaches UsageMap by two other routes:

- **On chain:** register the SDP distribution account (and any sponsoring or channel accounts you operate) as
  *app-operated wallets* in your Registered Footprint (portal → **Footprint**). UsageMap then counts the payments
  those accounts make from public ledger data, and anyone can re-check the numbers.
- **API usage:** if you run your own API in front of SDP, measure it with the normal OTLP recipe for its language.

This page explains why, and how to export only a safe subset if you also forward SDP metrics to a vendor of your own.

**Checked against:** `stellar/stellar-disbursement-platform-backend` at `d68d608` (2026-11-13, Apache-2.0),
`internal/monitor/prometheus_metrics.go`, `tss_prometheus_metrics.go`, `metric_tags.go`, `tss_metric_tags.go`,
`cmd/serve.go`. Read only; nothing was run against an SDP deployment.

## What SDP exposes

| Process (flag) | Metric families | Labels |
|---|---|---|
| `serve` (`--metrics-port`, `--metrics-type PROMETHEUS`) | `sdp_http_requests_duration_seconds`, `sdp_db_*_query_duration_seconds`, `sdp_circle_*`, **`sdp_business_disbursements_counter`** | `status`, `route`, `method`, **`tenant_name`**; `query_type`; **`asset`, `wallet`, `wallet_id`, `tenant_name`** |
| transaction submitter (`--tss-metrics-port`) | `tss_*_latency_seconds`, `tss_processed_count`, `tss_error_count`, `tss_payment_*`, `tss_wallet_creation_*`, `tss_sponsored_transaction_*` | `retried`, `result`, `error_type`; `status_code`, `result_code`; **`event_type`, `app_version`, `git_commit_hash`, `tenant_id`, `wallet_id`, `channel_account`** |

## Why our Collector does not accept them

1. **Identifiers in labels.** `channel_account` is a Stellar account address. `tenant_id`, `tenant_name`, `wallet_id`
   and `wallet` name your SDP tenants and the wallet providers your receivers use. None of these belongs in a
   neutral, public-facing analytics service. Once they are stripped, the remaining counters say little that the
   ledger does not already show.
2. **The label sets change without notice.** SDP added `wallet_id` to its payment counters in a recent release. Its
   own regression test (`internal/transactionsubmission/monitor/wallet_id_cardinality_test.go`) exists because that
   change crashed the submitter. A server-side allow-list keyed on these labels would break silently on upgrades.
3. **Most of it is operations monitoring.** HTTP, database, Circle API and queue latency show the health of your
   deployment, not usage of your product, and UsageMap does not set out to measure them.
4. **The ledger is the better proof.** Disbursement payments are on-chain transactions from accounts you control.
   Footprint-based counting is verifiable by anyone, while a Prometheus counter is self-reported.

UsageMap's Collector drops every one of these names as `metric_not_allowed` and reports the count to you as
`scf.ingest.dropped`; it stores nothing (test `TestPlatformPrometheusMetricsNotAccepted` in
`collector/processor/scfsanitizeprocessor`). Do not point a scrape-and-forward pipeline at UsageMap: it only produces
drop counts.

## If you forward SDP metrics elsewhere: the minimum to drop

When your own Collector scrapes SDP and exports to a monitoring vendor, remove the identifying labels before the
data leaves your network. Removing a label merges series. Prometheus relabelling (`labeldrop`) cannot do that: it
would produce duplicate series. So drop whole families with relabelling, and aggregate labels away with the
Collector's `metricstransform` processor (contrib):

```yaml
receivers:
  prometheus/sdp:
    config:
      scrape_configs:
        - job_name: sdp
          scrape_interval: 60s
          static_configs:
            - targets: ["sdp-api:8002", "sdp-tss:9002"]   # your --metrics-port and --tss-metrics-port
          metric_relabel_configs:
            - action: drop                                  # per-route HTTP histograms carry tenant routes
              source_labels: [__name__]
              regex: "sdp_http_.*|tss_http_.*"
processors:
  metricstransform/sdp:
    transforms:
      - include: "^(sdp_business_disbursements_counter|tss_payment_.*|tss_wallet_creation_.*|tss_sponsored_transaction_.*)$"
        match_type: regexp
        action: update
        operations:
          - action: aggregate_labels                        # keeps only these labels, sums the rest away
            label_set: [asset, event_type]
            aggregation_type: sum
  resource/sdp:
    attributes:
      - { key: service.instance.id, action: delete }        # host:port of the scrape target
      - { key: server.address, action: delete }
      - { key: server.port, action: delete }
```

This configuration was written from the sources and the processors' documentation and has not been run against an
SDP deployment. Check the exported series with the `debug` exporter before enabling a vendor exporter.

## Where this comes from

SDP's metric definitions at the commit above. The decision and its reasons are summarised in the
Collector README (steps 4a–4d).
