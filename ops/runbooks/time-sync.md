# Runbook: clock offset

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: NTPOffset

**Rule:** `ops/alerts/platform.rules.yaml` — `abs(node_timex_offset_seconds) > 0.1` for 10 m, warning (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** `chrony` is installed and enabled by the Ansible role `common` (`infra/ansible/roles/common/tasks/main.yml`); `node-exporter` runs in the lean profile (`compose.prod.yaml.j2`) and exports `node_timex_*`. Local Compose has no node exporter, so the alert has no input there.

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

## NTPOffset

**Meaning.** The host clock is more than 100 ms off. Probe rounds are aligned to the wall clock, the 72-hour spool
cap and the 48-hour late-data bound use it, challenge tokens are time-bound, and the audit anchor is daily.

**First checks** (on the host)

```sh
promq 'node_timex_offset_seconds'
chronyc tracking            # System time, Last offset, Leap status
chronyc sources -v          # reachable sources?
timedatectl                 # "System clock synchronized: yes"
```

**Mitigation**

- No reachable sources: the egress firewall must allow NTP (UDP 123) to the configured servers; on Azure the host
  can also use the platform time source. Fix in the `common` role and re-apply with `ansible-playbook`.
- Large offset: `chronyc makestep` once, then watch `chronyc tracking`.
- Then check for side effects: `rejected/challenge_invalid` spikes in the gateway counters and late-data drops in
  the Collector (`promq '{__name__=~"otelcol_processor_scfsanitize_dropped.*"}'`).

**Escalation**

- Warning: maintainers within the working day; critical if the offset exceeds 30 s (challenge tokens start failing).

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
