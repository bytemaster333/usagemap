# Runbook: one probe source alone sees ingest failing

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: SingleVantageFailing

**Rule:** `ops/alerts/slo.rules.yaml` — `scf:probe_source_vote:bad{kind="round",target="ingest"} == 1 unless scf:probe_quorum:bad == 1` for 5 m, info, TM-DOS-01.M.5 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** see `ingest-probe-failure.md`. This alert belongs to the **scale-out profile** (three probe sources `mon-c`, `probe-d`, edge probers with a 2-of-3 quorum, C-30/C-78; `ops/internal/quorum`). **The lean production profile (C-123) has one local probe (`probe-mon-c` on `app-1`) and no quorum**, so the recording rule `scf:probe_quorum:bad` has fewer than two voters and is *unknown*, and this alert does not fire there (open point P7, `docs/monitoring-plan.md`). On the local monitoring overlay all three sources run on one machine. In the lean profile the single local probe failing is the only signal and is handled as `ingest-probe-failure.md`.

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

## SingleVantageFailing (TM-DOS-01.M.5)

**Meaning.** One probe source fails while the others succeed. Logged and published, not counted against the SLO
(C-78). Usually the source's own network, DNS resolver or clock; sometimes a real path-specific outage (one region,
one resolver) that tenants' visitors also see.

**First checks**

```sh
promq 'scf:probe_source_vote:bad{kind="round",target="ingest"}'
promq 'up{job="probes"}'
$DC logs --since 30m probe-probe-d | tail -30        # or probe-mon-c / probe-edge: the failing source
$DC exec -T probe-probe-d /usr/local/bin/scf-ops healthcheck http://127.0.0.1:9480/metrics   # source alive?
```
Read that source's raw CSV for the day (`/var/lib/scf-probes/<source>/<day>.csv`, volume `probestore`): error class
per attempt (DNS, TLS, timeout, HTTP status).

**Mitigation**

- DNS/TLS/time on the probe host: fix the host (`time-sync.md`); the probe's self-check makes it abstain.
- A real path problem (only one region fails): record it in the monthly SLO report's notes; check the DNS provider.
- A source that fails for more than a day: restart it (`$DC restart probe-<source>`), then rebuild its host.

**Escalation**

- Info: reviewed in the daily watch; no page.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
