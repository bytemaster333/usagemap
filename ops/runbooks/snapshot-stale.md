# Runbook: edge snapshot stale or invalid

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-13
Alerts: SnapshotStale, SnapshotSignatureInvalid

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `SnapshotStale` — rule in `ops/alerts/data-quality.rules.yaml`; `SnapshotSignatureInvalid` — rule in `ops/alerts/security.rules.yaml`.

**Built today:** gateway `scf_gateway_snapshot_stale` (1 after 15 minutes without a fresh snapshot), `scf_gateway_snapshot_age_seconds`, `scf_gateway_snapshot_sequence`, `scf_gateway_snapshot_verify_failures{reason}`, `scf_gateway_snapshot_rollback_refused_total`; control plane `edge_snapshot` job (signing key `SCF_EDGE_SIGNING_KEY`, kid `SCF_EDGE_SIGNING_KID`).

## SnapshotStale (TM-EDG-10.M.1)

**Meaning.** A node has not accepted a fresh snapshot for 15 minutes (C-62). It keeps serving the last good one, so token revocations and suspensions do not reach it.

**First checks**

- The path edge → engine proxy (`edge` role, `GET /internal/v1/edge/snapshot`) → control plane internal API (mutual TLS, `SCF_INTERNAL_ALLOWED_CLIENTS`): `scf_engine_proxy_denials_total`, `scf_engine_proxy_upstream_errors_total`, control plane log.
- Control plane up and its database reachable (`/readyz`).

**Mitigation**

- Restore the path; if a revocation is urgent and the node cannot be fixed quickly, remove the node from DNS.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## SnapshotSignatureInvalid (TM-EDG-10.M.2)

**Meaning.** A node rejected a snapshot signature, or was offered an older sequence number: key mismatch after a rotation, or tampering.

**First checks**

- `scf_gateway_snapshot_verify_failures{reason}`; was the signing key rotated without adding the new public key to `GW_SNAPSHOT_KEYS` first? (`key-and-cert-rotation.md`)

**Mitigation**

- Rotation mistake: deploy the public key to every node, then re-sign. Otherwise treat as tampering: isolate the path and investigate.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## Related

- C-62, `docs/contracts/wire-formats.md` §e, `services/gateway/README.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
