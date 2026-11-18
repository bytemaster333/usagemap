# Runbook: revoked credential still accepted

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: RevokedTokenStillAccepted

**Rule:** `ops/alerts/control-plane.rules.yaml` — `sum(increase(scf_cp_op_key_accepted_after_revocation_total[10m])) > 0`, critical, TM-OTL-05.M.2. **Partial:** the ingest-token half (`scf_gateway_ing_token_accepted_after_revocation_total`, gateway) is not exported yet (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the control plane checks every `scfa_op_` key against `scf.operator_api_keys` per request with a 5-second cache (`KEY_CACHE_MS`, C-06, `services/control-plane/src/opmetrics/keyauth.ts`) and counts an acceptance more than 5 s after `revoked_at`. Ingest tokens (`scfa_ing_`) are revoked through the signed edge snapshot (re-issued by the jobs service's `edge_snapshot` worker). **Production gap:** no `control-plane` scrape job in the lean Prometheus template (see `api-key-anomaly.md`).

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

## RevokedTokenStillAccepted (TM-OTL-05.M.2)

**Meaning.** An operator API key answered a request after its revocation beyond the cache bound. Treat the key as
compromised and the revocation path as broken.

**First checks**

```sh
promq 'increase(scf_cp_op_key_accepted_after_revocation_total[1h])'
scfsql "SELECT key_id, label, revoked_at, revoked_by, revoke_reason, last_used_at FROM scf.operator_api_keys
         WHERE revoked_at > now() - interval '7 days' ORDER BY revoked_at DESC"
$DC ps control-plane     # how many instances? an old instance with a stale build would explain it
```
Check whether several control-plane instances run and whether one of them is an older image than the others.

**Mitigation**

1. Confirm the key row has `revoked_at` set; if it does not, revoke it (**SCF operator console → API keys**, or
   `POST /v1/operator/api-keys/{keyId}/revoke`).
2. Restart the control plane to drop every cache: `$DC restart control-plane`.
3. Review what the key read after revocation (**Audit log**, actor `op_key` with that key id) and treat it as a data
   exposure of those scopes (`isolation-breach.md` if tenant-restricted data was read by the wrong party).
4. Fix with a test in `services/control-plane/test/integration/opmetrics.test.ts`.

**Escalation**

- Critical: both security responders (C-67); private security record; this is a security incident (`incident.md`).

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
