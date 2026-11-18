# Runbook: SCF-operator API key anomaly

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: OpKeyAnomaly

**Rule:** `ops/alerts/control-plane.rules.yaml` — `scf_cp_op_key_events_total{kind=~"bad_checksum|key_in_url"}` increased in 10 m, or `kind="rate_limited"` for 10 minutes; warning, TM-ISO-10.M.1. **Partial:** the `new_network_class` kind is not exported yet (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the operator metrics API (`/op/v1`, `services/control-plane/src/opmetrics/`) counts key events by kind (`invalid`, `bad_checksum`, `revoked`, `expired`, `key_in_url`, `rate_limited`) on the control plane's unpublished metrics listener (`control-plane:9464`). A key presented in a URL is **revoked automatically** (C-119, migration `0055`, audit action `api_key.compromised_url`). **Production gap:** the lean Prometheus template `infra/ansible/roles/compose_stack/templates/prometheus.yml.j2` has no `control-plane` scrape job, so this alert is silent in the lean profile until one is added.

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

## OpKeyAnomaly (TM-ISO-10.M.1)

**Meaning.** `bad_checksum`: a mistyped or forged `scfa_op_` key. `key_in_url`: a key was sent in a URL (logs,
proxies and browser history may hold it) and has been revoked. `rate_limited`: one key has been at its per-minute
limit for 10 minutes (scraping, a runaway client).

**First checks**

```sh
promq 'sum by (kind) (increase(scf_cp_op_key_events_total[1h]))'
scfsql "SELECT key_id, label, last4, scopes, created_at, last_used_at, revoked_at, revoke_reason, flagged_for_review_at
          FROM scf.operator_api_keys ORDER BY coalesce(revoked_at, last_used_at) DESC NULLS LAST LIMIT 20"
scfsql "SELECT occurred_at, action, actor_kind, actor_id, outcome FROM scf.audit_log
         WHERE action LIKE 'api_key.%' AND occurred_at > now() - interval '24 hours' ORDER BY occurred_at DESC LIMIT 50"
```
The same audit entries are in the portal: **SCF operator console → Audit log** (prefix `api_key.`).

**Mitigation**

- `key_in_url`: already revoked. Tell the key's creator (`created_by`), have them create a new key and fix the client
  to send `Authorization: Bearer`. Purge the URL from any log or proxy that recorded it.
- `bad_checksum` in volume: someone is guessing; the per-request check and rate limits hold. Watch `AuthFailureSpike`.
- `rate_limited`: contact the key's owner; lower `rate_limit_per_min` or revoke (**API keys → revoke**, needs
  step-up) if the use is not legitimate.

**Escalation**

- Warning: security responders handle within the working day; escalate to critical if a revoked key is accepted
  (`RevokedTokenStillAccepted`, `revocation-propagation.md`).

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
