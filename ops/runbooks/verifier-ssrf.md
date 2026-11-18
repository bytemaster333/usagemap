# Runbook: domain verifier refused internal targets (SSRF attempt)

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: VerifierEgressDenied

**Rule:** `ops/alerts/control-plane.rules.yaml` — `sum by (class) (increase(scf_cp_verifier_blocked_targets_total[1h])) > 10`, warning, TM-ENR-07.M.1 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the domain verifier runs in the jobs service (worker `domain_verification`, C-125) and refuses any DNS answer that is loopback or private (`services/control-plane/src/verify/verifier.ts`), counting `class` = `loopback` or `private`; the verification result code is `PRIVATE_ADDRESS_REFUSED`. Egress of every component is also limited by the egress proxy / nftables (C-10).

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

## VerifierEgressDenied (TM-ENR-07.M.1)

**Meaning.** More than 10 verification attempts in an hour resolved to internal addresses. Usually one tenant
pointing a domain at an internal or loopback address to probe the platform's network; occasionally a misconfigured
split-horizon DNS.

**First checks**

```sh
promq 'sum by (class) (increase(scf_cp_verifier_blocked_targets_total[6h]))'
scfsql "SELECT tenant_id, count(*) AS refused, max(last_checked_at) AS last
          FROM scf.domain_verifications WHERE last_result_code = 'PRIVATE_ADDRESS_REFUSED'
           AND last_checked_at > now() - interval '24 hours' GROUP BY tenant_id ORDER BY refused DESC"
```
Look at the tenant in **SCF operator console → Projects** (domains, enrollment date, level).

**Mitigation**

- Nothing was reached: the refusal happens before connecting. No emergency action is needed for the platform.
- One tenant, many attempts: suspend it (`tenant-lifecycle.md`, **Projects → Lifecycle → suspend**, audited) and
  record the reason; consider an enrollment tombstone (C-64).
- If the count of `PRIVATE_ADDRESS_REFUSED` for ordinary tenants rises after a resolver change, check the jobs
  container's resolver configuration (`$DC exec jobs cat /etc/resolv.conf`).

**Escalation**

- Warning: security responders within the working day; critical if any verifier request reached an internal address
  (would show as a successful verification of an internal host — then `incident.md`).

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
