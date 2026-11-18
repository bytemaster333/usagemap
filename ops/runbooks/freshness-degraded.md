# Runbook: freshness objective at risk

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: FreshnessSLOAtRisk, FreshnessStalled

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `FreshnessSLOAtRisk` — no rule yet: the signal is missing (`scf_freshness_canary_visible_total{source,path_kind,within}`, owner: probes); `FreshnessStalled` — no rule yet: the signal is missing (`scf_freshness_canary_last_visible_timestamp_seconds{source,path_kind}`, owner: probes).

**Built today:** the spool gauges (`scf_gateway_spool_oldest_age_seconds`, `scf_gateway_spool_queued`), forwarder outcomes `scf_gateway_forward_total{kind,outcome,core,error_kind}`, the engine proxy, the `web_rollup` job (`scf_job_last_success_timestamp_seconds{job}`). The canary freshness measurement (C-28, C-43) is planned.

## FreshnessSLOAtRisk (TM-DOS-04.M.2)

**Meaning.** Fewer than 99 % of canary events became visible within 5 minutes over the last hour (C-28).

**First checks**

- Spool age per node (`spool-backlog.md`) and forwarder errors (`forwarder-errors.md`).
- Engine proxy gate: `scf_engine_proxy_bootstrap_gate_open == 0` makes every edge call `503` (`engine-proxy.md`).
- Umami latency: `scf_engine_proxy_request_duration_seconds` on `/api/send`.

**Mitigation**

- Fix the forward path; events are not lost while spooled (up to 72 h).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## FreshnessStalled (TM-DOS-04.M.3)

**Meaning.** No canary visible within 60 minutes on a path: the 99.9 % ≤ 60 min objective is at risk.

**First checks**

- As above; also whether Umami is up (`docker compose -f infra/compose/compose.yaml ps umami`) and PostgreSQL accepts writes.

**Mitigation**

- Restore the forward path; if Umami is down, events accumulate in the spools and drain afterwards.

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.
- Tenant-visible impact (ingest, dashboards or data): open an incident (`incident.md`) and post on the status page.

## Related

- C-28, C-43, C-76.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
