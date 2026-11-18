# Runbook: audit chain verification and anchor

Status: to be exercised (no drill has run)
Owner: security responders (unverified/missing anchor: maintainers)
Last reviewed: 2026-11-13
Alerts: AuditChainBroken, AuditChainUnverified, AuditAnchorMissing, AuditAnchorMismatch, SealHistoryMismatch

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `AuditChainBroken` — no rule yet: the signal is missing (`scf_audit_chain_verify_ok`, owner: jobs, audit verification); `AuditChainUnverified` — no rule yet: the signal is missing (`scf_job_last_success_timestamp_seconds{job_name="audit_verify"}`, owner: jobs); `AuditAnchorMissing` — no rule yet: the signal is missing (`scf_audit_anchor_last_published_day_timestamp_seconds`, owner: jobs, audit_anchor); `AuditAnchorMismatch` — no rule yet: the signal is missing (`scf_audit_anchor_mismatches_total`, owner: jobs, audit_anchor).

**Built today:** the hash-chained audit log in `scf` (`audit_chain_append`, owner role `scf_audit_definer`, canonical form v2; tenant audit readable at `GET /v1/tenants/{tenantId}/audit` with `row_hash`/`prev_hash`). The daily verification job and the anchor publication (C-63) are planned.

## AuditChainBroken (TM-OPR-03.M.1)

**Meaning.** Recomputing the hash chain failed: a row was changed or removed after the fact, or a canonicalisation bug.

**First checks**

- First row where the recomputed hash differs; backups and the last anchor show the original.

**Mitigation**

- Preserve evidence (no fixes in place); compare with a restored copy; treat as tampering until proven a bug.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## AuditChainUnverified (TM-OPR-03.M.2)

**Meaning.** Chain verification has not succeeded for 26 h.

**First checks**

- Job failures.

**Mitigation**

- Re-run verification.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## AuditAnchorMissing (TM-OPR-03.M.3)

**Meaning.** No head hash was published in the public evidence repository for the previous UTC day.

**First checks**

- Publication job and its repository credential; Stellar network access if ledger anchoring is on.

**Mitigation**

- Publish the missed day's head hash (it can be computed afterwards; the gap is visible and stated).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## AuditAnchorMismatch (TM-OPR-03.M.4)

**Meaning.** The recomputed head hash for an anchored day differs from the published anchor: history before that anchor was rewritten.

**First checks**

- As for AuditChainBroken.

**Mitigation**

- As for AuditChainBroken; inform SCF operators.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## SealHistoryMismatch (TM-D1-06.M.1)

**Meaning.** The daily seal's walk of its own transaction history on the ledger (plan C1 #10;
`scf_seal_history_problems{network}`, set on every `daily_seal` run) found a seal transaction that was rewritten,
missing, out of order or unknown to the published days. A past seal may have been rewritten, or the seal key used by
someone else. (audit_anchor runs daily at 00:15 with an hourly retry; this alert does not depend on that schedule.)

**First checks**

- The jobs log of `daily_seal` (it lists each problem with day and transaction hash).
- The seal account's history on a block explorer for that network; signers and thresholds (`SigningAccountChanged`).

**Mitigation**

- Stop the seal job (unset its key) until explained; rotate the seal key if it is not ours (`key-and-cert-rotation.md`).
- Testnet resets show as a new segment, not as this alert; on testnet confirm no reset happened.

**Escalation**

- Critical to the security responders; unexplained → incident and public note (the seal is a public claim).

## Related

- ADR-0014, C-57, C-63, `docs/contracts/wire-formats.md` §m.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
