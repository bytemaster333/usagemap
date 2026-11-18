# Runbook: redacted values in paths

Status: to be exercised (no drill has run)
Owner: maintainers (RedactedValuesSeen: tenant)
Last reviewed: 2026-11-13
Alerts: RedactedValuesSeen, RedactedBurst

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `RedactedValuesSeen` — not a Prometheus alert (see `ops/alerts/coverage.json`); `RedactedBurst` — rule in `ops/alerts/data-quality.rules.yaml`.

**Built today:** `pathnorm` redaction (seeds, JWTs, API keys, e-mails, phone numbers, IPs → `{redacted}`, value never stored); gateway drop label `path_redacted` per site; Collector `otelcol_processor_scfsanitize_redactions{kind,location}` and `scf_ingest_dropped{reason="route_redacted"}`.

## RedactedValuesSeen (TM-OTL-11.M.1)

**Meaning.** A tenant's `{redacted}` counter increased: its pages or API routes carry secrets or personal identifiers in the path.

**First checks**

- Kind of redaction (counts only; the value was never recorded and cannot be retrieved).

**Mitigation**

- Portal notice: the tenant should remove secrets from URLs (a secret seed in a URL is compromised wherever else it was logged).

**Escalation**

- Portal notice to the tenant.

## RedactedBurst (TM-OTL-11.M.2)

**Meaning.** Redactions across tenants above 10× baseline: a new client or SDK leaking tokens into paths, or a classifier false-positive after a release.

**First checks**

- Which kinds and locations; recent `pathnorm` changes.

**Mitigation**

- False positive: fix the rule set with a new vector; real leak: notify the affected tenants.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0012, C-52, C-114.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
