# Runbook: Umami answered 401/403/404 to a tenant-scoped call

Status: to be exercised (no drill has run)
Owner: maintainers; security responders informed
Last reviewed: 2026-11-13
Alerts: AdapterForbidden, UmamiSiteDrift

**Rule:** `ops/alerts/security.rules.yaml` — `sum by (role, route, code) (increase(scf_engine_proxy_requests_total{role=~"provisioner|reader",code=~"401|403|404"}[1h])) > 0`, warning, TM-ISO-05.M.1 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** every call to Umami goes through the engine proxy (`services/engine-proxy`, mutual TLS, per-role path allow-lists, C-60/C-74) and is counted by role, route class and status. Provisioning (`provisioner`) is the jobs service's `umami_reconcile` worker; dashboard reads (`reader`) come from the control plane. `umami_reconcile` re-creates missing tenant teams, users, keys and websites every 5 minutes (`services/control-plane/src/umami/reconcile.ts`).

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

## AdapterForbidden (TM-ISO-05.M.1)

**Meaning.** Umami refused a call made with a tenant's credentials or for a tenant's website. Our view of Umami's
tenancy (which team owns which website, which key belongs to which tenant) may have diverged from Umami's: a deleted
website, a rotated key not yet stored, or a website outside the tenant's team (`misplaced`).

**First checks**

```sh
promq 'sum by (role, route, code) (increase(scf_engine_proxy_requests_total{code=~"401|403|404"}[6h]))'
$DC logs --since 2h jobs | grep -i 'umami_reconcile'          # misplaced websites, rotation, failures (no secrets logged)
$DC logs --since 2h engine-proxy | grep -E '"code":(401|403|404)' | head
```
A `404` on a reader route right after a site was archived or a tenant purged is expected once; repeated codes for
the same route class are not.

**Mitigation**

1. Run a reconcile pass now instead of waiting 5 minutes:
   `scfsql "SELECT pg_notify('scf_umami', '')"` — then watch `$DC logs -f jobs`.
2. `401` for one tenant after a key rotation (C-85): the pass re-provisions from the derived password; if it keeps
   failing, check `scf.umami_credentials` for that tenant (key version, `created_at` — never print the ciphertext).
3. A `misplaced` website reported by the pass: do not move it by hand in Umami; open an isolation review
   (`isolation-breach.md`) — a website in the wrong team is a cross-tenant exposure.
4. Contract drift after an Umami upgrade: run `pnpm --filter @usagemap/umami-adapter test` (contract tests
   against the pinned image) and follow `umami-upgrade.md`.

**Escalation**

- Warning: maintainers within the working day; security responders if a website appears in another tenant's team.

## UmamiSiteDrift (TM-ISO-05.M.2)

**Meaning.** The control plane's reconcile found portal sites and Umami websites out of step for 2 hours
(`scf_cp_umami_site_drift{kind}`): `orphan` — an Umami website without a portal site; `missing` — a portal site without
its website; `misplaced` — a website in another tenant's Umami team, which could expose one tenant's figures to
another (security).

**First checks**

- The control plane log of `umami_reconcile` (it names the site and website ids, never tenant data).
- A tenant creation, purge or erasure in progress (short drift during those is expected and does not alert).

**Mitigation**

- `misplaced`: treat as a possible isolation breach (`isolation-breach.md`) until explained; move or delete the
  website through the adapter, never in Umami's UI.
- `orphan` / `missing`: let the reconcile repair it, or re-run the tenant's provisioning.

**Escalation**

- Warning to the security responders; `misplaced` that cannot be explained within a day → incident.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
