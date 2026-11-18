# Runbook: egress denied

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-14
Alerts: EgressDenied

Source: `docs/monitoring-plan.md` §4.4, `docs/security/hardening.md` §2.2 (C-10 allow-list). Alert state
(`ops/alerts/coverage.json`): **no rule yet** — `scf_egress_dropped_packets_total{component}` is not exported (owner:
host firewall). The drops are already **counted and logged** by nftables; the checks below read them directly.

## Built today

- **Local stack:** `engine`, `db`, `data`, `core`, `cpi` and `otlp` are `internal: true` Compose networks — no route
  out at all (`infra/compose/README.md`, "Networks"); only `public` (control plane, portal, gateway) has egress.
  `vendor/umami/test/hardening-check.sh` asserts that every outbound attempt from Umami fails.
- **Lean VM (C-123):** nftables table `inet scf` from `infra/ansible/roles/common/templates/nftables.conf.j2`:
  - host `output` policy `drop`; allowed: loopback, Azure DNS, the metadata service, the VNet, 80/443 + NTP for the
    host; everything else hits `counter log prefix "scf-egress-drop " level info drop`;
  - container `forward`: the public bridge `scf-public0` (control plane, portal, gateway) may reach the internet on
    80/443 only and no private range; the backup bridge `scf-backup0` (PostgreSQL) only the metadata service and the
    blob endpoints; every other Docker bridge (`docker0`, `br-*`) is `counter drop` to the internet.
- **Not built:** per-component labels (the counters are per rule, not per container), the exporter, and the egress
  proxy for the lean profile (its Squid role `egress_proxy` belongs to the scale-out profile).

## EgressDenied (TM-UMA-01.M.2)

**Meaning.** A component without internet egress under C-10 (engine, writer, Collector, jobs, control plane except
its allow-list) tried to connect outward, or the egress network tried an unlisted destination.

**First checks** (lean VM, as root):

```sh
nft list table inet scf | grep -E 'counter packets [1-9]'              # which drop rule is counting
journalctl -k --since -1h --no-pager | grep 'scf-egress-drop ' | awk '{for(i=1;i<=NF;i++) if($i ~ /^(OUT|DST|DPT|PROTO)=/) printf "%s ", $i; print ""}' | sort | uniq -c
docker network inspect scf_public scf_backup --format '{{.Name}} {{range .Containers}}{{.Name}} {{.IPv4Address}} {{end}}'  # bridge → container
```

- The log line names the **destination** (our component's outbound target), never an end user: it is a packet from
  our own host or container. Map the source bridge/address to the container with `docker network inspect`.
- Which release introduced it? A new dependency that phones home (telemetry, update checks — e.g. Next.js telemetry
  in Umami is disabled by `NEXT_TELEMETRY_DISABLED` and `DISABLE_TELEMETRY` in `vendor/umami/Dockerfile`), a misconfigured URL (Horizon, RPC,
  registry), or a compromise.

**Mitigation**

- Keep the block. Never widen the allow-list to make an alert go away; a legitimate new destination needs a C-10
  change (ADR/register row) and a role change in `roles/common` (`scf_nft_output_extra`) applied by the playbook.
- Identify the code path; disable the feature by configuration if possible.
- Unexplained traffic from Umami, the writer, the Collector or the jobs container is a security incident
  (`incident.md`); preserve the journal (`journalctl -k --since … > file`) before restarting anything.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- C-10, ADR-0003, `docs/security/hardening.md` §2.2 and §3, `verifier-ssrf.md` (the domain verifier's own guard).
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks). Drill: on the lean test VM (`KEEP=1 infra/ansible/tests/lean/run.sh`),
  from the control plane (on `scf-public0`, allowed 80/443 only) a connection to another port must fail and the
  `iifname "scf-public0" counter drop` counter must rise:
  `docker exec scf-az-vm docker exec scf-control-plane-1 node -e "fetch('http://example.org:8080',{signal:AbortSignal.timeout(3000)}).then(()=>process.exit(1),()=>process.exit(0))"`.
  Containers only on internal networks (Umami, writer, Collector) have no route at all; `hardening-check.sh` covers Umami.
