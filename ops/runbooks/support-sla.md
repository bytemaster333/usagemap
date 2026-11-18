# Runbook: support response due

Status: rule exercised on fixtures 2026-11-14; not yet run against live issues (repository still private) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-18
Alerts: SupportResponseDue

Source: `docs/monitoring-plan.md` §4.4, `docs/sla.md` §9.2–9.3 (K3: first response ≤ 5 business days, K4: resolved
≤ 10), ADR-0031. Alert state (`ops/alerts/coverage.json`): **outside Prometheus** — raised by the issue automation.

## Built today

- `tools/support/sla.ts`, applied when a maintainer runs `tools/support/run sla --apply` (with `GITHUB_TOKEN` and
  `GITHUB_REPOSITORY`); labels are only as fresh as the last run. Business time is
  Monday–Friday in `SCF_SUPPORT_TZ` (default UTC) minus the dates in `ops/support/holidays.yaml`.
- Labels: `sla:awaiting-first-response` until a maintainer (OWNER / MEMBER / COLLABORATOR, not a bot, not the author)
  comments; a warning comment at **4** business days; `sla:response-breach` at 5 (never removed); a warning at **8**
  business days open; `sla:resolution-breach` at 10 (never removed). `status:needs-info` pauses the clock until the
  reporter replies or the label is removed. `sla:exempt` excludes an issue (visible, reviewable).
- The rule's self-test on 16 fixture timelines is part of `tools/support/run selftest`.

## Intake: issue forms and labels (built 2026-11-18)

- `.github/ISSUE_TEMPLATE/`: forms for tenant support, bug, enrolment, project removal, privacy-process question and
  feature request (docs/sla.md §9.1); blank issues are disabled; security reports go to GitHub private vulnerability
  reporting and data-subject requests to the privacy mailbox (contact links), never to a public form. Every form
  requires the reporter to confirm that no personal data, keys or tokens are included. `ORG/REPO` in `config.yml`
  is replaced when the public repository exists.
- Labels: `tools/support/labels.json` (type, priority, `tenant`, `security`, `privacy`, the `sla:*` and
  `status:needs-info` labels the automation uses). `tools/support/run labels --check` (offline, in the self-test)
  keeps forms, label set and automation in step; `GITHUB_TOKEN=… GITHUB_REPOSITORY=ORG/REPO tools/support/run labels
  --plan` then `--apply` creates or fixes labels on the repository (never deletes).

## Monthly reports (1st business day of the month, docs/sla.md §7)

```sh
# support (K3/K4): tickets opened last month, first response < 5 bd, resolution < 10 bd, breaches, carried-over
GITHUB_TOKEN=… GITHUB_REPOSITORY=ORG/REPO tools/support/run support-report --month=2026-11 --github --out=docs/evidence/support
# SLO verdict with the 95 % coverage floor, from the month's verdicts.csv of `scf-ops slo-report`
tools/support/run slo-report --month=2026-11 --verdicts=docs/evidence/slo/2026-11/verdicts.csv --profile=lean --out=docs/evidence/slo
```

- The support report uses the automation's own clock (imported from `tools/support/sla.ts`); a ticket the
  automation labelled `sla:response-breach` / `sla:resolution-breach` is a breach in the report too, so the report is
  never kinder than the labels. Ages are measured at `--at` (default: now), which the report prints. It names issue
  numbers only, never authors or titles.
- The SLO verdict judges a figure only when **at least 95 %** of the month's slots were measured (a `good` or `bad`
  verdict; `unknown` rounds and missing slots are not measured). Below that the month is **not measured**, never
  "met". It refuses a `verdicts.csv` whose hash differs from the generator's `SHA256SUMS`.
- Both go into the monthly report PR; a missed target or an unmeasured month gets an explanation (and a
  post-mortem when an objective was missed).

## SupportResponseDue (—)

**Meaning.** A support ticket reached 4 business days without a maintainer response (the warning comment); the first
response is due within 5.

**First checks**

```sh
gh issue list --label sla:awaiting-first-response --state open        # every ticket still waiting
GITHUB_TOKEN=… GITHUB_REPOSITORY=<org>/<repo> tools/support/run sla --plan   # ages and pending label changes, read-only
```

- Is it a security report? Then it must not be discussed in public: move it to a private advisory
  (`security-patch-24h.md`, `SECURITY.md`) and answer there.
- When did a maintainer last run `tools/support/run sla --apply`? Labels are stale between runs.

**Mitigation**

- Respond (any substantive maintainer comment is the first response), label (`status:needs-info` when waiting for
  the reporter) and assign; resolution target is 10 business days (`docs/sla.md` §9.2).
- Never remove `sla:response-breach` / `sla:resolution-breach` by hand: breaches are reported in the monthly support
  table. `sla:exempt` only for maintainers' own tracking issues, never to hide a late ticket.
- Labels stale: run `tools/support/run sla --apply` once.

**Escalation**

- Warning: e-mail digest and an issue in the private ops repository; handle within the next working day. A breach
  counts against K3/K4 in the monthly report.

## Related

- ADR-0031, `docs/sla.md` §9, C-118, `ops/support/holidays.yaml`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-18 | workstation, tree with uncommitted changes | `tools/support/run selftest`: monthly support report on 11 recorded ticket timelines (weekend, holiday, needs-info pause, bot comment, label wins, carried over, exempt), SLO verdict on generated months and on a raw probe store run through the real `scf-ops slo-report` (full month met; 2-day prober gap → not measured), forms/labels check | **pass** — 37 tests, labels/forms ok. Not exercised: `--github` against real issues (repository private, repo.single-monorepo). |
| 2026-11-14 | workstation, repository working tree | `tools/support/run sla --fixtures=tools/support/fixtures/sla` — the rule on 16 recorded timelines (awaiting, day-4 warning, day-5 breach, bot/author not a response, needs-info pause, holiday, time zone, exempt, warning once, breach never removed) | **pass** — 16 fixtures, 0 failing. Not exercised: `--plan`/`--apply` against real issues (needs the public repository, repo.single-monorepo). |
