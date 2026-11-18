# Runbook: capacity review

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: IngestAboveTested, EdgeCPUHigh

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `IngestAboveTested` — rule in `ops/alerts/platform.rules.yaml`; `EdgeCPUHigh` — rule in `ops/alerts/platform.rules.yaml`.

**Built today:** measured reference points: one Umami container ≈ 400 events/s (plan ≤ 300), writer 1,500 points/s at 10× (C-103, C-109). Load tests at 10× (ADR-0026): `make load` (`tests/load/run.ts`, `tests/load/run-api.ts`); capacity panels in `ops/dashboards/`.

## IngestAboveTested (TM-DOS-02.M.1)

**Meaning.** Daily events or OTLP points exceed 5× the design target (1 M page views/day, 1 M API requests/day); 10× is the tested level.

**First checks**

- Which tenants drive it; verified vs suspect share (an attack inflates raw, not verified).

**Mitigation**

- Add edge/core capacity; consider a second Umami container per core.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## EdgeCPUHigh (TM-DOS-02.M.2)

**Meaning.** p95 CPU per edge node above 70 % over 1 h.

**First checks**

- PoW verification load (adaptive difficulty doubles client cost, not server cost), TLS handshakes, multiplicity cells (`scf_gateway_multiplicity_cells`).

**Mitigation**

- Scale out edge nodes.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0026, C-48, C-109.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
