# ADR-0022: Observability

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** ops.monitoring-alerting, slo.ingest-availability, slo.dashboard-availability, support.public-issue-tracker

## Context
UsageMap ships a monitoring and alerting baseline (ops.monitoring-alerting) and a written monitoring plan. No outside
party enforces our service levels, so our availability claims are only as credible as our measurement. There is no on-call (support.public-issue-tracker): alerts notify volunteers, best effort, but one named person looks once per calendar
day (C-49).

**Why 5-minute checks cannot evidence 99.99 %.** The monthly ingest budget is 4.38 minutes
. A check every 5 minutes cannot see an outage shorter than its interval, and a
single failed check already stands for 5 minutes — more than the whole month's budget. Even at 60 s, one false
positive from a flaky probe location costs about 25 % of the budget (§3.1). Upptime, the obvious free status page,
runs on GitHub's scheduled workflows with a 5-minute minimum; scheduled runs can be delayed under load (a 2026-01-20 GitHub
incident delayed ~23 % of runs by 11 minutes on average) and are disabled after 60 days without repository
activity. It is fine as an independent public history, not as the SLI.

Tooling facts (versions and licences read 2026-11-12
§3.6–3.7): Prometheus 3.16.0 and Alertmanager 0.35.0 (Apache-2.0); Grafana OSS 13.3.1 (**AGPL-3.0**, OSI; used
unmodified, for the service operator's team only); VictoriaLogs v1.53.0 (Apache-2.0, single binary, ingests directly from
`systemd-journal-upload`); Gatus v5.38.0 (Apache-2.0); Sloth v0.16.0 (Apache-2.0); Upptime / uptime-monitor
v1.46.5 (MIT); healthchecks v5.0.3 (BSD-3). **Promtail is EOL since 2026-03-02** and Loki 4.0 is in RC, so a Loki
stack now needs Alloy agents on every host; **Grafana OnCall OSS was archived on 2026-03-24**. Volumes are small:
~20 k active series, a few hundred MB of logs per day.

## Options considered
1. **Prometheus + Alertmanager + Grafana + VictoriaLogs on a monitoring node at a third provider (chosen).** Pros:
   fewest moving parts, no log agent (journald ships natively), Prometheus is the most widely known tool for
   handover. Cons: one more node; Grafana is AGPL (acceptable unmodified, counsel to confirm).
2. **Same with Loki 3.x + Alloy.** Pros: the standard "PLG" stack. Cons: an agent on every host and a major Loki
   upgrade within the first year of operation. Runner-up.
3. **VictoriaMetrics single-node + vmalert.** Pros: lighter. Cons: smaller community; downsampling, retention
   filters and backup manager are Enterprise-only.
4. **All-in-one (SigNoz, OpenObserve) or Netdata.** Cons: heavier stores, open-core `ee/` directories; Netdata's UI
   is under a proprietary licence (NCUL1) and is excluded.
5. **Hosted monitoring or Upptime as the SLI source.** Cons: hosted services are not inheritable from the repo;
   Upptime's 5-minute cron cannot measure the target (above).

## Decision
- **Placement.** Prometheus (monitoring metrics kept **13 months**, C-71), Alertmanager, Grafana, VictoriaLogs
  (operational logs kept **30 days**, C-71), Pushgateway and Gatus run on **`mon-c` (OVHcloud)**, outside the
  failure domain they watch, reaching production over the WireGuard mesh. (Earlier drafts said 90 and 14 days; C-71
  replaces them.)
- **`mon-c` is a high-impact host (C-79).** It holds the health controller's DNS write credential, an etcd member of
  Patroni's DCS and mesh access to every node, so its compromise is rated **High impact** in the threat model. It
  accepts no inbound traffic except the mesh and the status endpoints, is hardened like a core node, and its own
  logins and configuration changes are alerted on. It holds no OpenTofu state credentials and no deploy credentials
  (C-79, ADR-0019). `probe-d`, a small VPS at a fourth EU provider, runs probes only (ADR-0018, C-25). Dashboards,
  alert rules and probe definitions are provisioned from `ops/` in the monorepo.
- **What is scraped and alerted** (baseline in `docs/monitoring-plan.md`): host health, certificate expiry with
  < 1/3 lifetime left, gateway spool depth and oldest-record age (alerts at **1 h, 6 h and 24 h**, C-49), spool
  records discarded at the 72-hour cap (C-18), forward failures, Collector refusals and queue fill, writer lag,
  rollup job age, PostgreSQL replication lag and archive failures, Patroni leader state, etcd members, pgBackRest
  backup age, restore-drill age, health-controller actions, snapshot age on each edge (alert when no fresh
  snapshot for 15 minutes, C-62), divergence of the shared edge keys between gateway nodes (C-04, C-68), the spool
  accounting that durability is computed from (records fsync'd, acknowledged, expired, queued per node — C-76), and
  per-site `429` answers caused by rate limits or quotas (C-80, C-90).
- **Probe sources (C-30).** The availability indicator is computed from **three probe sources**: `mon-c`
  (OVHcloud), `probe-d` (fourth provider), and the cross-provider probes that edge nodes run against the other
  provider's edges. Probes send real, signed synthetic events for a **canary site** and a small OTLP export, resolving
  DNS freshly (C-43). GitHub-hosted scheduled checks feed the public status page as an additional outside view
  (5-minute resolution) and are **not** used for the indicator.
- **One availability definition (C-78).** Probes run in **30-second rounds**. A round is **good** when at least one of
  the two ingest hostnames accepts the canary event within **2 seconds, with one retry** — the behaviour of the
  pinned tracker. A round counts as bad only if **at least 2 of the 3 sources** record it as bad; a failure seen by
  one source only is logged and published but does not count. The monthly figure is good rounds ÷ rounds. **Published
  next to it: availability per ingest hostname and per edge node**, so a dead node or a lost domain is visible even
  while the other hostname keeps the headline figure up; alerts fire on these too. **The headline availability
  figure is the probe-based one**; the server-side ratio is published next to it and differences are explained
  (C-43, ADR-0031). 99.99 % (ingest) and 99.9 % (dashboard) are **objectives** we measure and report against with an
  error-budget policy, not guarantees (C-78).
- **Dead-man's switch (C-30).** A scheduled GitHub workflow alarms when the monitoring heartbeat (Alertmanager's
  always-firing `Watchdog`) stops. Restore-drill success older than 8 days alerts through the normal rules
  (ADR-0021).
- **Burn-rate alerts** generated with **Sloth** (generated rules committed):
  14.4× over 1 h / 5 m and 6× over 6 h / 30 m notify immediately; 1× over 3 d / 6 h opens an issue.
- **Routing:** critical → e-mail plus a chat/push channel, repeated every 4 h; warning → e-mail digest and an issue
  in a private ops repository (public issues would leak infrastructure details); every alert carries a
  `runbook_url`, enforced by a lint test (`ops/internal/alertlint`). Channels are chosen by the service operator's team, recorded in the
  sub-processor list and never carry visitor data (C-26). No on-call rotation: a **daily watch duty** — one named
  person per calendar day, weekends included, checks the alert channel and the advisory feed — is a roster, not
  paging (C-49). Response targets per severity are stated in `docs/sla.md`.
- **Public status page:** generated by **Upptime** in a separate `status` repository (generated output only,
  deviation DV-06); configuration lives in `ops/status/` in the monorepo. It shows the GitHub-hosted 5-minute checks
  as an outside view and states that the SLI is measured at 30 s by our three probe sources and reported monthly.
- **Monthly SLO report** generated on the 1st into `docs/evidence/slo/YYYY-MM.md` by a PR, with raw per-probe
  results (CSV) for every probe source so anyone can recompute it.
- **Logs never contain** client IPs, User-Agents, request headers, query strings or tokens. Shipping is
  `systemd-journal-upload` → VictoriaLogs bound to the WireGuard interface; a test greps end-to-end log output
  for IP/UA/token patterns and fails on a match.

## Consequences
Positive: 30-second rounds with quorum can resolve a 4-minute budget; one flaky vantage point cannot burn it; the
per-hostname and per-node figures expose failures that the any-hostname rule would hide (C-78); raw data is public; the monitoring stack is rebuildable from the repo and survives loss of either production provider;
alerting itself is watched.

Negative: `mon-c` is a single node (its loss costs metrics history and one probe source, ADR-0020; the quorum then
needs both remaining sources), and a compromised `mon-c` could redirect ingest or portal DNS records, force Patroni
failovers through etcd, or falsify SLO data (C-79); the headline indicator counts a round as good when either
hostname works, so real visitors whose first attempt hits a dead node wait for their retry — the per-node figure is
where that shows; the edge cross-provider probes run on production nodes, so one of the three sources
is not independent of what it measures, and research asked for at least one source we do not operate — the
GitHub-hosted checks are that outside view, but only on the status page, not in the SLI; the status page and the
dead-man's switch depend on GitHub's scheduled workflows and Pages;
 alert content passes through a mail relay and a
chat service, so it must never carry personal data.

Revisit if: probe disputes arise (add third-party probes); Loki or VictoriaLogs licensing changes; GitHub cron
delays make the Upptime page misleading (runner-up: a Gatus-only public page on an isolated VM).

Unproven: how the scheduled GitHub workflow reads the monitoring heartbeat; Alertmanager → ntfy/push webhook templating (a small shim may be needed); `systemd-journal-upload` →
VictoriaLogs on Debian 13's systemd version, bound to the WireGuard address; Sloth spec for our SLIs.

## Open points
1. Open: which alert channel(s) and who is on the daily watch roster — chosen by the service operator's team.
