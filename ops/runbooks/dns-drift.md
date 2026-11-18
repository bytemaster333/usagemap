# Runbook: DNS records drifted

Status: to be exercised (no drill has run)
Owner: maintainers (DNSRecordForeign: security responders)
Last reviewed: 2026-11-13
Alerts: DNSRecordDrift, DNSRecordForeign

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `DNSRecordDrift` — rule in `ops/alerts/slo.rules.yaml` (partial); `DNSRecordForeign` — no rule yet: the signal is missing (`scf_dns_foreign_records{provider,zone}`, owner: DNS as code).

**Built today:** nothing: DNS as code (DNSControl or octoDNS, C-27), the two DNS providers and the drift check are planned; domains are placeholders.

## DNSRecordDrift (TM-EDG-06.M.1)

**Meaning.** Published records at a DNS provider differ from the intended set (ingest/portal A/AAAA vs the health controller's set; everything else vs the zone files in git).

**First checks**

- Which provider and records; was a manual change made during an incident?

**Mitigation**

- Re-apply the zone files from git; re-sync the health controller's record sets.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## DNSRecordForeign (TM-EDG-06.M.2)

**Meaning.** A published record for our names points outside our IP inventory: possible account compromise or hijack.

**First checks**

- Provider audit log, account sessions and API keys; registrar lock status.

**Mitigation**

- Restore records, rotate provider credentials, keep registry lock on; check CT logs for certificates issued meanwhile (`ct-alert.md`). SRI protects tenants' pages from a swapped script (C-31).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.
- Tenant-visible impact (ingest, dashboards or data): open an incident (`incident.md`) and post on the status page.

## Related

- C-27, C-31, C-61.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
