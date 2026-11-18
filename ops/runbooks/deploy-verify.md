# Runbook: deploy verification failed

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-18
Alerts: DeployVerifyFailed

Source: `docs/monitoring-plan.md` §4.4. Alert state (`ops/alerts/coverage.json`): **outside Prometheus** — raised by
the deploy itself (the playbook fails), not by a rule.

## Built today

- The repository contains no release pipeline. When release images are signed with **cosign keyless** (GitHub OIDC)
  by a signing workflow in `scf_release_repo` (`scf_release_signer_workflow`), the playbook verifies them as below;
  without signed images, `scf_images_verify_signatures` and `scf_tracker_verify_signatures` are false (v1 host).
- Lean deploy (`infra/ansible/playbooks/lean.yml`, role `compose_stack`), before anything reaches the VM:
  - every `scf_images` value must be `<scf_image_registry>/<catalogue name>@sha256:…` (`tasks/main.yml`), and every
    image of the merged production Compose configuration must be one of them or a digest-pinned third-party image
    (`tasks/config.yml`); `up` runs with `--pull never` after the pull by digest;
  - **`cosign verify` and `cosign verify-attestation --type spdxjson`** of every image against the keyless identity
    `https://github.com/<scf_release_repo>/<scf_release_signer_workflow>@refs/tags/vX.Y.Z` on the workstation
    (`tasks/verify.yml`); a failure stops the play — this is `DeployVerifyFailed`, and the task output is the deploy
    log's verification record;
  - the **tracker releases** come from their signed release directories (`scf_tracker_releases`, downloaded with
    `gh release download tracker-vX.Y.Z`): `SHA256SUMS` checked, `release.json` clean and of that version, `cosign
    verify-blob` of `SHA256SUMS` and `manifest.json` against `…@refs/tags/tracker-vX.Y.Z`, the set of versions equal to
    `infra/compose/tracker-releases.json`, and each manifest equal to the one the gateway image embeds
    (`tasks/tracker.yml`, `tasks/up.yml`);
  - the Alertmanager receivers: the play refuses to run while maintainers-critical, maintainers-warning or
    security-responders has no channel (`scf_stack_secrets.alert_webhooks`, `scf_alert_emails`).
- SLSA provenance in GitHub's attestation store is not checked by the playbook (it needs the GitHub CLI and network
  access to GitHub): check it with `gh attestation verify` below as well.

## Verify a release before deploying it

With cosign 3.1.4 and the GitHub CLI, against the signing workflow at the release tag (C-118):

```sh
REPO=<org>/<repo> TAG=vX.Y.Z WF=<scf_release_signer_workflow>
cosign verify --certificate-identity "https://github.com/$REPO/$WF@refs/tags/$TAG" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>@sha256:…
gh attestation verify oci://<image>@sha256:… --repo "$REPO"
# compare each digest with the one pinned in infra/ansible/group_vars/lean.yml (scf_images; the deployment's copy of lean.yml.example)
```

Only a fully successful verification whose digests equal the pinned ones may be followed by
`ansible-playbook -i inventory.lean.yml playbooks/lean.yml`. Record the tag, the digests and the verification time in
the change record.

After the **first** deploy only: the platform setting `edge_counter_features` starts as `[]` (no development setting
is ever deployed, C-139). Once every control plane runs the release, an operator_admin sets it once:
`PATCH /v1/operator/settings/edge_counter_features` with `["props","dev"]` (step-up, audited; C-137). Later deploys
never touch it.

## DeployVerifyFailed (TM-OPS-04.M.1)

**Meaning.** `cosign verify` or attestation verification failed for an image or the tracker manifest of the release
being deployed.

**First checks**

- Is the digest in `group_vars/lean.yml` the one the signing workflow published (the release's notes or the signing
  run's summary)? A typo or a digest from another build fails legitimately.
- Is the certificate identity right (tag, workflow file name)? A release cut from a branch has a different identity.
- If both are right: was the registry or the release tampered with? Compare the digest with the registry's
  (`docker buildx imagetools inspect <image>@<digest>`) and with the run's logs.

**Mitigation**

- **Do not deploy**; never bypass verification (there is no supported path that skips it). Keep the running release.
- Rebuild and re-sign from the tag; if tampering is suspected, revoke the registry tokens, rotate
  the npm and GitHub credentials of the maintainers and treat it as a security incident (`incident.md`).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- ADR-0019, ADR-0023, C-79, C-118, `infra/ansible/roles/compose_stack/tasks/verify.yml`, `tracker-hash-drift.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks). Drill: once the first release exists on GitHub, verify it with the
  commands above, then repeat with one record's digest altered and confirm that `verify` fails.
