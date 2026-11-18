# Ansible: host configuration (ADR-0019)

ansible-core 2.22.0 in a pinned tool image (`tools/Dockerfile`; collection `community.sops` 2.5.1 in
`requirements.yml`). Run from a service-operator workstation with SOPS-decrypted secrets, never from CI (C-79).

**Production is the lean profile (C-123): `playbooks/lean.yml`** — the repository's Compose stack on one VM
(`docs/guides/deploy-azure.md`). `playbooks/site.yml` is the documented multi-node scale-out path.

```sh
# lean profile
tofu -chdir=infra/opentofu/envs/azure-lean output -json | infra/ansible/scripts/inventory-from-tofu.py --lean > infra/ansible/inventory.lean.yml
infra/ansible/scripts/gen-stack-secrets.sh --age-recipient age1… | sops --encrypt … /dev/stdin > infra/ansible/group_vars/lean.sops.yaml  # once
ansible-playbook -i inventory.lean.yml playbooks/lean.yml   # in infra/ansible; group_vars/lean.yml from lean.yml.example
infra/ansible/tests/lean/run.sh                             # the lean playbook applied to a Debian 13 VM container, stack up, checks

# scale-out profile
tofu -chdir=infra/opentofu/envs/azure-eu output -json nodes | infra/ansible/scripts/inventory-from-tofu.py > infra/ansible/inventory/azure.yml
ansible-playbook playbooks/site.yml          # in infra/ansible, secrets from group_vars/all.sops.yaml
infra/ansible/tests/run.sh                   # syntax-check, ansible-lint (production profile), role tests
```

| Role | What |
|---|---|
| `docker_engine` | Docker CE 29.9.3 / containerd.io 2.4.2-3 / Compose plugin 5.7.0 from Docker's Debian repository, the repository key shipped in the role and checked by sha256, packages **held**; `daemon.json`: data root on the data disk, `userland-proxy: false` (published ports keep the client address), `live-restore`, `no-new-privileges`, log driver `local` with rotation (10 MB × 5) |
| `compose_stack` | **lean profile:** the release (`git archive` of a tag: `infra/compose`, `ops/` configuration, `db/`) + the released tracker build under `/opt/scf/releases/<rev>` → `/opt/scf/current`; secrets **only from SOPS** (`scf_stack_secrets`, made once by `scripts/gen-stack-secrets.sh` — `dev-secrets.sh`/`dev-pki.sh` are never used), derived URLs/PgBouncer auth file/edge public key computed here, 0700 directory, one-consumer files 0400 with their uid; public TLS by **lego 5.6.0** (sha256-pinned) DNS-01 on Azure DNS with the VM's managed identity, systemd timer `scf-acme.timer`, deploy hook → gateway `SIGHUP` / portal restart; `compose.prod.yaml`: images by digest, gateway on the ingest address :443, portal (production Caddyfile, TLS) on the portal address :443, control plane without a host port and `SCF_TRUST_PROXY` = the portal's fixed address, PostgreSQL = the HA image in **single mode** (no Patroni) with pgBackRest archiving to both repositories via managed identity and the backup scheduler (weekly full, daily diff, hourly check, weekly logical dump uploaded with a managed-identity token), monitoring overlay without the scale-out services, node exporter for the backup/drill metrics; `up --wait` |
| `common` | packages, SSH hardening, nftables default-deny egress per class (C-10) — only our own table, Docker's rules untouched; containers obey the same allow-list; edge nodes: no core dumps, no swap |
| `pki` | private CA on the workstation (key encrypted with the SOPS passphrase); per-node certificates with **one OU naming the role and CN = node name** (C-113/C-114: edge; engine-proxy, reader, provisioner, writer and control-plane identities on cores); renewal 30 days before expiry; keys 0600 owned by their one consumer |
| `postgres` | the HA image (Patroni + pgBackRest) with host networking, etcd member, primary-following HAProxy on `127.0.0.1:5000`, pgBackRest with managed identity (`key-type=auto`); **creates `umami_app` and database `umami`** on the primary (C-113/C-115), password as a SCRAM verifier |
| `pgbouncer` | transaction pooling for the runtime roles, server side the local HAProxy, so a failover needs no reload |
| `egress_proxy` | Squid allow-list of destination domains per source class, no access log (no client addresses) |
| `restore_drill` | weekly systemd timer on `mon-c` (lean: the standby VM, else the app VM): the restore drill with read-only access to repository 2 |
| `pki` (DCS) | `site.yml` runs it a second time with a CA of its own for etcd and Patroni (F15): etcd client + peer TLS with client-certificate auth, Patroni REST API over TLS, HAProxy verifying it |

Tests (`tests/test.yml`, real PostgreSQL 18.6 container): certificates verify against the CA with the right
OU/CN/EKU/SAN and 0600 keys; a second run re-issues nothing; a certificate inside the renewal window is re-issued;
`umami_app` can log in with the SOPS password, owns `umami`, has no superuser/createdb/createrole, is stored as SCRAM;
a second run changes nothing; rendered PgBouncer, nftables, Squid and drill configuration contain what C-10/C-103
require.

Lean test (`tests/lean/run.sh`): see the header of the script for what it applies and checks; the only substitutes are
CA-issued instead of ACME certificates, two local pgBackRest repositories instead of Azure Blob, and images loaded
instead of pulled.
