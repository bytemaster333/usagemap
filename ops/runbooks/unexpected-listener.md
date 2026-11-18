# Runbook: unexpected listener

Status: local check exercised 2026-11-14 (see the drill log); the scheduled scans are not built
Owner: security responders
Last reviewed: 2026-11-14
Alerts: UnexpectedListener

Source: `docs/monitoring-plan.md` §4.4, `docs/security/hardening.md` §2.1 (the exposure table). Alert state
(`ops/alerts/coverage.json`): **no rule yet** — `scf_listener_scan_diff{scanner}` (daily internal and external scan
compared with the table) is not exported (not built yet).

## What is expected

- **Local stack:** only the control plane (`SCF_CONTROL_PLANE_PORT`), the portal (`SCF_PORTAL_PORT`) and the gateway
  (`SCF_INGEST_PORT`) publish ports, all on `127.0.0.1`; Umami, the engine proxy, PostgreSQL, PgBouncer, the writer,
  the Collector and the jobs service publish none. `infra/compose/scripts/smoke.sh` asserts it ("only the control
  plane, portal and gateway publish ports"), plus the Collector's receivers being unreachable from `core`, `data` and
  `public` (C-130).
- **Lean VM (C-123):** on the two front addresses only `443/tcp` (gateway on the ingest address, portal on the portal
  address); SSH on 22 from `scf_ssh_admin_cidrs`; the monitoring ports on `127.0.0.1` only; the control plane
  publishes no host port. `infra/ansible/tests/lean/run.sh` asserts exactly this ("nothing but 443 answers on the
  front addresses", "control plane publishes no host port; only the two front addresses on 443 + loopback monitoring
  ports"), and nftables input policy is `drop`.

## UnexpectedListener (TM-EDG-08.M.1)

**Meaning.** The scans differ from the exposure table: a port is open that should not be, or a listed one is missing.

**First checks**

```sh
# local stack (replace the project): published ports only
docker ps --filter label=com.docker.compose.project=<project> --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | grep -- '->'
# lean VM: listening sockets other than loopback, SSH and the two front addresses
ss -Hltnu | awk '{print $5}' | grep -Ev '^(127\.|\[::1\])' | sort -u
nft list table inet scf | sed -n '/chain input/,/}/p'       # what the host admits
# from outside (any machine), the front addresses: only 443 may answer
for p in 22 80 3000 5432 6432 8080 8081 8443 9090 9093 9464; do timeout 3 bash -c "</dev/tcp/<front-ip>/$p" 2>/dev/null && echo "open $p"; done
```

- Which host and port; which container owns it (`docker ps`, `ss -ltnp`); a recent deploy (`/opt/scf/current` →
  release id), an override file, or a manual `docker run`.

**Mitigation**

- Close it: remove the `ports:` entry / override and `$DC up -d` the service; stop a stray container; re-run the
  playbook (it re-renders `compose.prod.yaml` and the nftables table). Then find how it was opened.
- If the port exposed a service that holds data (PostgreSQL, PgBouncer, Umami, the engine proxy, the writer), treat it
  as a security incident: check its access logs for the window and `incident.md`.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- `docs/security/hardening.md` §2–§3, C-123, C-130, `monitoring-node.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), repository working tree | First check 1 (published ports) on the running stack; `smoke.sh` port checks in the same session | **pass** — published: control plane `127.0.0.1:56450`, portal `127.0.0.1:56451`, gateway `127.0.0.1:56452`, nothing else. The lean-VM checks were not run in this drill (they run in `infra/ansible/tests/lean/run.sh`). |
