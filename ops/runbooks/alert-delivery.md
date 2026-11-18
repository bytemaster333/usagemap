# Runbook: alert notifications failing

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: NotificationsFailing

**Rule:** `ops/alerts/platform.rules.yaml` — `sum by (integration) (increase(alertmanager_notifications_failed_total[15m])) > 0` for 15 m, warning (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**E-mail (2026-11-19):** the lean profile sends alerts by e-mail through the alert mailer Worker — integration
`webhook` — and its own failure table is in [`alert-email.md`](alert-email.md) § Failures.
**Built today:** Alertmanager v0.35.0 (`infra/compose/compose.monitoring.yaml`); production receivers in `ops/alertmanager/alertmanager.prod.yml.tmpl` (e-mail plus a webhook per receiver: chat, ops-issue, security push; webhook URLs from SOPS-managed secret files). The dead-man's switch (`ops/deadman/check.sh`) is the independent path — **its scheduled GitHub workflow is not wired yet**, so a total Alertmanager outage is not detected from outside today (open point P7, `docs/monitoring-plan.md`).

## Commands used below

Run from the repository root (local Compose) or on `app-1` (lean production profile, C-123). Prometheus and
Alertmanager listen on `127.0.0.1` only; from a workstation use an SSH tunnel (`ssh -L 9090:127.0.0.1:9090 -L
9093:127.0.0.1:9093 app-1`).

```sh
# Local Compose (base stack + monitoring overlay)
DC="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.monitoring.yaml"
# Production, lean profile (the Ansible role compose_stack deploys exactly this project)
DC="docker compose -p scf --project-directory /opt/scf/current/infra/compose \
  -f /opt/scf/current/infra/compose/compose.yaml -f /opt/scf/current/infra/compose/compose.monitoring.yaml \
  -f /etc/scf/stack/compose.prod.yaml"

# Instant PromQL query → one JSON line per series
promq() { curl -s http://127.0.0.1:9090/api/v1/query --data-urlencode "query=$1" | jq -c '.data.result[] | {m: .metric, v: .value[1]}'; }
# Read-only SQL as the PostgreSQL superuser (break-glass: metadata and counts only, never tenant content;
# note every session in the incident record)
scfsql() { $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -X -U postgres -d scf -c "$1"' sh "$1"; }
```

## NotificationsFailing

**Meaning.** One integration (`email` or `webhook`) has failed to deliver for 15 minutes. The other channel of each
receiver still works, so alerts arrive — on one path only.

**First checks**

```sh
promq 'sum by (integration) (increase(alertmanager_notifications_failed_total[1h]))'
curl -s http://127.0.0.1:9093/api/v2/status | jq '.cluster.status, .uptime'
$DC logs --since 1h alertmanager | grep -iE 'notify|error' | tail -20     # names the receiver and the HTTP/SMTP error
```

**Mitigation**

- `webhook`: the chat or issue endpoint changed or its token expired — update the secret file (SOPS → Ansible role
  `compose_stack`), then `$DC restart alertmanager`. Test with a synthetic alert:
  `curl -s -XPOST http://127.0.0.1:9093/api/v2/alerts -H 'content-type: application/json' -d '[{"labels":{"alertname":"DeliveryTest","severity":"warning"}}]'`.
- `email`: SMTP credentials or the relay; check the relay's status page and the credential's expiry.
- While a channel is down, the person on daily watch (C-49) checks Alertmanager's UI by SSH tunnel at least hourly.

**Escalation**

- Warning; becomes critical if both integrations of `maintainers-critical` or `security-responders` fail.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
