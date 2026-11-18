# Runbook: personal data found in logs

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: LogPIIDetected

**Rule:** `ops/alerts/security.rules.yaml` — `sum by (class) (increase(scf_log_pii_findings_total[15m])) > 0`, critical, TM-PRV-06.M.1 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the log scanner `scf-ops logscan` (`ops/internal/logscan`, service `logscan` in `infra/compose/compose.monitoring.yaml`) queries VictoriaLogs every 5 minutes and counts lines per class — `ipv4`, `ipv6`, `user_agent`, `bearer_token`, `api_key`, `stellar_seed`, `stellar_account` — and never exports the text. The services' own log rules are enforced by tests (gateway, engine proxy, writer, jobs, control plane); `infra/compose/scripts/smoke.sh` scans the engine proxy's logs.

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

## LogPIIDetected (TM-PRV-06.M.1)

**Meaning.** In the last 15 minutes at least one log line in VictoriaLogs matched a personal-data or secret shape of
class `{{ $labels.class }}`.

**First checks** (look at shapes and counts only; never copy a matched value into a ticket, chat or shell history)

1. Which class, how many, since when:
   ```sh
   promq 'sum by (class) (increase(scf_log_pii_findings_total[1h]))'
   promq 'time() - scf_log_scan_last_success_timestamp_seconds'      # the scanner itself is healthy?
   ```
2. Which service wrote them — counts per stream, no text (VictoriaLogs is reachable only on the monitoring network;
   the Prometheus container, on that network, has BusyBox `wget`). Example for `ipv4`; use the matching pattern
   for the class:
   ```sh
   $DC exec prometheus wget -qO- \
     'http://victorialogs:9428/select/logsql/query?query=_time:1h ~"[0-9]{1,3}(\.[0-9]{1,3}){3}" | stats by (_stream) count() hits'
   ```
3. Correlate with the last deploy (`docker compose ... ps --format '{{.Service}} {{.CreatedAt}}'`) — a new release
   that added a log line is the usual cause. A third-party image (Umami, PgBouncer, Grafana) is the other.

**Mitigation**

- `stellar_seed`, `api_key`, `bearer_token`: treat the secret as compromised. Rotate it now
  (`key-and-cert-rotation.md`; an `scfa_op_` key: portal **SCF operator console → API keys → revoke**, or
  `POST /v1/operator/api-keys/{keyId}/revoke`), then fix the code.
- Fix the log statement with a test that fails on the shape (the scanner's own classifier is
  `ops/internal/logscan.Classify`), release through the normal path (`security-patch-24h.md` if the leak continues).
- Remove the affected entries from VictoriaLogs v1.53.0. **Open item:** the selective-delete command for this
  version has not been worked out; the first exercise must establish it. Until then the entries age out with the
  30-day retention (C-71) — record the date in the incident.
- Record it as a privacy incident (processor obligations under the DPA).

**Escalation**

- Critical: push to both named security responders (C-67); private record (draft security advisory or private ops
  issue) with the start time.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
