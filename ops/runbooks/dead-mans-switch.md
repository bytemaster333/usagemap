# Runbook: dead man's switch

Status: to be exercised (no drill has run)
Owner: maintainers
Last reviewed: 2026-11-18
Alerts: Watchdog, DeadMansSwitchMissed

Source: `docs/monitoring-plan.md` §4.4. The monitoring stack is built: Prometheus, Alertmanager, Grafana, VictoriaLogs and the platform's probes (`infra/compose/compose.monitoring.yaml`; lean production profile `infra/ansible/roles/compose_stack`), checked end to end by `ops/e2e/run.sh`; rules are promtool-tested (`ops/alerts/test.sh`) and each alert's status is in `ops/alerts/coverage.json`. `Watchdog` — rule in `ops/alerts/platform.rules.yaml`; `DeadMansSwitchMissed` — not a Prometheus alert (see `ops/alerts/coverage.json`).

**Built today:** the `Watchdog` rule (`ops/alerts/platform.rules.yaml`), Alertmanager posting it to the status host's heartbeat receiver (`ops/alertmanager/alertmanager.yml`, status service in `infra/compose/compose.monitoring.yaml`), and the outside check `ops/deadman/check.sh`, run every 5 minutes by `.github/workflows/deadman.yml` on GitHub-hosted runners once the repository variable `SCF_STATUS_URL` names the production status host (until then the job is skipped). `ops/e2e/run.sh` runs the same script against the local stack, including the stale-heartbeat failure.

**Without the GitHub-hosted check, the path that works today:** an **outside heartbeat monitor** on infrastructure
other than the platform VM (for example a self-hosted Healthchecks instance, BSD-3-Clause, or any "ping URL" monitor
the operating team chooses, listed as a sub-processor) receives the `Watchdog` directly from Alertmanager and alarms
the maintainers when pings stop for 15 minutes. Set it up once:

1. Create a check with a 5-minute period and 10-minute grace on the outside monitor; route its alarm to the
   maintainers' push channel.
2. Put its ping URL into SOPS: `scf_stack_secrets.deadman_ping_url: "https://…"` (it carries a token).
3. Set `scf_alert_deadman_required: true` in `group_vars/lean.yml` and re-run the playbook: the lean role adds the URL
   to Alertmanager's `heartbeat` receiver (`url_file`), and from then on refuses to deploy without it.
4. Test: stop Alertmanager on the VM (`$DC stop alertmanager`) and confirm the outside alarm within 15 minutes; start it
   again. Record the result in the drill log.

Until step 1 is done the lean profile has **no working dead-man's switch** — the status host's heartbeat sits on the
same VM as Alertmanager, and its reader (`deadman.yml`) cannot run.

## Watchdog (—)

**Meaning.** Always-firing heartbeat from Alertmanager on `mon-c`, published every 5 m for the dead-man's-switch workflow. It is not an incident.

**First checks**

- None while it fires; its absence is the next alert.

**Mitigation**

- Never silence it.

**Escalation**

- None (heartbeat).

## DeadMansSwitchMissed (—)

**Meaning.** The `deadman.yml` workflow found no heartbeat newer than 15 m (plus GitHub scheduling delay), or no restore-drill result newer than 8 days: monitoring itself is down or partitioned.

**First checks**

- Is `mon-c` reachable; is Alertmanager running; is the heartbeat target reachable from it; does `probe-d` still probe `mon-c`?

**Mitigation**

- Restore monitoring first — while it is down nothing else alerts. Missing drill result: see [`restore-drill.md`](restore-drill.md).

**Escalation**

- Critical: maintainers' push channel; the person on daily watch (C-49) picks it up at the latest at their daily check.

## Related

- C-30, `docs/monitoring-plan.md` §4.9.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: record the first exercise of this runbook in `ops/runbooks/README.md` (docs.operator-runbooks).
