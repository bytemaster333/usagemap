# Runbook: certificate expiring

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: CertExpiring

Source: `docs/monitoring-plan.md` §4.4, `docs/security/hardening.md` §9. Alert state (`ops/alerts/coverage.json`):
**rule** (`ops/alerts/platform.rules.yaml`, three rules): warning past ⅔ of the lifetime (for 1 d), critical below
7 days, and warning when the ACME timer's run failed for a day or has not run for 2 days (`reason: renewal_failing`).
Inputs (lean profile, role `compose_stack`): textfile `scf_tls.prom` written by `scf-cert-metrics` (daily timer, after
every ACME run and every deploy) — `scf_tls_cert_not_{before,after}_timestamp_seconds{kind=acme|mesh|ca,name}` — and
`scf_acme.prom` from `scf-acme` (`scf_acme_last_run_success`, `scf_acme_last_run_timestamp_seconds`). For mesh leaves and
the CA the warning means: re-run the playbook (role `pki`, which renews leaves with less than 140 days left and then
recreates the stack). The checks below remain the manual cross-check.

## Which certificates exist

| Certificate | Issued by | Lifetime / renewal | Consumers (reload) |
|---|---|---|---|
| Public: ingest host names, portal + status host (lean) | Let's Encrypt via **lego** DNS-01 on Azure DNS, managed identity (`roles/compose_stack/tasks/tls.yml`) | 90 days; `scf-acme.timer` runs `/usr/local/sbin/scf-acme`, lego renews at ⅓ lifetime left (or on ARI) | `scf-cert-deploy` copies a changed pair to `/etc/scf/stack/tls` and sends the gateway `SIGHUP`, restarts the portal |
| Node mTLS (edge, engine proxy, reader, provisioner, writer, control plane) | private CA, role `pki` (workstation; production) / `infra/compose/scripts/dev-pki.sh` (local) | 397 days (`DAYS_LEAF` in `dev-pki.sh`); the `pki` role re-issues a leaf within `scf_pki_renew_before_days` = 30 days of expiry on every playbook run | engine proxy, writer, gateway listener: `SIGHUP`; gateway node certificate, control plane, jobs: restart; Collector: reloads hourly |
| Private CA | same | 825 days (`DAYS_CA`) | every consumer (CA bundle) |
| DCS CA and etcd/Patroni certificates | `pki` role, second run (scale-out profile only) | as node certificates | etcd, Patroni, HAProxy |

## CertExpiring (TM-DOS-07.M.1)

**Meaning.** A node, Caddy or node-mTLS certificate is past ⅔ of its lifetime without renewal; critical below 7 days.

**First checks**

```sh
# public names, from anywhere (replace with the deployment's host names):
echo | openssl s_client -connect <ingest-host>:443 -servername <ingest-host> 2>/dev/null | openssl x509 -noout -enddate -issuer
# lean VM: timer and last run of the ACME job
systemctl list-timers scf-acme.timer --no-pager; journalctl -u scf-acme.service -n 30 --no-pager
# node certificates (/etc/scf/pki, scf_pki_node_dir) and public ones (/etc/scf/stack/tls) on the VM; locally .secrets/pki
for f in /etc/scf/pki/*.pem /etc/scf/stack/tls/*.pem; do case $f in *-key.pem) continue;; esac; openssl x509 -in "$f" -noout -checkend $((30*86400)) >/dev/null 2>&1 || echo "expiring <30d: $f"; done
for f in infra/compose/.secrets/pki/*.pem; do case $f in *-key.pem) continue;; esac; printf '%s ' "$f"; openssl x509 -in "$f" -noout -enddate; done
```

- ACME failures: the DNS-01 step needs the VM's managed identity to hold DNS write on the zone (`infra/opentofu`)
  and egress to the ACME server and Azure Resource Manager (nftables output allow-list, `roles/common`).
- Private-CA leaves: was the playbook run in the last 30 days? The renewal is not a timer; it happens on a run.

**Mitigation**

- Public certificate: `sudo systemctl start scf-acme.service`, then re-check with `openssl s_client`. If ACME stays
  broken and expiry is < 7 days, fix the DNS credential/egress first; there is no manual-certificate path in the
  playbook (by design: no private keys handled by hand).
- Node certificate in production: re-run `ansible-playbook -i inventory.lean.yml playbooks/lean.yml` (re-issues
  leaves inside the renewal window), which also restarts what needs it.
- Node certificate locally: delete the pair and run `infra/compose/scripts/dev-pki.sh`, then reload as in
  `key-and-cert-rotation.md` §1 (drilled 2026-11-14).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical
  below 7 days: page the on-call maintainer; an expired ingest certificate is an outage (`incident.md`).

## Related

- `key-and-cert-rotation.md` §1 (re-issue and reload; drill), C-60, C-61, C-114, C-123.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).
