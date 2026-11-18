# Runbook: certificate-transparency alert

Status: to be exercised (no drill has run) — needs the production domains
Owner: security responders
Last reviewed: 2026-11-14
Alerts: CTUnexpectedCertificate

Source: `docs/monitoring-plan.md` §4.4, ADR-0023. Alert state (`ops/alerts/coverage.json`): **outside Prometheus** —
a certificate-transparency watch (an external CT monitor).

## Built today

- **Not built:** the CT watch itself, and the production domains are placeholders. The expected issuance is
  known: the lean VM obtains its public certificates **only** through lego DNS-01 with the VM's managed identity
  (`infra/ansible/roles/compose_stack/tasks/tls.yml`, `scf-acme.timer`), from the ACME server in `scf_acme_server`
  (Let's Encrypt by default), for the host names in `scf_tls_sets` (ingest names; portal + status host).
- Until a watch exists, the check below is run weekly by hand and after any DNS or registrar alert (`dns-drift.md`).

## CTUnexpectedCertificate (TM-TRK-04.M.1)

**Meaning.** A certificate for our names was logged that does not come from our ACME account and issuer — someone
else obtained a certificate for the ingest or portal names (DNS takeover, registrar compromise, a CA mis-issuance).

**First checks** (public CT data; replace `<domain>` with the deployment's apex):

```sh
curl -s 'https://crt.sh/?q=%25.<domain>&output=json' | jq -r '.[] | [.not_before, .issuer_name, .name_value, .serial_number] | @tsv' | sort -r | head -30
# our own, for comparison: what lego holds on the VM
for f in /srv/scf/acme/certificates/*.crt; do openssl x509 -in "$f" -noout -serial -issuer -dates; done   # scf_acme_dir
dig +short CAA <domain>
```

- Is every logged certificate one of ours (same serial as on the VM, or an earlier renewal in `journalctl -u scf-acme`)?
- Issuer: an unexpected CA, or our CA with an unknown account? SANs: our names only, or a wildcard we never request?
- CAA records present and limited to our CA and account (`accounturi`)? DNS change history (`dns-drift.md`).

**Mitigation**

- Ask the issuing CA to revoke the certificate (its revocation/problem-report address from the CA's CPS).
- Secure DNS and the registrar: rotate credentials, check the zone for records we did not create, re-check the
  managed identity's DNS permissions (`infra/opentofu`).
- Tighten CAA to our CA and ACME account (`issue "letsencrypt.org; accounturi=…"`, `issuewild ";"`).
- If traffic may have been intercepted: `incident.md` (tenants are affected; their trackers trust any valid
  certificate for the ingest names, SRI protects the script itself).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- ADR-0023, C-31, `certificate-renewal.md`, `dns-drift.md`, `tracker-hash-drift.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks). Drill (once the production domains are set): run the first check against the real
  domain and reconcile every logged certificate with the VM's.
