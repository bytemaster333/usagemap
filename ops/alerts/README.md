# Alert and recording rules

Rule files (loaded by Prometheus from this directory, `*.rules.yaml`):

| File | Content |
|---|---|
| `recording.rules.yaml` | probe quorum (C-78): `scf:probe_fresh_vote` → `scf:probe_source_vote:bad` → `scf:probe_quorum:voters`, `scf:probe_quorum:required` (2; 1 where exactly one `probes` target is scraped — the lean profile, a self-view), `scf:probe_quorum:bad`; profile objective/budget (99.99 % / 99.9 %; lean 99.5 %, DV-41); SLO error ratios `slo:sli_error:ratio_rate{5m,30m,1h,6h,3d}` (Sloth structure); server-side ratio; derived ratios for baselines |
| `slo.rules.yaml` | SLO and availability alerts (burn rates, quorum, hostname, node, health controller, engine proxy, DNS drift) |
| `data-quality.rules.yaml` | spool, forwarder, writer, Collector, verdict shifts, snapshot age |
| `edge.rules.yaml` | gateway signals added with C-124: spool depth vs cap, ambiguous (possibly duplicate) forwards, OTLP rejections by reason, `K_day` regeneration and divergence, sites at their rate limit/quota; range lists stale or missing (C-38, bot.ip-multiplicity) |
| `security.rules.yaml` | engine-proxy denials and adapter 4xx, snapshot signature, node divergence, log PII |
| `control-plane.rules.yaml` | control-plane signals (`scf_cp_*`, job `control-plane` on `control-plane:9464`; the verifier counter from `jobs`): operator bulk reads vs 30-day p99, passkey/step-up anomalies, failed sign-in spikes vs last week, operator-key anomalies, op key accepted after revocation, signup/creation bursts, verifier SSRF refusals |
| `platform.rules.yaml` | hosts, PostgreSQL/Patroni/etcd (standard exporter names), backups and restore drill (`scf_backup.prom`, `scf_restore_drill.prom`), certificate expiry and ACME renewal (`scf_tls.prom`), Watchdog, notification failures, NTP |

Every alert carries `severity` (`critical`, `warning`, `info`, `notice`, `none`), `monitor_id` (the plan's
`<ThreatID>.M.<n>`, or `none`) and `runbook_url: ops/runbooks/<name>.md`; security alerts carry `team: security`
(routed to the security responders). Metric names are the services' as built (gateway `cmd/gateway/gauges.go` and
`internal/forwarder`, engine proxy `internal/proxy/metrics.go`, writer `internal/obs`, jobs `src/metrics.ts`,
Collector self-metrics per `collector/README.md` — matched with an optional `_total` suffix).

`coverage.json` maps all 111 alerts of the plan §4.4: **69 rule, 7 partial, 23 metric missing (with the exact metric
and the owning workstream), 12 outside Prometheus** (portal notices, jobs, external checks). The Go
test `ops/internal/alertlint` fails when the plan, `coverage.json`, the rules, the runbooks and the tests disagree.

```sh
ops/alerts/test.sh                       # promtool check rules + test rules (pinned prom/prometheus v3.16.0)
cd ops && GOWORK=off go test ./internal/alertlint/
```
