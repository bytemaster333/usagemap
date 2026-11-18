# Operator runbooks

Runbooks for the people who run the platform (the **service operator**'s maintainers) and for **SCF operators**
(portal users with `operator` / `operator_admin`; C-59). Requirement docs.operator-runbooks ("Operator runbooks"). Every runbook is
**to be exercised**: none counts as verified until a drill has run it once and the drill is logged below.

Conventions:

- Each file starts with `Status`, `Owner`, `Last reviewed` and the alerts or triggers it covers. Runbooks are
  reviewed quarterly and after every use (`docs/monitoring-plan.md` §5).
- **Alert runbooks** are one file per runbook name used in the "Runbook" column of `docs/monitoring-plan.md` §4.4
  (the name alerts link and that `ops/internal/alertlint` checks for), with one section per alert: Meaning, First checks, Mitigation,
  Escalation. Several alerts share a file where they share a cause.
- Each runbook says what is **built today** and what is **not built yet**. The monitoring stack that evaluates the
  alerts is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes
  (`infra/compose/compose.monitoring.yaml`; on the lean production VM through `infra/ansible/roles/compose_stack`),
  checked end to end by `ops/e2e/run.sh`. Rules live in `ops/alerts/*.rules.yaml` (promtool unit tests,
  `ops/alerts/test.sh`); `ops/alerts/coverage.json` states for every alert below whether it is a rule, a partial
  rule, waits for a missing metric (named there) or is raised outside Prometheus. Dashboards are in `ops/dashboards/`.
  The dead-man's switch is checked from outside by `.github/workflows/deadman.yml` (`ops/deadman/check.sh`).
- Commands are those that exist in this repository (`docker compose -f infra/compose/compose.yaml …`, `make` targets,
  service subcommands). Production is the lean Azure profile (C-123: `infra/opentofu/envs/azure-lean`,
  `infra/ansible/playbooks/lean.yml`); commands for it run on `app-1`.
- **`$DC`** in a runbook is the Compose command of the environment you are on:
  - local stack: `DC="docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml"` (add `-p <project>` for a side-by-side copy);
  - lean production VM `app-1` (C-123, layout of `infra/ansible/roles/compose_stack`, the same command
    `infra/ansible/tests/lean/run.sh` uses): `DC="docker compose -p scf --project-directory /opt/scf/current/infra/compose -f /opt/scf/current/infra/compose/compose.yaml -f /opt/scf/current/infra/compose/compose.monitoring.yaml -f /etc/scf/stack/compose.prod.yaml"`.
  
  A superuser `psql` without putting the password on a command line:
  `$DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -U postgres -d scf'`
  (the local stack authenticates the socket with SCRAM too).
- Privacy: no runbook step collects or looks up IP addresses, User-Agents, request headers, tokens, query strings or
  end-user wallet addresses — the services never log them, and diagnosis must not start to.

## Procedure runbooks

| File | Purpose |
|---|---|
| [`incident.md`](incident.md) | Declaring, running, communicating and closing an incident; post-mortems |
| [`security-patch-24h.md`](security-patch-24h.md) | The 24-hour patch-or-mitigate process (ADR-0023, C-67, C-49) |
| [`tenant-lifecycle.md`](tenant-lifecycle.md) | Approve, suspend, reinstate, remove, restore, purge; re-approval; tombstones |
| [`erasure-request.md`](erasure-request.md) | Right-to-erasure requests (ADR-0030); endpoints planned |
| [`key-and-cert-rotation.md`](key-and-cert-rotation.md) | Node certificates, snapshot-signing key, peppers, tokens and keys, Umami credentials, Stellar keys |
| [`umami-upgrade.md`](umami-upgrade.md) | Upgrading the pinned Umami engine |
| [`app-secret-rotation.md`](app-secret-rotation.md) | Rotating Umami's `APP_SECRET` |
| [`backup-failure.md`](backup-failure.md) | Failed or stale backups, WAL archiving, logical dumps |
| [`restore-drill.md`](restore-drill.md) | The weekly restore drill and its failures |
| [`restore-pitr.md`](restore-pitr.md) | Point-in-time restore |
| [`restore-logical-dump.md`](restore-logical-dump.md) | Restore from the weekly logical dump |
| [`failover-postgres.md`](failover-postgres.md) | PostgreSQL failover, switchover, fencing and rejoin (HA overlay, C-120) |
| [`handover-migration.md`](handover-migration.md) | Data migration into a new operator's infrastructure: freeze, dump, out-of-band hash, import, fingerprint diff (handover.independent-operator, handover.data-migration) |
| [`end-of-window-no-successor.md`](end-of-window-no-successor.md) | End of the service window without a successor: read-only switch, aggregate export, hash check, hand-off to the steward, shutdown (ops.end-of-window-read-only) |
| [`support-sla.md`](support-sla.md) | Support clock, labels, issue forms, the monthly support report and the monthly SLO verdict (95 % coverage floor) |
| [`alert-email.md`](alert-email.md) | Alert e-mail to the operations lead and the `security@`/`alerts@usagemap.dev` mailboxes: Cloudflare Email Routing + the alert mailer Worker; set-up script, API token, deploy, failures, rotation |

## Alert → runbook

Every alert of `docs/monitoring-plan.md` §4.4.

| Alert | Monitor ID | Severity | Runbook |
|---|---|---|---|
| IngestBurnRateFast | TM-DOS-01.M.1 | critical | [`ingest-burn-rate.md`](ingest-burn-rate.md) |
| IngestBurnRateSlow | TM-DOS-01.M.2 | critical | [`ingest-burn-rate.md`](ingest-burn-rate.md) |
| IngestBudgetTicket | TM-DOS-01.M.3 | warning | [`ingest-burn-rate.md`](ingest-burn-rate.md) |
| DashboardBurnRateFast / Slow | TM-DOS-04.M.1 | critical | [`dashboard-burn-rate.md`](dashboard-burn-rate.md) |
| ProbeQuorumFailing | TM-DOS-01.M.4 | critical | [`ingest-probe-failure.md`](ingest-probe-failure.md) |
| SingleVantageFailing | TM-DOS-01.M.5 | info | [`prober-health.md`](prober-health.md) |
| IngestHostnameDegraded | TM-DOS-01.M.8 | critical | [`ingest-hostname-degraded.md`](ingest-hostname-degraded.md) |
| EdgeNodeProbeFailing | TM-DOS-01.M.9 | warning; critical if the node is still in DNS after 5 m | [`edge-node-down.md`](edge-node-down.md) |
| FreshnessSLOAtRisk | TM-DOS-04.M.2 | warning | [`freshness-degraded.md`](freshness-degraded.md) |
| FreshnessStalled | TM-DOS-04.M.3 | critical | [`freshness-degraded.md`](freshness-degraded.md) |
| EdgeNodeDown | TM-DOS-01.M.6 | warning | [`edge-node-down.md`](edge-node-down.md) |
| IngestCapacityDegraded | TM-DOS-01.M.7 | critical | [`edge-node-down.md`](edge-node-down.md) |
| HealthControllerNoLease | TM-DOS-05.M.1 | critical | [`dns-health-controller.md`](dns-health-controller.md) |
| EngineProxyDown | TM-DOS-04.M.7 | warning; critical if both cores | [`engine-proxy.md`](engine-proxy.md) |
| CacheTokenHitLow | TM-DOS-04.M.8 | warning | [`engine-proxy.md`](engine-proxy.md) |
| DNSRecordDrift | TM-EDG-06.M.1 | warning | [`dns-drift.md`](dns-drift.md) |
| DNSRecordForeign | TM-EDG-06.M.2 | critical | [`dns-drift.md`](dns-drift.md) |
| CertExpiring | TM-DOS-07.M.1 | warning / critical | [`certificate-renewal.md`](certificate-renewal.md) |
| SupportResponseDue | — | warning | [`support-sla.md`](support-sla.md) |
| SpoolAge | TM-DOS-03.M.1 | warning / critical | [`spool-backlog.md`](spool-backlog.md) |
| SpoolDepthHigh | TM-DOS-03.M.2 | warning / critical | [`spool-backlog.md`](spool-backlog.md) |
| SpoolDiscarded | TM-DOS-03.M.3 | critical | [`spool-backlog.md`](spool-backlog.md) |
| SpoolCorruptFrames | TM-INF-08.M.2 | critical | [`spool-backlog.md`](spool-backlog.md) |
| EventKeyEvictions | TM-INF-08.M.3 | warning | [`forwarder-errors.md`](forwarder-errors.md) |
| RangeListsStale | TM-INF-03.M.1 | warning | [`range-lists.md`](range-lists.md) |
| UmamiSiteDrift | TM-ISO-05.M.2 | warning | [`adapter-errors.md`](adapter-errors.md) |
| SealHistoryMismatch | TM-D1-06.M.1 | critical | [`audit-chain.md`](audit-chain.md) |
| ForwardErrors | TM-UMA-01.M.1 | warning | [`forwarder-errors.md`](forwarder-errors.md) |
| DuplicateForwardsHigh | TM-INF-08.M.1 | warning | [`forwarder-errors.md`](forwarder-errors.md) |
| DurabilityDiscrepancy | TM-EDG-09.M.2 | critical | [`durability-reconciliation.md`](durability-reconciliation.md) |
| CanaryCountMismatch | TM-EDG-09.M.3 | critical | [`durability-reconciliation.md`](durability-reconciliation.md) |
| ReconciliationStale | TM-EDG-09.M.4 | warning | [`durability-reconciliation.md`](durability-reconciliation.md) |
| WriterDedupeAnomaly | TM-OTL-02.M.1 | warning | [`otlp-writer.md`](otlp-writer.md) |
| WriterRejectedData | TM-DOS-06.M.4 | warning | [`otlp-writer.md`](otlp-writer.md) |
| StreamResetsHigh | TM-OTL-02.M.2 | info + portal notice to tenant | [`otlp-writer.md`](otlp-writer.md) |
| RejectedWebSpikePlatform | TM-INF-01.M.1 | warning | [`verdict-shift.md`](verdict-shift.md) |
| VerifiedShareDropPlatform | TM-INF-02.M.1 | critical | [`verdict-shift.md`](verdict-shift.md) |
| OTLPRejectedSpike | TM-OTL-05.M.1 | warning | [`otlp-rejections.md`](otlp-rejections.md) |
| CardinalityOverflow | TM-OTL-06.M.1 | portal notice | [`cardinality-overflow.md`](cardinality-overflow.md) |
| CardinalityOverflowPlatform | TM-OTL-06.M.2 | warning | [`cardinality-overflow.md`](cardinality-overflow.md) |
| RedactedValuesSeen | TM-OTL-11.M.1 | portal notice | [`redacted-paths.md`](redacted-paths.md) |
| RedactedBurst | TM-OTL-11.M.2 | warning | [`redacted-paths.md`](redacted-paths.md) |
| CollectorQueueHigh | TM-DOS-06.M.1 | warning / critical | [`otlp-writer.md`](otlp-writer.md) |
| CollectorExportFailing | TM-DOS-06.M.2 | critical | [`otlp-writer.md`](otlp-writer.md) |
| CollectorSanitiseDrops | TM-OTL-05.M.3 | warning | [`otlp-rejections.md`](otlp-rejections.md) |
| CollectorReceivedAtFallback | TM-OTL-05.M.4 | warning | [`otlp-rejections.md`](otlp-rejections.md) |
| CollectorSpanFilterHit | TM-OTL-05.M.5 | warning | [`otlp-rejections.md`](otlp-rejections.md) |
| WriterListenerClosed | TM-DOS-06.M.3 | warning (one); critical (both) | [`otlp-writer.md`](otlp-writer.md) |
| KDayRegenerated | TM-DOS-08.M.1 | warning | [`visitor-key-regenerated.md`](visitor-key-regenerated.md) |
| SiteRateLimited | TM-DOS-02.M.3 | portal notice to the tenant; warning to maintainers if > 10 sites in an hour | [`site-quota.md`](site-quota.md) |
| SuspectSurgeOnSite | TM-DOS-02.M.4 | portal notice to the tenant and `operator_admin`s | [`verdict-shift.md`](verdict-shift.md) |
| SnapshotStale | TM-EDG-10.M.1 | critical | [`snapshot-stale.md`](snapshot-stale.md) |
| CanaryIsolationBreach | TM-ISO-01.M.1 | critical | [`isolation-breach.md`](isolation-breach.md) |
| CanaryProbeFailing | TM-ISO-01.M.2 | warning | [`isolation-breach.md`](isolation-breach.md) |
| RLSCoverageDrift | TM-ISO-02.M.1 | critical | [`rls-coverage.md`](rls-coverage.md) |
| AdapterForbidden | TM-ISO-05.M.1 | warning | [`adapter-errors.md`](adapter-errors.md) |
| CrossTenantFanout | TM-ISO-06.M.1 | critical | [`cross-tenant-fanout.md`](cross-tenant-fanout.md) |
| AuditChainBroken | TM-OPR-03.M.1 | critical | [`audit-chain.md`](audit-chain.md) |
| AuditChainUnverified | TM-OPR-03.M.2 | warning | [`audit-chain.md`](audit-chain.md) |
| AuditAnchorMissing | TM-OPR-03.M.3 | warning | [`audit-chain.md`](audit-chain.md) |
| AuditAnchorMismatch | TM-OPR-03.M.4 | critical | [`audit-chain.md`](audit-chain.md) |
| SCFOperatorBulkRead | TM-OPR-01.M.1 | warning | [`operator-activity.md`](operator-activity.md) |
| SCFOperatorPrivilegedAction | TM-OPR-04.M.1 | portal notice to all `operator_admin`s; info | [`operator-activity.md`](operator-activity.md) |
| SCFOperatorAuthAnomaly | TM-OPR-06.M.1 | warning | [`auth-anomaly.md`](auth-anomaly.md) |
| AuthFailureSpike | TM-AUT-03.M.1 | warning | [`auth-anomaly.md`](auth-anomaly.md) |
| OpKeyAnomaly | TM-ISO-10.M.1 | warning | [`api-key-anomaly.md`](api-key-anomaly.md) |
| RevokedTokenStillAccepted | TM-OTL-05.M.2 | critical | [`revocation-propagation.md`](revocation-propagation.md) |
| SnapshotSignatureInvalid | TM-EDG-10.M.2 | critical | [`snapshot-stale.md`](snapshot-stale.md) |
| EgressDenied | TM-UMA-01.M.2 | critical | [`egress-denied.md`](egress-denied.md) |
| UnexpectedListener | TM-EDG-08.M.1 | critical | [`unexpected-listener.md`](unexpected-listener.md) |
| NodeVerdictDivergence | TM-EDG-03.M.1 | warning | [`edge-divergence.md`](edge-divergence.md) |
| KDayDivergence | TM-EDG-03.M.2 | warning | [`visitor-key-regenerated.md`](visitor-key-regenerated.md) |
| ProxyDenied | TM-EDG-08.M.3 | critical | [`engine-proxy.md`](engine-proxy.md) |
| TrackerHashDrift | TM-TRK-03.M.1 | critical | [`tracker-hash-drift.md`](tracker-hash-drift.md) |
| NpmUnexpectedVersion | TM-TRK-02.M.1 | critical | [`tracker-hash-drift.md`](tracker-hash-drift.md) |
| ReproducibleBuildMismatch | TM-TRK-01.M.1 | critical | [`tracker-hash-drift.md`](tracker-hash-drift.md) |
| CTUnexpectedCertificate | TM-TRK-04.M.1 | critical | [`ct-alert.md`](ct-alert.md) |
| DependencyAdvisoryUrgent | TM-UMA-04.M.1 | critical | [`vulnerability-response.md`](vulnerability-response.md) |
| UmamiUpstreamSecuritySignal | TM-UMA-04.M.2 | warning | [`vulnerability-response.md`](vulnerability-response.md) |
| DeployVerifyFailed | TM-OPS-04.M.1 | critical | [`deploy-verify.md`](deploy-verify.md) |
| MonitoringNodeAccess | TM-OPS-06.M.1 | critical | [`monitoring-node.md`](monitoring-node.md) |
| SigningAccountChanged | TM-AUT-04.M.1 | critical | [`sep10-signing-key.md`](sep10-signing-key.md) |
| LogPIIDetected | TM-PRV-06.M.1 | critical | [`log-pii.md`](log-pii.md) |
| SignupBurst | TM-ENR-06.M.1 | warning | [`enrollment-abuse.md`](enrollment-abuse.md) |
| DomainReclaimed | TM-ENR-03.M.1 | portal notice | [`enrollment-abuse.md`](enrollment-abuse.md) |
| VerifierEgressDenied | TM-ENR-07.M.1 | warning | [`verifier-ssrf.md`](verifier-ssrf.md) |
| SSHSession | TM-OPS-02.M.1 | info (chat) | [`access-review.md`](access-review.md) |
| DiskPredictedFull | TM-DOS-03.M.4 | warning | [`disk-space.md`](disk-space.md) |
| DiskHigh | — | warning | [`disk-space.md`](disk-space.md) |
| IngestAboveTested | TM-DOS-02.M.1 | warning | [`capacity-review.md`](capacity-review.md) |
| EdgeCPUHigh | TM-DOS-02.M.2 | warning | [`capacity-review.md`](capacity-review.md) |
| ConnectionsNearMax | — | warning | [`postgres-connections.md`](postgres-connections.md) |
| PatroniNoLeader | TM-DOS-04.M.4 | critical | [`postgres-failover.md`](postgres-failover.md) |
| ReplicationLagHigh | TM-DOS-04.M.5 | warning | [`postgres-replication.md`](postgres-replication.md) |
| EtcdMembersLow | TM-DOS-04.M.6 | warning | [`postgres-failover.md`](postgres-failover.md) |
| XIDWraparoundRisk | — | warning | [`postgres-vacuum.md`](postgres-vacuum.md) |
| WALArchiveFailing | TM-OPS-01.M.1 | critical | [`backup-failure.md`](backup-failure.md) |
| BackupFullStale | TM-OPS-01.M.2 | warning | [`backup-failure.md`](backup-failure.md) |
| BackupDiffStale | TM-OPS-01.M.3 | warning | [`backup-failure.md`](backup-failure.md) |
| BackupCheckFailing | TM-OPS-01.M.4 | critical | [`backup-failure.md`](backup-failure.md) |
| LogicalDumpStale | TM-OPS-01.M.5 | warning | [`backup-failure.md`](backup-failure.md) |
| RestoreDrillStale | TM-OPS-01.M.6 | critical | [`restore-drill.md`](restore-drill.md) |
| RestoreDrillIntegrityMismatch | TM-OPR-02.M.1 | critical | [`restore-drill.md`](restore-drill.md) |
| Watchdog | — | none (heartbeat) | [`dead-mans-switch.md`](dead-mans-switch.md) |
| DeadMansSwitchMissed | — | critical (raised by the workflow) | [`dead-mans-switch.md`](dead-mans-switch.md) |
| NotificationsFailing | — | warning (via the other channel) | [`alert-delivery.md`](alert-delivery.md) |
| NTPOffset | — | warning | [`time-sync.md`](time-sync.md) |
| WireGuardStale | TM-EDG-08.M.2 | warning | [`mesh-health.md`](mesh-health.md) |

## Drill log

A runbook moves from "to be exercised" to "exercised" only with an entry here (date, runbook, environment, what was
done, result, follow-ups); the details are in each runbook's own drill log. Environment "Compose `scf-tg`" = the local
stack (`infra/compose/compose.yaml`, project `scf-tg`, ports 56450–56452, a project-private secrets directory), images
built from the working tree; traffic from the gateway's `probe` client and an
OTLP client through the front door.

| Date | Runbook | Environment | Result | Follow-ups |
|---|---|---|---|---|
| 2026-11-14 | `edge-node-down.md` (gateway restart / recreate) | Compose `scf-tg` | pass — 62/62 and 56/56 accepted events stored, gap ≤ 4.3 s, spool 0, `KDayRegenerated` as expected | command corrected (`--no-deps`, no profiles) |
| 2026-11-14 | `otlp-writer.md` (writer and Collector restart) | Compose `scf-tg` | pass — 89/89 and 82/82 acknowledged points stored | — |
| 2026-11-14 | `umami-upgrade.md` (no-op upgrade) | Compose `scf-tg` + `scf-tg-umami` | pass — pin check, hardening 39/0/1 skipped, stop/start chain: 125/125 events stored, ≈ 19 s engine down | engine-proxy, adapter-contract and jobs integration suites not run |
| 2026-11-14 | `app-secret-rotation.md` | Compose `scf-tg` | pass — 133/133 events stored; smoke 127 passed, 2 exact-total checks fail on a re-used stack (points were stored) | — |
| 2026-11-14 | `key-and-cert-rotation.md` §1, §2 | Compose `scf-tg` | pass after correction — `SIGHUP` does not see re-issued bind-mounted files, restart does; snapshot key edge-1 → edge-2 without refusals | runbook §1 corrected; `infra/compose/README.md` "To rotate" needs the same correction; lean profile has no second snapshot-key slot |
| 2026-11-14 | `erasure-request.md` | Compose `scf-tg` | pass — 3 canary events erased, 4 kept, no literal selector in audit or logs | breakdown/totals not checked (no rollup yet) |
| 2026-11-14 | `tenant-lifecycle.md` | Compose `scf-tg`, operator via Playwright + virtual passkey | pass — suspend 0/3 stored, reinstate 3/3, remove/restore/purge, purge 2.7 s after jobs restart, tombstone lifted | step-up column corrected |
| 2026-11-14 | `rls-coverage.md` | Compose `scf-tg` | pass — G1–G11 ok | — |
| 2026-11-14 | `unexpected-listener.md` (local check) | Compose `scf-tg` | pass — only the three expected ports published | — |
| 2026-11-14 | `restore-drill.md` | lean single-VM test VM (`infra/ansible/tests/lean/run.sh`) | pass — `RESTORE-DRILL PASS` total 11.0 s, gates 11 ok, metrics written | `--expect`, PITR target, Azure repositories not exercised |
| 2026-11-14 | `support-sla.md` | workstation | pass — rule on 16 fixtures | live issues need the public repository |
| 2026-11-18 | `security-patch-24h.md` (PostgreSQL 18.7, Node 24.22.3 / 22.23.5) | workstation, release dry run, smoke, lean test VM | pass — fix built, released and deployed through the checklist | six steps corrected (clock/pollers, record, fix with dry run and the `pins` gate, unfixed-package exceptions, release without Actions, local deploy equivalent) |

## Known gaps between the monitoring plan and the code (2026-11-13)

- `KDayRegenerated` / `KDayDivergence`: the gateway exports `scf_gateway_keyx_conflicts{kind}` and
  `scf_gateway_keys_current`, but no counter of off-schedule key generations and no per-node key fingerprint
  (monitoring plan §4.5). Either add them to the gateway or change the alert expressions.
- `DuplicateForwardsHigh`: no ambiguous-retry (duplicate-forward) counter exists in `scf_gateway_forward_total`
  (outcomes: `delivered`, `core_failed`, `refused`, `rejected`, `deferred_twin`, `expired_72h`, `unreadable`).
- `SpoolDepthHigh` is a ratio to the cap; the gateway exports `scf_gateway_spool_bytes` but not the cap
  (`GW_SPOOL_MAX_BYTES`) — the rule needs the cap as a constant or a new gauge.
- `CollectorQueueHigh`: the plan names `queue_size`; the Collector README names `otelcol_exporter_queue_capacity`
  (bytes sizer).
- The monitoring plan's spool-age metric `spool_oldest_record_age_seconds` is `scf_gateway_spool_oldest_age_seconds`
  in the code; `snapshot_age_seconds` is `scf_gateway_snapshot_age_seconds`.
- `CacheTokenHitLow`: computable from `scf_engine_proxy_visit_lookup_hits_total` / `…_misses_total`; replays refused
  by the 30-minute rule are `scf_engine_proxy_visit_replays_refused_total`.
