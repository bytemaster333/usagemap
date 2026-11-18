# Runbook: many sites rate-limited or over quota

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: SiteRateLimited

**Rule:** `ops/alerts/edge.rules.yaml` — `max by (kind) (scf_gateway_sites_limited) > 10`, warning, TM-DOS-02.M.3. **Partial:** the tenant-facing portal notice is not built (C-80/C-90) (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** the gateway answers `429` per site when the per-site rate limit (`web_requests_per_min_site`, L0 `l0_web_requests_per_min_site`) or the daily quota (`l0_events_per_day`, `l1_events_per_day`; verified events only) is reached, and exports the number of sites limited in the last hour by `kind` (`rate_limited`, `quota_exceeded`) — counts only, no site label (`services/gateway/cmd/gateway/gauges.go`). Per-site detail reaches the control plane in the counter uploads and is visible to each tenant in the installation check.

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

## SiteRateLimited (TM-DOS-02.M.3)

**Meaning.** More than 10 sites were answered `429` on one gateway within an hour. Either real growth (many L0
tenants reaching 50,000 verified events a day), a flood against several sites (framing a competitor, TM-INF-15), or a
limit set too low.

**First checks**

```sh
promq 'max by (kind) (scf_gateway_sites_limited)'
promq 'sum by (verdict) (increase(scf_gateway_events_total[1h]))'
promq 'sum by (reason) (increase(scf_gateway_reasons_total[1h]))'
scfsql "SELECT key, value FROM scf.settings WHERE key ~ '(events_per_day|requests_per_min)'"
```
Which sites: **SCF operator console → Projects** (verification level, traffic), or the tenants' installation checks
(`getInstallationCheck`). A flood shows as a surge of `suspect`/`rejected` events on the affected sites.

**Mitigation**

- Growth at L0: the tenants should verify a domain (L1 raises the quota to 1,000,000/day); contact them.
- Flood: the limits are doing their job; the affected tenants' verified figures are protected by the challenge and
  multiplicity checks. Annotate the period (trust annotations) so SCF operators read it correctly (C-80).
- Limits too low platform-wide: change the setting with step-up as `operator_admin`
  (`operatorUpdateSetting`, **Enrollment and thresholds**); it reaches the gateways in the next edge snapshot.

**Escalation**

- Warning: maintainers within the working day.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
