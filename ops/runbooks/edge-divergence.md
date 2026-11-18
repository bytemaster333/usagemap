# Runbook: one gateway's verdicts diverge from its peers

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: NodeVerdictDivergence

**Rule:** `ops/alerts/security.rules.yaml` — robust z-score of `scf:gateway_verified_share_by_node:ratio_rate1h` across nodes > 4 for 1 h, warning, TM-EDG-03.M.1 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the recording rule computes each gateway's verified share; the alert needs at least three gateways to be meaningful. **The lean profile runs one gateway (C-123), so this alert cannot fire there**; it applies to the scale-out profile and the multi-node Compose profile (`infra/compose/compose.ha.yaml`, `gateway-b`).

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

## NodeVerdictDivergence (TM-EDG-03.M.1)

**Meaning.** One gateway marks a very different share of events `verified` than the others for an hour. Either a
node-specific defect (stale edge snapshot, a different build, a failed key exchange — `KDayDivergence`) or a
compromised node forging verdicts.

**First checks**

```sh
promq 'scf:gateway_verified_share_by_node:ratio_rate1h'
promq 'scf_gateway_kday_fingerprint_info'          # every node should show the same fingerprint for the day (C-124)
promq 'scf_gateway_snapshot_age_seconds'          # stale edge snapshot on one node?
promq 'scf_gateway_snapshot_sequence'             # same sequence on every node?
$DC ps --format '{{.Service}} {{.Image}}' | grep gateway   # same image digest on every node?
```

**Mitigation**

- Different image or stale snapshot: redeploy the node from the signed release; it is a defect, not an attack.
- Same image, same snapshot, still divergent: take the node out of DNS (scale-out: `edge-node-down.md`), keep its
  disk for forensics, rotate its node certificate (`key-and-cert-rotation.md`) and treat as `incident.md`
  (security). The other nodes' counts are unaffected.

**Escalation**

- Warning: security responders within the working day; critical once a compromise is suspected.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
