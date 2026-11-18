# Runbook: Stellar signing account changed (SEP-10 server key, audit-anchor account)

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-14
Alerts: SigningAccountChanged

Source: `docs/monitoring-plan.md` §4.4. Alert state (`ops/alerts/coverage.json`): **no rule yet** —
`scf_signing_account_changes_total{account_role}` is not exported (owner: an on-chain watch in the jobs
service). Until it exists, check the two accounts by hand weekly (first checks below).

## The two accounts

| Role | Key | Where it lives | Built |
|---|---|---|---|
| SEP-10 server signing key (C-15) | `SCF_SEP10_SIGNING_SEED` (`S…`; file `sep10_signing_seed`, owner uid 1000) | control plane (`services/control-plane/src/auth/sep10.ts`); local: created by `infra/compose/scripts/dev-secrets.sh`; lean: `infra/ansible/scripts/gen-stack-secrets.sh` → SOPS → `/etc/scf/stack/secrets/sep10_signing_seed` | **yes** — SEP-10 sign-in and L2 Stellar-account linking (`POST /v1/auth/stellar/challenge` with `method: "sep10"`); its public key must be published as `SIGNING_KEY` in the service domain's `stellar.toml` (serving that file is a deployment item) |
| Audit-anchor account (C-63) | `SCF_AUDIT_ANCHOR_STELLAR_SECRET` | jobs service, job `audit_anchor` (`manage_data scf-audit-<YYYYMMDD>`) | **yes**, optional — unset locally (file anchors only); checked on testnet 2026-11-13 (`services/jobs/README.md`) |

The SEP-10 key signs challenges only; it should be an account with **no funds and no other signers** (or no account
at all on the ledger). The anchor account holds a small XLM balance for fees.

## SigningAccountChanged (TM-AUT-04.M.1)

**Meaning.** Signers, thresholds or `home_domain` of the SEP-10 signing account or the audit-anchor account changed
on-chain.

**First checks** (public data only; `G…` is the account's public key):

```sh
curl -s https://horizon.stellar.org/accounts/<G…> | jq '{signers, thresholds, home_domain, last_modified_ledger}'
curl -s 'https://horizon.stellar.org/accounts/<G…>/operations?order=desc&limit=10' | jq '._embedded.records[] | {type, created_at, transaction_hash}'
```

- Which operation (`set_options`, `account_merge`) and when; was it ours (a planned rotation in the change record)?
- Who holds the seed: SOPS file of the service operator and the VM's secret file — nobody else should.
- For the anchor account: are the latest anchors (`audit-anchors/<D>.json`, `manage_data` entries) still ours? The
  `audit_verify` job checks the latest published anchor (`scf_audit_chain_problems`, `audit-chain.md`).

**Mitigation** — unexplained change = the key is compromised:

1. **SEP-10:** generate a new seed (`node -e` with `@stellar/stellar-sdk` `Keypair.random()`, as `dev-secrets.sh` does —
   never printed, written straight to the secret file), put it in SOPS, re-run the playbook (lean) or replace
   `.secrets/sep10_signing_seed` and `$DC up -d --no-deps --force-recreate control-plane` (local). Publish the new
   `SIGNING_KEY` in `stellar.toml` at the same time; challenges signed with the old key expire within 10 minutes
   (`SEP10_TTL_S`), so there is no overlap to manage. Users of wallets that pin the old key re-trust the new one from
   `stellar.toml`.
2. **Anchor account:** stop the Stellar publisher (unset `SCF_AUDIT_ANCHOR_STELLAR_SECRET`; file anchors continue),
   create a new account, publish its address where the old one was published (evidence repository README), set the
   new secret, and record the switch-over date in the audit-anchor documentation. Anchors written by the attacker
   after the compromise must be listed as not ours.
3. Both: record in the private ops issue; `incident.md`.

Planned rotation (handover, C-50) follows the same steps without the incident.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- C-15, C-50, C-63, `key-and-cert-rotation.md` §8, `audit-chain.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).
