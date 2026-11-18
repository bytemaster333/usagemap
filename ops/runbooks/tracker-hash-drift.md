# Runbook: tracker hash drift

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: TrackerHashDrift, NpmUnexpectedVersion, ReproducibleBuildMismatch

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `TrackerHashDrift` — no rule yet: the signal is missing (`scf_tracker_hash_drift{target,version}`, owner: probes); `NpmUnexpectedVersion` — not a Prometheus alert (see `ops/alerts/coverage.json`); `ReproducibleBuildMismatch` — not a Prometheus alert (see `ops/alerts/coverage.json`).

**Built today:** tracker build with `manifest.json` (sha256, sha384, SRI per file), `pnpm --filter @usagemap/tracker verify-reproducible`; the gateway verifies tracker bytes against the manifest at start (`GW_TRACKER_DIR`). Manifest signing, the hourly fetch from every node address and the npm watch are planned.

## TrackerHashDrift (TM-TRK-03.M.1)

**Meaning.** A served tracker file differs from the signed manifest, a withdrawn version does not answer `410`, or the manifest signature does not verify.

**First checks**

- Which node and file; that node's image digest.

**Mitigation**

- Remove the node from DNS; redeploy from a verified image. Tenants' SRI hashes make browsers refuse a modified file (analytics stops, pages keep working).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## NpmUnexpectedVersion (TM-TRK-02.M.1)

**Meaning.** npm lists a version (or staged version) of the tracker package that is not in our release list: possible publish-credential compromise.

**First checks**

- npm account audit, staged-publishing approvals (ADR-0023).

**Mitigation**

- Deprecate/unpublish per npm policy, rotate credentials, publish an advisory.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## ReproducibleBuildMismatch (TM-TRK-01.M.1)

**Meaning.** An independent rebuild of a released tag differs from its manifest.

**First checks**

- Run `pnpm --filter @usagemap/tracker verify-reproducible` at the tag; compare toolchain versions in the manifest.

**Mitigation**

- Until explained, stop releasing; if the released bytes are not ours, withdraw the version (`410`, C-37).

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## Related

- ADR-0004, ADR-0023, C-37, `tracker/README.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
