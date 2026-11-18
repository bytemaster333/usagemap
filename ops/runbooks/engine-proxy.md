# Runbook: engine proxy

Status: to be exercised (no drill has run)
Owner: maintainers (ProxyDenied: security responders)
Last reviewed: 2026-11-13
Alerts: EngineProxyDown, CacheTokenHitLow, ProxyDenied

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `EngineProxyDown` — rule in `ops/alerts/slo.rules.yaml`; `CacheTokenHitLow` — rule in `ops/alerts/slo.rules.yaml`; `ProxyDenied` — rule in `ops/alerts/security.rules.yaml`.

**Built today:** `services/engine-proxy`: `/healthz`, `/readyz` (gate open) and `/metrics` on `EP_METRICS_ADDR` (`:9464`), `engine-proxy healthcheck`; metrics `scf_engine_proxy_bootstrap_gate_open`, `…_bootstrap_probe_errors_total`, `…_bootstrap_probe_last_status`, `…_bootstrap_probe_provisioner_last_status`, `…_denials_total` (by node, role, reason: `deny_list`, `not_allowed`, `bad_query`, `bad_path`, `gate_closed`, `bad_certificate`), `…_upstream_errors_total`, `…_send_rejected_total`, `…_visit_lookup_hits_total` / `…_visit_lookup_misses_total`, `…_visit_replays_refused_total`, `…_visit_evictions_total`, `…_visit_tokens`.

## EngineProxyDown (TM-DOS-04.M.7)

**Meaning.** The engine proxy on a core is not ready, or forwarders fail over away from it (C-74). Visits routed to that core split once. Critical if both cores.

**First checks**

- `docker compose -f infra/compose/compose.yaml ps engine-proxy umami`; `/readyz` false means the bootstrap gate is closed: see `infra/compose/README.md` "Recovery" — `scf_engine_proxy_bootstrap_probe_errors_total` (Umami unreachable) and `scf_engine_proxy_bootstrap_probe_provisioner_last_status` (`401`: provisioning password mismatch, `-1`: no provisioning credentials).
- `umami-bootstrap` exit status and log.
- Certificate or CA expired (`certificate-renewal.md`).

**Mitigation**

- Restart: `docker compose -f infra/compose/compose.yaml restart engine-proxy` (the visit memory is lost, so visits in progress split once; the gate re-opens by its own probe).
- Re-run the bootstrap if needed: `docker compose -f infra/compose/compose.yaml up umami-bootstrap` (idempotent; resumes from the first incomplete step).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. Critical if both cores: page views stop reaching Umami (they wait in the spools).

## CacheTokenHitLow (TM-DOS-04.M.8)

**Meaning.** The share of forwarded events that carried a cache token fell > 20 points below its 7-day median for 1 h: more visits are split (bounce rate up, durations down).

**First checks**

- Recent engine-proxy restarts (memory is lost), evictions `scf_engine_proxy_visit_evictions_total` (500,000-entry cap, `EP_MAX_ENTRIES`), routing changes at the forwarders (core choice by consistent hash, C-74).
- Refused replays `scf_engine_proxy_visit_replays_refused_total` are expected for gaps over 30 minutes and backlog events (C-99, C-113); they are excluded from the ratio.

**Mitigation**

- Raise `EP_MAX_ENTRIES` if evictions explain it; otherwise annotate the affected day (visit metrics of that day are less accurate).

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day.

## ProxyDenied (TM-EDG-08.M.3)

**Meaning.** The engine proxy refused a caller: unknown or revoked certificate, or a path or parameter not allowed for that caller's role (C-60). A legitimate caller is misconfigured, or something is probing the internal network.

**First checks**

- `scf_engine_proxy_denials_total` by node, role and reason; the proxy log shows node, role, route template and reason (never the path with ids).
- Was anything deployed that calls Umami in a new way (adapter change, Umami upgrade)? New Umami routes are refused by default (`umami-upgrade.md`).

**Mitigation**

- Misconfiguration: fix the caller, never widen the allow-list without a contract change (`docs/contracts/wire-formats.md` §c.5).
- Unknown caller or `deny_list` hits: treat as a security event — revoke the node certificate (CRL via `EP_CLIENT_CRL`, then `SIGHUP`), see `key-and-cert-rotation.md`.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory or private ops issue) with the start time.

## Related

- `services/engine-proxy/README.md`, C-60, C-74, C-99, C-112(7), C-113, C-114.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
