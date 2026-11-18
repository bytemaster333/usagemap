# Runbook: monitoring node access

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-14
Alerts: MonitoringNodeAccess

Source: `docs/monitoring-plan.md` §4.4, `docs/security/hardening.md` §4.1. Alert state (`ops/alerts/coverage.json`):
**no rule yet** — `scf_host_access_events_total{kind}` (login, sudo, new_listener, inbound_flow) is not exported
(not built yet).

## Where monitoring runs

- **Lean production profile (C-123):** there is no separate `mon-c`. Prometheus, Alertmanager, Grafana, VictoriaLogs,
  the probes and the status host run on `app-1` from `infra/compose/compose.monitoring.yaml`
  (`infra/ansible/roles/compose_stack`), with host ports bound to `127.0.0.1` only
  (`SCF_PROMETHEUS_PORT` 9090, `SCF_ALERTMANAGER_PORT` 9093, `SCF_GRAFANA_PORT` 3000, `SCF_STATUS_PORT` 8090,
  `SCF_SYSLOG_PORT` 5140/udp); maintainers reach them through an SSH tunnel. Access to `app-1` is reviewed by
  `access-review.md`. No health controller and no DNS write credential exist in this profile.
- **Scale-out profile** (documented, not deployed): a hardened `mon-c` holding the health controller's DNS write
  credential, an etcd member and mesh access (`hardening.md` §4.1, C-79). This runbook applies there in full.
- **Local:** the same overlay, checked end to end by `ops/e2e/run.sh` (`make ops-e2e`).

## MonitoringNodeAccess (TM-OPS-06.M.1)

**Meaning.** Any login, `sudo`, new listener or unexpected inbound flow on the monitoring host, or a
health-controller DNS write that did not follow a probe-based removal or re-add.

**First checks**

```sh
journalctl -u ssh --since -24h --no-pager | grep -E 'Accepted publickey|session opened'; journalctl _COMM=sudo --since -24h --no-pager
ss -Hltnu | awk '{print $1, $5}' | sort -u            # listeners: lean = 127.0.0.1 monitoring ports, 22, the two front addresses on 443
$DC ps --format '{{.Service}} {{.Ports}}'   # published ports (lean $DC includes the monitoring overlay; locally add -f infra/compose/compose.monitoring.yaml)
```

- Who logged in (confirm with the person, out of band). For the scale-out profile also the health controller's change
  log (`dns-health-controller.md`) — every DNS write must follow a probe decision.
- A new listener: compare with `hardening.md` §2.1 and `unexpected-listener.md`.

**Mitigation**

- Unexplained access: treat the host as compromised — rotate what it holds (lean: every stack secret,
  `key-and-cert-rotation.md`; scale-out: the DNS write credential and `mon-c`'s mesh keys), rebuild the VM from IaC
  (`infra/opentofu/envs/azure-lean` + `playbooks/lean.yml`), restore data from backups (`restore-pitr.md`).
- Alerting is part of what an intruder would silence: check from outside that the dead-man's switch still passes
  (`dead-mans-switch.md`, `.github/workflows/deadman.yml`).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- C-79, C-92, C-123, `access-review.md`, `unexpected-listener.md`, `dead-mans-switch.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).
