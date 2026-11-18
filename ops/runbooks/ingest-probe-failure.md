# Runbook: ingest probe rounds failing

Status: to be exercised (no drill has run)
Owner: maintainers (daily watch)
Last reviewed: 2026-11-13
Alerts: ProbeQuorumFailing

**Rule:** `ops/alerts/slo.rules.yaml` — `scf:probe_quorum:bad{kind="round",target="ingest"} == 1` for 30 s (two consecutive bad rounds), critical, TM-DOS-01.M.4 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** `scf-ops probe` sends the canary event every 30 s (fetch challenge, solve, post; good = 2xx after fsync within 2 s, one retry to the other hostname) and writes raw results to `/var/lib/scf-probes/<source>/<day>.csv`. This alert belongs to the **scale-out profile** (three probe sources `mon-c`, `probe-d`, edge probers with a 2-of-3 quorum, C-30/C-78; `ops/internal/quorum`). **The lean production profile (C-123) has one local probe (`probe-mon-c` on `app-1`) and no quorum**, so the recording rule `scf:probe_quorum:bad` has fewer than two voters and is *unknown*, and this alert does not fire there (open point P7, `docs/monitoring-plan.md`). On the local monitoring overlay all three sources run on one machine.

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

## ProbeQuorumFailing (TM-DOS-01.M.4)

**Meaning.** At least two probe sources saw ingest fail in two consecutive rounds: no ingest hostname accepted the
canary within 2 s. Tenants' events are being refused or delayed; the trackers retry for 72 h.

**First checks**

```sh
promq 'scf:probe_source_vote:bad{kind="round",target="ingest"}'       # which sources vote bad
$DC ps gateway collector                                              # running and healthy?
$DC logs --since 15m gateway | tail -50
curl -sk -o /dev/null -w '%{http_code} %{time_total}\n' https://<ingest-host>/healthz   # from outside the host too
promq 'scf_gateway_spool_pending'                                     # accepted but not forwarded
```

**Mitigation**

- Gateway down or crash-looping: `$DC up -d gateway` and read its last log lines; a bad release → roll back to the
  previous release with the Ansible role (`scf_release_ref`), see `deploy-verify.md`.
- Gateway up but refusing (`503`, global overload): `spool-backlog.md` (disk, spool limit) and `disk-space.md`.
- TLS or DNS: certificate expired (`certificate-renewal.md`), DNS record changed (`dns-drift.md`).
- Host or region down (lean profile): nothing to fail over to; restore on a new VM from IaC
  (`docs/guides/deploy-azure.md`, recovery) — accepted events are on the data disk's spool.

**Escalation**

- Critical: page the daily watch; open an incident (`incident.md`) after 15 minutes; status page note.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
