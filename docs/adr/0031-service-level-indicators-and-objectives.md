# ADR-0031: Service-level indicators and objectives

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** slo.ingest-availability, slo.dashboard-availability, security.patch-24h, support.first-response, support.resolution, support.public-issue-tracker, slo.concrete-commitments, ops.hosted-service-window, ops.monitoring-alerting

## Context
UsageMap's operational targets are ingestion availability 99.99 %, dashboard availability 99.90 %, critical/high
vulnerabilities patched within 24 hours, support response within 5 and resolution within 10 business days, with no
mandatory on-call rotation (slo.concrete-commitments). No outside party enforces these targets, and a project that
quotes its own logs gives readers no way to check them. A percentage without a definition and independent
measurement is therefore worth little.

The arithmetic (month = 30.44 days = 43,830 min):

| Target | Allowed downtime per 30-day month | per average month | per year |
|---|---|---|---|
| 99.99 % | 4.32 min | **4.38 min** | **52.6 min** |
| 99.9 % | 43.2 min | **43.8 min** | **8.77 h** |

Consequences of that arithmetic: no deploy, reboot or migration may cause visible ingest downtime; a human paged at
03:00 needs 15–30 minutes, i.e. 3–7 months of ingest budget, so ingest failover must be automatic; with 60 s probes
the whole month is about four bad probe-minutes and one flaky probe location could spend a quarter of it, hence a
quorum. Provider SLAs do not help: Hetzner Cloud promises 99.9 % per server as "commercially reasonable efforts" with
credit-only remedies; single locations failed for 10–16 h in 2026 (leaf-switch faults).
Upptime's ≥ 5-minute GitHub-cron checks cannot evidence 99.99 %. Default OTLP temporality is cumulative, so a missed export loses resolution, not counts (OTel spec
`sdk_exporters/otlp.md` L18).

## Options considered
1. **Quote the targets without definitions.** Pros: no effort. Cons: unverifiable; nobody can check them.
2. **Time-based uptime from an external monitor only.** Pros: independent. Cons: cannot see partial failure (one
   node of three failing a third of requests); 5-minute free tiers cannot measure 99.99 %.
3. **Request-based SLI from server logs only.** Pros: precise, covers all traffic. Cons: blind to requests that never
   arrive (DNS failure, all nodes down, partition); self-measured.
4. **Both views, defined as formulas, with quorum probes, published raw data and an error-budget policy (chosen).**
   Pros: each view covers the other's blind spot; anyone can recompute. Cons: more machinery; two numbers can
   disagree and must be explained.
5. **Exclude planned maintenance.** Pros: easier to meet. Cons: common practice, but at 4.38 min/month it would hide
   most real risk. Rejected for ingest.

## Decision
**Objectives, not guarantees (C-78).** 99.99 % (ingest) and 99.9 % (dashboard) are **objectives** that we measure and
report against, with the error-budget policy below and monthly attainment published with raw data. We do not call
them guarantees, and there are no credits.

**SLO-1 Ingest availability — objective 99.99 % per calendar month, no maintenance exclusion.**
Two views, both published (C-43); the probe-based one is the headline figure.

*Server-side view:* `A_ingest = accepted ÷ valid`, counted at the edge over all gateway nodes, web and OTLP together,
where
- *valid* = a request to a published ingest path (web collect/challenge, OTLP/HTTP `/v1/metrics` and `/v1/traces`,
  OTLP/gRPC) that is well-formed for its protocol and carries an active site key or ingest token;
- *accepted* = a valid request answered **2xx within 2 s, after durable persistence**: for web, after the record is
  fsync'd to the node's spool (ADR-0020); for OTLP, after the Collector's persistent queue (`file_storage`,
  `fsync: true`) has stored it. The code path cannot emit 2xx before persistence returns.

It is computed from the gateway's per-request counters (not from logs containing client data; ADR-0022).

*Probe view — the headline figure, one definition (C-78):*
- Probes run in **30-second rounds** from three sources (C-30): `mon-c` (OVHcloud), `probe-d` (a small VPS at a
  fourth EU provider, probes only) and the cross-provider probes that edge nodes run against the other provider's
  nodes. Each round sends a real, signed canary event for a canary site (and a small OTLP export), with fresh DNS
  resolution, using a protocol-level probe client that solves the challenge like the tracker.
- **A round is good when at least one of the two ingest hostnames accepts the canary within 2 seconds, with one
  retry** — the behaviour of the pinned tracker. A round counts as bad only when **≥ 2 of the 3 sources** record it
  as bad; a single-source failure is logged and published but does not count.
- `A_probe = good rounds ÷ rounds in the month`.
- **Published next to it: availability per ingest hostname and per edge node**, from the same probes, so a
  black-holed node or a lost domain is visible even while the other hostname keeps the headline figure up; alerts
  fire on these per-hostname and per-node figures as well (C-78, ADR-0022).
- Differences between the probe and server-side figures are explained in the report.
- GitHub-hosted scheduled checks feed the public status page as an additional outside view (5-minute resolution);
  they do not vote and are not used for the SLI (C-30).

**SLO-2 Durability — no accepted event is lost unless it could not be delivered for more than 72 hours** (C-18),
with one stated exception: an event accepted by an edge node that is permanently lost (disk destroyed) before it
forwards is lost, because there are no spool copies in object storage (C-77). The exposure is that node's undrained
backlog — normally seconds — and is stated in the SLA.

**How durability is measured (C-76).** Each spooled record has a node ID, segment and offset. On every edge node,
spool accounting must balance: *records fsync'd = records acknowledged + records expired under the 72-hour rule +
records still queued*. A daily job reconciles this per node and publishes it. Because Umami rows carry no spool
position, the in-store check is end to end: **canary events of a known hourly count** are sent to a canary site and
counted in Umami. Events Umami drops silently as bots are counted as `engine_bot_drop` and count as delivered (C-69);
ambiguous retries are counted (ADR-0020). The figure therefore states what the forwarder handed over and what the
canaries prove reached storage — not a row-by-row match. The 72-hour cap is deliberate: an event or metric batch that
cannot be delivered for 72 hours is discarded and **counted**, and the count is published in the monthly report. The Collector queue has the same cap; the writer's de-duplication ledger keeps 7 days. Spool-age
alerts fire at 1 h, 6 h and 24 h (C-49).

**SLO-3 Freshness — 99 % of accepted events visible within 5 minutes and 99.9 % within 60 minutes**, per calendar
month (C-28, C-43), measured by synthetic canary events timed from send to visibility through the public read API.

**SLO-4 Dashboard availability — objective 99.9 % per calendar month, no maintenance exclusion** (C-43, C-78).
`A_dash = successful synthetic journeys ÷ attempts`.
A journey, every 60 seconds from each of the three probe sources (C-93), signs in as a dedicated synthetic tenant (never a real user), loads the web
overview, one API view and one SCF operator view, and checks for non-empty, correct-tenant data within a time limit. The
same 2-of-3 quorum decides whether a 5-minute window counts as failed. When the primary database is unavailable the
portal serves read-only from the replica (ADR-0020); journeys pass if read paths work.

**Exclusions (published list, with counts in each report):** requests rejected for client-side reasons — malformed
payloads, unknown or removed sites, invalid or revoked tokens, oversize, `429`s caused by a site's own quota or rate limit (reported per site, C-80;
quotas count verified events only, so another party's flood of `suspect` events cannot use up a site's quota —
C-80, C-90), requests for a
withdrawn tracker version (`410`, C-37); events assigned the `rejected` verdict, which are outside the denominator
(C-39) even though the gateway answers `202` to every well-formed event whatever its verdict, so that the response is
no oracle; our own load and chaos tests. **Not excluded:** our 5xx, global-overload 429/503,
timeouts, TLS and DNS failures, deploys and maintenance.

**What we explicitly do not promise:** availability for clients whose own network or DNS fails; events from browsers
or networks that block our hostnames; simultaneous loss of both EU compute providers or both DNS providers; events
lost when a node's disk is destroyed before its spool drains — normally seconds, longer while the cores are
unreachable; there is no object-storage copy (C-77; counted and reported);
tenant OTLP exports dropped beyond their SDK's retry window (Python ≈ seconds, JS/Java ≈ 10–15 s, Go ≈ 1 min,
Collector ≈ 5 min by default; onboarding shows how to extend it); on-chain correlation freshness (ADR-0028); financial
credits; human response times to alerts outside the daily watch below (alerts go to the channels the operating
team chooses, best effort, no on-call — ADR-0022, C-26).

**Daily watch duty and patch responders (C-49, C-67).** "No on-call" stands, but two commitments need a human once
per calendar day, weekends and holidays included: the 24-hour patch commitment and the 72-hour delivery cap. One
**named person per day** checks the advisory feed and the alert channel; this is a roster, not paging. The 24-hour
patch clock starts when an advisory affecting a component we run appears in a watched source or is reported to us;
the pipeline opens the patch change automatically and sends a push notification to **two named responders**.
"Patched or mitigated within 24 hours" therefore depends on one of them acting on it. The service operator's team has to
accept the roster and name the people; until then the commitment is conditional on it.

**Error-budget policy.** Budgets: ingest 4.38 min, dashboard 43.8 min per month. Multi-window burn-rate alerts
generated with Sloth: 14.4× over 1 h/5 min and 6× over 6 h/30 min notify immediately; 1× over 3 d/6 h opens an issue.
Budget exhausted, or more than half spent in one incident: feature deploys to the affected path stop until a public
post-mortem is published and its corrective action merged; only security fixes, rolled out with zero downtime, are
exempt. Every SLO miss gets a public post-mortem within 5 business days.

**Reporting.** A monthly report generated on the 1st into `docs/evidence/slo/YYYY-MM.md` with every SLI, budget used,
incidents, exclusions with counts, support statistics and the **raw per-probe results (CSV) for every probe source**,
signed so later edits are detectable. The public status page (Upptime, ADR-0022) is a coarse cross-check, labelled
as such.

**Support and security.** First response ≤ 5 business days and resolution ≤ 10 business days on the public issue
tracker, tracked by issue automation that labels at day 4/8 and breaches at 5/10 (business-day calendar published;
"needs info" pauses the clock). Critical and high vulnerabilities patched or mitigated within 24 h of the clock
starting (C-67), with compensating controls when upstream has no fix (ADR-0023). A released tracker version is
withdrawn only for a security defect: its URL then returns `410 Gone` (pages that pin it stop sending analytics and
are otherwise unaffected) and an advisory is published (C-37).

## Consequences
Positive: every number is a formula anyone can recompute from published raw data; the per-hostname and per-node
figures expose failures that the any-hostname headline rule hides (C-78); the 99.99 % objective rests on
architecture (four edge nodes on two providers, so losing a whole provider still leaves two; spool before 2xx;
multi-A DNS on two providers; tracker retry and endpoint rotation; C-25) rather than on people. The patch commitment
and the 72-hour durability bound do **not** rest on architecture alone: they rest on the named people of the daily
watch and the two patch responders (C-49, C-67).

Negative: the headline probe figure counts a round as good when either hostname works, so real visitors whose first
attempt hits a dead node wait for the retry; only the per-node figure shows it. With no on-call, two small providers
and a 4.38-minute monthly budget, any ingest incident that needs a human spends the month's budget, which is why
99.99 % is an objective with published attainment, not a promise (C-78). Durability is measured from spool
accounting and canaries, not by matching every stored row (C-76). Zero-downtime operations become mandatory (rolling deploys one node at a time with soak, DNS drain first);
probes and journeys cost money and maintenance; a disagreement between server-side and probe figures must be
investigated and published; the 24 h patch commitment depends on upstream fixes for Umami (own-bug patch latency
22–84 days historically), so "mitigated" will sometimes mean compensating controls only.

Revisit if: real history shows the targets are not met with this topology (then the published figure is lowered, not
the definition); an SCF operator supplies its own poller (ADR-0032 `health_endpoint`, public per C-14), which would become the
preferred third-party view.

Unproven: there is no uptime history yet — meaningful evidence needs weeks of production; persistent-queue fsync
behaviour (**S-04**) and the durability reconciliation (C-76) are untested; failover times (30–60 s) in ADR-0021 are
targets to be measured before they are quoted.

## Open points
1. Open: **Daily watch roster and patch responders.** The 24-hour patch commitment and the SLO-2 72-hour bound depend
   on a daily roster and two named responders (C-49, C-67). Closed when the service operator's team accepts the
   roster and names the people (and the release approvers and the alert channel).

(The ingest probe cadence and quorum unit are settled by C-78, the dashboard journey cadence by C-93, and how
durability is measured by C-76.)
