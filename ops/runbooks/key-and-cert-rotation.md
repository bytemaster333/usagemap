# Runbook: key and certificate rotation

Status: exercised 2026-11-14 (§1 node certificates, §2 snapshot-signing key; local stack under load) — see the drill log
Owner: maintainers (service operator); SCF-operator keys: `operator_admin`s
Last reviewed: 2026-11-14

Decisions: ADR-0016, C-05, C-15, C-21, C-50, C-60, C-63, C-81, C-85, C-114. Key formats: `docs/contracts/wire-formats.md`
§k. Handover list: `docs/handover-plan.md` (peppers, snapshot-signing key, SEP-10 key and audit-anchor key are handed
over, not rotated at cut-over, C-50).

In the local stack every secret below is created by `infra/compose/scripts/dev-secrets.sh` and every certificate by
`infra/compose/scripts/dev-pki.sh` (both idempotent: they never replace an existing file). In production secrets come
from SOPS + age and certificates from the IaC-managed CA — **planned** (ADR-0019). Never paste key material into
tickets, chat or logs; refer to keys by id or version.

## 1. Node certificates (private CA, mutual TLS; C-60)

Role = the certificate's single OU (`edge`, `reader`, `provisioner`), node name = CN (`^[a-z0-9][a-z0-9-]{1,31}$`).

Local stack:

1. Delete the pair to re-issue (`infra/compose/.secrets/pki/<name>.pem` and its key) and run
   `infra/compose/scripts/dev-pki.sh`; `FORCE=1` re-creates the CA and everything (a CA rotation).
2. **Restart (or recreate) every container that mounts the re-issued files** — measured in the 2026-11-14 drill:
   Compose file secrets are bind mounts of single files, and a deleted-and-re-created file is a new inode that a
   running container never sees, so a `SIGHUP` after step 1 reloads the **old** certificate (the engine proxy logged
   `tls_reloaded` and kept serving the old serial; after `$DC restart engine-proxy` it served the new one). Production
   is the same: the playbook's file copy replaces files by rename. Which containers use which certificate: table in
   `infra/compose/README.md` "Secrets and PKI". `SIGHUP` alone is only enough where the file is changed **in place**
   or mounted as a directory (the public TLS certificates in `/etc/scf/stack/tls` are a directory mount, so
   `scf-cert-deploy`'s `SIGHUP` to the gateway works). What reloads on `SIGHUP` once the container sees the new file:
   - engine proxy: `SIGHUP` (`$DC kill -s SIGHUP engine-proxy`) reloads its **listener** certificate, key, CA and CRL;
     session tickets are rotated and connections opened before the reload are closed (`services/engine-proxy/README.md`).
     Its **client** certificate toward the control plane (`core-a-engine-proxy`, `EP_CONTROL_PLANE_TLS_CERT`) is read
     at start only — restart;
   - metrics writer: `SIGHUP` reloads its TLS files and CRL (`services/metrics-writer/README.md`);
   - gateway: `SIGHUP` reloads the **listener** certificate (`GW_TLS_CERT`/`GW_TLS_KEY`); for its node certificate
     (`GW_NODE_CERT`, used toward the cores and peers) restart the container;
   - Collector: reloads its mTLS files hourly (`collector/README.md`); restart to apply at once;
   - control plane and jobs service: restart (`$DC restart control-plane`, `$DC restart jobs`).
3. Check: events still forwarded (`scf_gateway_forward_total{outcome="acked_stored"}` rising), OTLP still stored,
   and `infra/compose/scripts/smoke.sh` (own project, torn down afterwards).

**Revoking a node certificate** (compromised node): add it to the CRL given to the engine proxy (`EP_CLIENT_CRL`) and
the writers (`SCF_WRITER_TLS_CRL_FILE`), then `SIGHUP` both; revocation is checked on resumed sessions too. Remove the
node from DNS and rebuild it.

**Public certificates** (ACME DNS-01 at the gateway, Caddy for the portal) — planned.

## 2. Snapshot-signing key (Ed25519; jobs service → edge)

The **jobs service** signs (C-125; the control plane no longer holds the key) with `SCF_EDGE_SIGNING_KEY_FILE` under
kid `SCF_EDGE_SIGNING_KID` (Compose: `edge-1`); each gateway accepts every key listed in `GW_SNAPSHOT_KEYS`
(`kid=/path/pub.pem[,kid2=…]`). The base `infra/compose/compose.yaml` and the lean `compose.prod.yaml` have **one**
key slot, so the second key comes in through a Compose override file (locally) or a role change (lean; see the
drill note). Rotation without an outage:

1. Generate a new key pair with a new kid, never printed:
   `openssl genpkey -algorithm ed25519 -out edge_signing_key_2.pem && openssl pkey -in edge_signing_key_2.pem -pubout -out edge_snapshot_pub_2.pem`.
2. Add the new public key to `GW_SNAPSHOT_KEYS` on **every** edge node, keeping the old one
   (`edge-1=/run/secrets/edge_snapshot_pub,edge-2=/run/secrets/edge_snapshot_pub_2`, plus the secret); recreate the
   gateways one at a time (`$DC -f rotate.yaml up -d --no-deps gateway`).
3. Switch the jobs service to the new key and kid (`SCF_EDGE_SIGNING_KEY_FILE`, `SCF_EDGE_SIGNING_KID=edge-2`) and
   recreate it. A snapshot is re-signed only when its **content** changes (or after a quarter of
   `SCF_EDGE_SNAPSHOT_MAX_AGE_S`); a bare `NOTIFY scf_edge` does not bump the sequence. To confirm the switch at once,
   make a harmless change (e.g. a settings write) and check the newest row:
   `SELECT sequence, position('edge-2' IN convert_from(envelope, 'UTF8')) > 0 FROM scf.edge_snapshots ORDER BY sequence DESC LIMIT 1`.
4. Watch `scf_gateway_snapshot_sequence` (rises to the new snapshot), `scf_gateway_snapshot_verify_failures` (absent
   or 0) and `scf_gateway_snapshot_stale` on every node (`snapshot-stale.md`).
5. After every node has accepted a snapshot signed with the new kid, remove the old public key from
   `GW_SNAPSHOT_KEYS` and recreate the gateways; make the new key the permanent configuration (Compose file / SOPS).

## 3. Key peppers (`ing`, `op`, `pub`; C-05, C-81)

Format `<version>:<base64 of ≥ 32 bytes>[,…]` in `SCF_PEPPER_ING`, `SCF_PEPPER_OP`, `SCF_PEPPER_PUB`; `_VERSION`
selects the version that hashes **new** keys (default: the highest). Stored hashes record their pepper version, so
old keys keep verifying while their version stays listed.

1. Append a new version to the set (keep the old), set `_VERSION` to it, restart the control plane. The `ing` pepper is
   also read by every gateway (`GW_PEPPER_ING_FILE`, the OTLP front door) — update both at once and recreate the
   gateways, or new tokens fail at the edge.
2. Re-issue keys over time (below); when no live key uses the old version, remove it.

## 4. Tenant ingest tokens (`scfa_ing_…`; C-21)

Up to 5 active per tenant, so rotation is: create the new token, deploy it in the tenant's configuration, check last
use of the old one, revoke it (`createIngestToken` / `revokeIngestToken`, portal → Ingest tokens; creating needs a recent sign-in,
C-119). Revocation reaches every edge within 60 s through the snapshot (C-06).

## 5. SCF-operator API keys (`scfa_op_…`) and share keys (`scfa_pub_…`)

Operator keys expire after 90 days by default (≤ 365, C-70); revocation is effective within 5 s (C-06). Rotate by
creating a new key, switching the consumer, revoking the old one (`operatorCreateApiKey` / `operatorRevokeApiKey`;
`createShareKey` / `revokeShareKey`, the latter two with a recent sign-in, C-129).

## 6. Per-tenant Umami credentials (C-85)

Each tenant has a view-only Umami user whose password and API key are stored encrypted with `SCF_UMAMI_CREDS_KEYS`
(`<version>:<base64 32 bytes>[,…]`, AES-256-GCM; `SCF_UMAMI_CREDS_KEY_VERSION` encrypts new values). The control
plane's code in `services/control-plane/src/umami/reconcile.ts`, run by the jobs service's `umami_reconcile`
(C-125), rotates a tenant's Umami API key when it is older than 90 days.

- **Encryption key rotation:** add a new version, set `SCF_UMAMI_CREDS_KEY_VERSION`, restart; keep the old version
  until every credential has been re-encrypted. The `umami_reconcile` job re-wraps every stored credential whose
  `key_version` is not the current one, for tenants of every status (pending, suspended and removed too — audit
  finding 20 of 2026-11-18). **Before retiring the old version**, wait for one reconcile pass after the restart,
  then check with the superuser `psql` of `README.md`:

  ```sql
  SELECT count(*) FROM scf.umami_credentials c JOIN scf.tenants t USING (tenant_id)
   WHERE t.purged_at IS NULL AND c.key_version <> <current version>;   -- must be 0
  ```

  Not 0: do not remove the old version; look at the jobs log for `umami_reconcile` errors and wait for the next
  pass. Removing it early leaves those tenants' credentials undecryptable (live reads fall back silently;
  reinstatement and purge fail).
- **Provisioning identity** (`SCF_UMAMI_PROVISIONER_PASSWORD`, `UB_PROVISIONER_PASSWORD_FILE`,
  `EP_PROVISIONER_PASSWORD_FILE` share one secret): changing it needs Umami's password change for that user and the
  same new value in all three places at once; otherwise the engine proxy's bootstrap gate closes
  (`scf_engine_proxy_bootstrap_probe_provisioner_last_status` = `401`). Do it in a maintenance window and run
  `infra/compose/scripts/smoke.sh` afterwards.

## 7. Umami `APP_SECRET`

See `app-secret-rotation.md`.

## 8. Stellar keys

- **SEP-10 signing key** (`SCF_SEP10_SIGNING_SEED`, C-15; SEP-10 sign-in is built) and the **audit-anchor account**
  (`SCF_AUDIT_ANCHOR_STELLAR_SECRET`, C-63; built, optional): procedure in `sep10-signing-key.md` (Mitigation);
  a planned rotation makes `SigningAccountChanged` fire — expected.

## 9. Edge in-memory keys

`K_day`, `K_mult` (daily) and `K_chal` (hourly) rotate automatically and exist only in locked memory (C-04, C-68);
there is nothing to rotate by hand. A full restart of every gateway regenerates them (`visitor-key-regenerated.md`).

## Drill

In the local stack: re-issue `core-a-engine-proxy` and `edge-a1`, `SIGHUP` the engine proxy, run the smoke test; rotate
the snapshot-signing key by the five steps above with the gateway running. Record both in `README.md` (drill log).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452) with a project-private secrets directory, images built from the working tree; gateway probe traffic ~2 events/s throughout | **§1:** deleted and re-issued `engine-proxy`, `core-a-engine-proxy` and `edge-a1` with `dev-pki.sh`; `SIGHUP` to the engine proxy; then `$DC restart engine-proxy` and `$DC restart gateway collector`. **§2:** steps 1–5 with two override files (old+new key on the gateway; jobs signing with `edge-2`; finally `edge-2` only) | **pass after a correction.** §1: after `SIGHUP` the proxy logged `tls_reloaded` but still served the old serial (`D77A…`; bind-mounted file, see step 2 — runbook corrected); after the restart it served the new one (`766E…`), healthy 6.1 s after the restart command; 154 events accepted, 1 refused (gap 4.1 s), 154/154 stored; OTLP through the Collector with the new `edge-a1`: 12 acknowledged, 12 stored. §2: snapshot 7 was signed with `edge-2` (checked in `scf.edge_snapshots`) and accepted (sequence 6 → 7, no verify failures); after removing `edge-1` the gateway still ran on sequence 7; 124 events accepted, 2 refused during the two gateway recreates (gap 5.0 s), 124/124 stored. Not exercised: CA rotation (`FORCE=1`), CRL revocation, peppers (§3), §4–§8. |
