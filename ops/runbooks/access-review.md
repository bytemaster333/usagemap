# Runbook: interactive access (SSH, `sudo`) and the access review

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-14
Alerts: SSHSession

Source: `docs/monitoring-plan.md` §4.4, `docs/security/hardening.md` §4. Alert state: `ops/alerts/coverage.json` —
`SSHSession` has **no rule yet**: the signal `scf_host_access_events_total{kind="ssh_session"}` is not exported
(owner: hosts). Until it is, the review below is done by hand from the host journal.

## Built today

- SSH baseline on every host from `infra/ansible/roles/common/tasks/main.yml` ("SSH hardening"):
  `/etc/ssh/sshd_config.d/10-scf.conf` with `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin no`, `X11Forwarding no`; keys per person from the inventory.
- nftables input policy `drop` (`roles/common/templates/nftables.conf.j2`); SSH is accepted only from
  `scf_ssh_admin_cidrs` (`roles/common/defaults/main.yml`, empty by default — set it per deployment).
- The host journal is capped (`scf_journald_max_use`, 30-day retention), so a review must happen within 30 days.
- **Not built:** auditd rules, the access-event exporter and the chat notification (`hardening.md` §4 lists them as
  the target). The lean profile (C-123) has one host, `app-1` (plus the optional standby VM).

## SSHSession (TM-OPS-02.M.1)

**Meaning.** An interactive SSH session or `sudo` on a production host. Every event is reviewed because there are few
maintainers.

**First checks** (on the host, as a maintainer):

```sh
journalctl -u ssh --since -24h --no-pager | grep -E 'Accepted publickey|session opened'   # who, which key fingerprint
journalctl _COMM=sudo --since -24h --no-pager                                             # sudo commands
last -F | head -20                                                                         # session times
sshd -T | grep -Ei 'passwordauthentication|kbdinteractive|permitrootlogin'                # baseline still applied
```

Match each session to a change record (deploy, incident, drill). The journal shows key fingerprints, not people:
keep the fingerprint → person list in the private ops repository, never in this repository.

**Mitigation**

- Unexplained session or `sudo`: treat as a security incident (`incident.md`). Remove the key from the inventory and
  re-run the playbook (`ansible-playbook -i inventory.lean.yml playbooks/lean.yml` in `infra/ansible`), rotate the
  host's secrets that the session could read (`key-and-cert-rotation.md`), and rebuild the VM from IaC
  (`infra/opentofu/envs/azure-lean`) if the session cannot be explained.
- Baseline drift (`sshd -T` shows password or root login): re-run the playbook and find who changed it.

**Escalation**

- Info in chat; weekly review. Unexplained access: security critical (both named security responders, C-67).

## Quarterly access review

1. List the authorised keys on every host (`cut -d' ' -f1-2 ~maint/.ssh/authorized_keys` per maintainer account)
   and compare with the inventory; remove leavers.
2. Review the accounts with production reach (Azure subscription roles, GitHub organisation owners, npm publishers,
   age recipients that the deployment's `infra/ansible/group_vars/lean.sops.yaml` (made once, `infra/ansible/README.md`) is encrypted to — `sops --decrypt` must fail for a leaver's key after re-encryption) against the current maintainer list.
3. SCF-operator accounts: `GET /v1/operator/operators` (an `operator_admin`); revoke leavers' roles with
   `DELETE /v1/operator/operators/{userId}` (`operatorRevoke`) and revoke their API keys (`GET /v1/operator/api-keys`,
   `POST /v1/operator/api-keys/{keyId}/revoke`).
4. Record the result (date, what was removed) in the private ops repository.

## Related

- `docs/security/hardening.md` §4, ADR-0019, C-79.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks). Drill: open an SSH session on the lean test VM
  (`KEEP=1 infra/ansible/tests/lean/run.sh`) and find it with the first checks above.
