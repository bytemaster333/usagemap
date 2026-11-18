# Runbook: forwarder errors to Umami

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-13
Alerts: ForwardErrors, DuplicateForwardsHigh, EventKeyEvictions

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `ForwardErrors` — rule in `ops/alerts/data-quality.rules.yaml`; `DuplicateForwardsHigh` — rule in `ops/alerts/edge.rules.yaml`.

**Built today:** `scf_gateway_forward_total{kind,outcome,core,error_kind}` (outcomes `delivered`, `core_failed`, `refused`, `rejected`, `deferred_twin`, `expired_72h`, `unreadable`); engine-proxy `scf_engine_proxy_send_rejected_total{reason}` and `scf_engine_proxy_upstream_errors_total`; per-site drop counters `engine_rejected` / `engine_bot_drop` (installation check, `GET /v1/tenants/{tenantId}/sites/{siteId}/installation-check`).

## ForwardErrors (TM-UMA-01.M.1)

**Meaning.** More than 1 % of forwards to Umami `/api/send` answered non-2xx over 10 m.

**First checks**

- Split by `outcome` and `core`: `rejected` / `send_rejected` means the proxy refused the payload (body > 16 KiB, field outside §c.2, surrogate outside `2001:db8::/32`) — a gateway bug after a release; `core_failed` means transport or `5xx` (`engine-proxy.md`).
- Umami answering `500`: a missing `cf-ipcountry` (the proxy sets `XX`), or database errors in the Umami log.

**Mitigation**

- Roll back a gateway or engine-proxy release that introduced `rejected`; restore Umami/PostgreSQL for `5xx`. Events wait in the spool.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## DuplicateForwardsHigh (TM-INF-08.M.1)

**Meaning.** Ambiguous retries (first attempt may have succeeded) exceed 0.1 % of forwards over 1 h; Umami may hold duplicate events.

**First checks**

- Timeouts between edge and core (mesh latency, `EP_UPSTREAM_TIMEOUT` 30 s, Umami slowness).

**Mitigation**

- Fix the latency source; report the count monthly (ADR-0020). The gateway's own metrics have no separate ambiguous-retry counter yet — see the known gaps in `README.md`.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## EventKeyEvictions (TM-INF-08.M.3)

**Meaning.** The engine proxy's event-key memory (plan C1 #11: one key per tracker action, duplicates forwarded only
once within 1 hour) is full and evicts keys before their window ends, steadily for 6 hours. Copies of an event that
arrive further apart than the shortened window reach Umami twice.

**First checks**

- `scf_engine_proxy_event_keys` against the configured capacity (services/engine-proxy README); the ingest rate.

**Mitigation**

- Raise the memory's capacity or shorten the window (engine-proxy configuration), then restart that proxy.

**Escalation**

- Warning: maintainers (issue).

## Related

- `docs/contracts/wire-formats.md` §c, C-69, C-113.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
