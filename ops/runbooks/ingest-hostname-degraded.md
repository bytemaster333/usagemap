# Runbook: one ingest hostname degraded

Status: to be exercised (no drill has run)
Owner: maintainers (daily watch)
Last reviewed: 2026-11-13
Alerts: IngestHostnameDegraded

**Rule:** `ops/alerts/slo.rules.yaml` — `avg_over_time(scf:probe_quorum:bad{kind="host"}[10m]) > 0.01` for 1 m, critical, TM-DOS-01.M.8 (tested by `ops/alerts/test.sh`; coverage in `ops/alerts/coverage.json`).
**Built today:** probe rounds also record the **first attempt** per ingest hostname (no retry), so a lost domain or DNS problem on one of the two ingest hostnames is visible while the headline stays good through the other (C-78, review AR-07). This alert belongs to the **scale-out profile** (three probe sources `mon-c`, `probe-d`, edge probers with a 2-of-3 quorum, C-30/C-78; `ops/internal/quorum`). **The lean production profile (C-123) has one local probe (`probe-mon-c` on `app-1`) and no quorum**, so the recording rule `scf:probe_quorum:bad` has fewer than two voters and is *unknown*, and this alert does not fire there (open point P7, `docs/monitoring-plan.md`). On the local monitoring overlay all three sources run on one machine.

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

## IngestHostnameDegraded (TM-DOS-01.M.8)

**Meaning.** First-attempt success for one ingest hostname is below 99 % over 10 minutes. Trackers fail over to the
other hostname, so events still arrive — at the cost of a retry, and with one hostname left.

**First checks** (replace `<host>` with `{{ $labels.target }}`)

```sh
dig +short <host> A ; dig +short <host> AAAA            # expected front addresses?
dig +short NS <registrable domain>                      # delegation intact?
curl -sv -o /dev/null https://<host>/healthz 2>&1 | grep -E 'subject:|expire|HTTP/'
whois <registrable domain> | grep -iE 'expir|status'    # registrar hold or expiry
```

**Mitigation**

- DNS record wrong: restore it from IaC (`infra/opentofu/envs/azure-lean`, `tofu plan` shows the drift; `dns-drift.md`).
- Certificate for this name expired or missing: `certificate-renewal.md`.
- Domain lost or suspended at the registrar: escalate at once; the second hostname carries all traffic (the reason
  two hostnames on two domains exist, ADR-0017).

**Escalation**

- Critical: daily watch; incident if not explained within 30 minutes.

## Related

- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
