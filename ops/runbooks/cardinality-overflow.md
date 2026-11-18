# Runbook: route cardinality overflow

Status: to be exercised (no drill has run)
Owner: maintainers (CardinalityOverflow: tenant)
Last reviewed: 2026-11-13
Alerts: CardinalityOverflow, CardinalityOverflowPlatform

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `CardinalityOverflow` — not a Prometheus alert (see `ops/alerts/coverage.json`); `CardinalityOverflowPlatform` — rule in `ops/alerts/data-quality.rules.yaml` (partial).

**Built today:** the writer's cardinality guard (`route_cap_per_service_day` 1,000, `route_cap_per_tenant_day` 5,000, `route_sibling_cap` 200, `l0_routes_per_day` 100) and `scf_ingest_dropped{reason="route_overflow"}`; Collector `memory_limiter` (`SCF_MEMORY_LIMIT_MIB`). Portal notices are planned.

## CardinalityOverflow (TM-OTL-06.M.1)

**Meaning.** A tenant's routes were sent to `{overflow}` today: the tenant sends raw paths with identifiers our rule set does not fold, or simply has many routes.

**First checks**

- The tenant's route list: many literal siblings under one prefix point at unfolded identifiers.

**Mitigation**

- Portal notice: report `http.route` (framework route templates) rather than raw paths — see the quickstarts. Caps are settings (`PATCH /v1/operator/settings/{key}`, operator_admin) but raise them only for a real route set.

**Escalation**

- Portal notice to the tenant.

## CardinalityOverflowPlatform (TM-OTL-06.M.2)

**Meaning.** More than 5 tenants overflow in one day, or the Collector's memory limiter refused data for 5 m.

**First checks**

- A new SDK version that dropped `http.route`; a rule-set regression (`packages/pathnorm` vectors).

**Mitigation**

- Fix the normaliser (new rule-set version, never rewrite history, ADR-0012); scale the Collector memory.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## Related

- ADR-0012, C-24, `packages/pathnorm/README.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
