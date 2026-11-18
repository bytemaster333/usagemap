# Runbook: dashboard error budget burning

Status: to be exercised (no drill has run)
Owner: maintainers (daily watch)
Last reviewed: 2026-11-13
Alerts: DashboardBurnRateFast, DashboardBurnRateSlow

**Rule:** `ops/alerts/slo.rules.yaml` — Sloth-structured multi-window burn rate on `slo:sli_error:ratio_rate*{sloth_id="dashboard-availability"}` (≥ 14.4× over 1 h and 5 m; ≥ 6× over 6 h and 30 m), critical, TM-DOS-04.M.1; SLO spec `ops/slo/dashboard.sloth.yaml` (99.9 %, ADR-0031) (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the probe's signed-in journeys (`ops/internal/journey`: a synthetic tenant signs in with its own Stellar keypair, loads the web and API overviews and the operator metrics API, every step ≤ 3 s) every 60 s; dashboard D1 (`ops/dashboards/d01-slo.json`) shows the budget. In the lean profile only the local probe runs journeys (no quorum, P7).

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

## DashboardBurnRateFast / DashboardBurnRateSlow (TM-DOS-04.M.1)

**Meaning.** Synthetic journeys fail often enough that the month's dashboard budget (43.8 minutes at 99.9 %) is
gone in about 2 days (fast) or 5 days (slow). Tenants and SCF operators cannot read their figures, or reads are slow.

**First checks**

```sh
promq 'slo:sli_error:ratio_rate1h{sloth_id="dashboard-availability"}'
$DC ps control-plane portal pgbouncer postgres umami engine-proxy
$DC logs --since 30m probe-mon-c | grep -i journey | tail -20      # which step fails: sign-in, web, API, operator
$DC logs --since 30m control-plane | grep -E '"statusCode":5' | tail -20
```
Which step fails tells where to look: sign-in → control plane/auth; web overview → live window through the engine
proxy and Umami (C-109) or the rollups; API overview → `scf.api_*` queries; operator API → `op_*` functions.

**Mitigation**

- Umami slow or down: the API falls back to rollups for older days after 5 s (`range.partial_today`, C-112);
  `engine-proxy.md`; restart `umami` if it is unhealthy.
- Database saturation: `postgres-connections.md`, `postgres-vacuum.md`.
- A bad release: roll back (`deploy-verify.md`).

**Escalation**

- Critical (both): daily watch; incident (`incident.md`) for the fast burn.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
