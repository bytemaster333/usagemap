# ADR-0026: Test strategy

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** test.automated-suite, isolation.tenant-rls, isolation.web-dashboard, isolation.api-metrics, isolation.api-dashboard, web.frontend-origin-only, bot.anti-inflation-strategy, bot.js-execution-proof, bot.ip-multiplicity, bot.engine-bot-detection, tracker.static-html, tracker.spa, tracker.ssr-frameworks, tracker.version-pinned, tracker.no-remote-updates, tracker.intentional-upgrade, security.supply-chain, metric.pageviews, metric.unique-visitors, metric.referrers, metric.session-duration, metric.bounce-rate, metric.country, metric.device, metric.browser, dashboard.web-tenant, dashboard.web-pageviews, dashboard.web-visitors, dashboard.web-referrers, dashboard.web-session-duration, dashboard.web-bounce-rate, dashboard.web-country, dashboard.web-device-browser, dashboard.time-ranges,
  api.dual-export, api.drop-traces, api.drop-logs, api.attribute-allowlist, api.postgres-metrics, api.attr-tenant-service, api.attr-route, api.attr-status-code, api.attr-latency, pathnorm.default-ruleset, pathnorm.numeric-ids, pathnorm.stellar-strkeys, pathnorm.uuids, pathnorm.hex-hashes, pathnorm.trailing-slashes, pathnorm.other-patterns, pathnorm.tenant-http-route, capacity.1m-requests-day, dashboard.api-tenant, dashboard.api-volume, dashboard.api-status-codes, dashboard.api-latency-percentiles, dashboard.api-time-ranges, slo.ingest-availability, slo.dashboard-availability, handover.data-migration, ops.rebuild-from-repo, feature.custom-events, feature.wallets-kit-autocapture, privacy.tenant-erasure, privacy.erasure-workflow

## Context
UsageMap needs an automated test suite that demonstrates technical soundness and the quality of multi-tenant
isolation to anyone who reads the repository. Test results therefore have to be produced as readable artefacts,
not just a green badge.

Research also showed which claims rest on unexecuted work: the
Umami surrogate-IP/`tag` behaviour (S-01), the Collector build and fsync (S-04), histogram SQL (S-05), RLS on a real
PostgreSQL 18 (S-03; the RLS behaviour tests ran only on PGlite), every dual-export recipe (S-06), PoW timings on phones (S-07).
Each spike must turn into a permanent test, otherwise the design is not proven.

Specific hazards the tests must catch:
- PostgreSQL partitions do not inherit RLS (RLS behaviour tests 1, 2 and 19); a single stray grant on a partition
  leaks all tenants.
- Umami's `/api/send` trusts client `timestamp`, `id`, `salt`, `hostname` (`src/app/api/send/route.ts` L96–109 at
  v3.5.0): the gateway's rebuild must be proven against the real engine, not a mock.
- A real headless browser passes L0–L5 of ADR-0008; a test that claims otherwise would be false.
- Umami's stats API is an unversioned upstream surface; upgrades break the adapter silently unless tested.

## Options considered
1. **Unit tests plus a mocked engine.** Pros: fast, no Docker. Cons: proves nothing about Umami's real behaviour,
   RLS on real PostgreSQL, or the Collector; the riskiest assumptions stay untested.
2. **Layered suite against real dependencies, with the evidence written by the test runs (chosen).** Pros: every risky
   assumption becomes a repeatable test; output is reviewable evidence. Cons: the runs need Docker and time; e2e and
   chaos tests are slower and can be flaky, so they need quarantine rules.
3. **Manual verification runs before each release.** Pros: cheap to start. Cons: not repeatable, not evidence of
   continuous correctness, does not survive handover.
4. **Property-based and fuzz testing only for the parsers.** Pros: finds edge cases. Cons: covers input handling,
   not isolation, durability or end-to-end metrics; kept as one layer, not the strategy.

## Decision
A layered suite. Every layer writes machine-readable results and a Markdown summary to `docs/evidence/` (path per
layer, e.g. `docs/evidence/isolation/`, `docs/evidence/load/`), committed by the maintainer who ran the suite.

| Layer | What it proves | Where it runs | Evidences |
|---|---|---|---|
| Unit (per package, Go and TS) | Pure logic: verdict rules, surrogate derivation, histogram merge, key format, tracker guards; per-profile field discard at the gateway (C-37); `consent: "required"` sends nothing before `grantConsent()` and stops on `revokeConsent()` (C-55) | PR | test.automated-suite, api.attr-status-code, api.attr-latency, metric.unique-visitors |
| Bot-list parity (C-36) | The gateway's Go matcher, applied to the raw User-Agent, gives the same verdict as Umami's `isbot` function at the version pinned by our Umami release, over a User-Agent corpus; re-run whenever the Umami pin changes | PR | web.frontend-origin-only, bot.anti-inflation-strategy, bot.js-execution-proof, bot.ip-multiplicity, bot.engine-bot-detection |
| Web-path scrubbing (C-52) | The gateway runs `pathnorm` over web page paths before anything is spooled: every StrKey type, hash, UUID and long number becomes its typed placeholder; seeds, tokens, JWTs and e-mail addresses become `{redacted}`, and StrKeys and hashes stay folded, under both folding settings `full` and `relaxed` (`relaxed` keeps only numbers, dates and slugs — C-70, C-89); the `v1` schema has no page-title field and a title sent anyway is rejected as an unknown field (C-89); custom-event names and property values pass the same guard; query strings and fragments are discarded (C-65). Asserted on the spool record and in Umami after an e2e run. | PR | privacy.gdpr-no-consent, privacy.minimal-erasure-scope, api.attr-route |
| Anonymous reports (C-51) | With `anonymous_reports` on (the default), tenant-dashboard breakdown rows below the minimum count (10) are merged into "Other" and displayed counts are rounded to the nearest 10; with it off, exact values appear and the generated notice text no longer refers to the French criteria | PR (API) + nightly (portal e2e) | privacy.gdpr-no-consent, privacy.jurisdictions |
| Integration — PostgreSQL 18 | Writer upserts, cumulative→delta, de-duplication ledger, retention by partition drop, the RLS behaviour tests | PR (real `postgres:18` container) | api.postgres-metrics, retention.aggregates-24m, retention.raw-metrics, tenancy.multi-tenant-model |
| Integration — Umami | Surrogate IP via `CLIENT_IP_HEADER`, `cf-ipcountry`, `tag` filter (`v`/`s`), twin website for events without a visitor identifier (C-73), `isbot` still active and its silent drop counted as `engine_bot_drop` (C-69), direct-SQL retention and erasure (C-69) | PR (pinned Umami image, ADR-0003) | engine.umami-base, bot.engine-bot-detection, metric.country, privacy.tenant-erasure |
| Visit metrics and the engine proxy (C-73, C-74) | A visit that mixes `v` and `s` events counts as one visit and is not a bounce; visits, bounce rate and duration come from one query over all identified, non-rejected events; with **four edge nodes** and hosts rotating, a visitor's events reach the same core by consistent hash and the visit does not split (split rate measured and published, S-01); a core failover splits a visit at most once; a visit with any custom or wallet event is not a bounce (C-75) | PR (two cores, four gateways in Compose) + nightly | metric.pageviews, metric.unique-visitors, metric.session-duration, metric.bounce-rate |
| Contract — Umami adapter | Adapter against the pinned engine; nightly against upstream's newest tag | PR + nightly | engine.umami-base, isolation.tenant-rls |
| Path-normalisation corpus | 451 vectors + fuzz; idempotence; version stamping | PR | api.attr-route, pathnorm.default-ruleset, pathnorm.numeric-ids, pathnorm.stellar-strkeys, pathnorm.uuids, pathnorm.hex-hashes, pathnorm.trailing-slashes, pathnorm.other-patterns, pathnorm.tenant-http-route |
| E2E web (Playwright → gateway → Umami → portal) | Static, SPA, SSR fixtures; all seven metrics; two tracker versions served; unknown version → 404 | PR (smoke) + nightly (full) | tracker.static-html, tracker.spa, tracker.ssr-frameworks, tracker.version-pinned, tracker.no-remote-updates, tracker.intentional-upgrade, security.supply-chain, metric.pageviews, metric.unique-visitors, metric.referrers, metric.session-duration, metric.bounce-rate, metric.country, metric.device, metric.browser, dashboard.web-tenant, dashboard.web-pageviews, dashboard.web-visitors, dashboard.web-referrers, dashboard.web-session-duration, dashboard.web-bounce-rate, dashboard.web-country, dashboard.web-device-browser, dashboard.time-ranges, tracker.version-pinned, tracker.intentional-upgrade, feature.custom-events |
| E2E API (Node, Python, Go, Rust SDK apps) | Dual export lands; spans/logs not persisted; extra attributes dropped; spoofed `tenant.id` overwritten | PR (Node) + nightly (all) | api.dual-export, api.drop-traces, api.drop-logs, api.attribute-allowlist, api.attr-tenant-service, dashboard.api-tenant, dashboard.api-volume, dashboard.api-status-codes, dashboard.api-latency-percentiles, dashboard.api-time-ranges |
| Wallets Kit fixture | Event taxonomy for kit 1.9.5, 2.5.0, 2.7.1, 2.8.0; outbound allow-list of closed-set fields (C-45); **no event is sent on page load** — Tier 0 sends only after a user action, and kit presence reaches only the counter path (C-75); Tier 0 sends nothing under `strict` unless the adapter is attached (C-13) (ADR-0029) | PR | feature.wallets-kit-autocapture |
| Isolation matrix + DB gates | Every endpoint × role × own/foreign/missing/malformed ID **in path, query and body** (C-87), expected outcomes generated from each operation's machine-readable role field (C-89); composite tenant foreign keys reject a foreign row (C-87); erasure and purge jobs act only under the tenant's context; sensitive tenant actions refused with a sign-in older than 10 minutes (C-87); one range convention (`start` inclusive, `end` exclusive, UTC — C-86); `op_*` cross-tenant sums add unrounded values and round once (C-89); RLS/grant/view/function gates | PR | isolation.tenant-rls, isolation.web-dashboard, isolation.api-metrics, isolation.api-dashboard, isolation.tenant-vs-operator |
| Data-inventory tests | No IP, raw UA, query string or StrKey in any table, spool, queue or log after an e2e run | PR | privacy.gdpr-no-consent, privacy.minimal-erasure-scope, api.attribute-allowlist |
| Bot and inflation simulations | Scripted POST → `rejected`/`suspect`; default headless Chrome (`HeadlessChrome` in the User-Agent, on the isbot list) → `rejected` with reason `ua_bot`, its `automation_flag` still counted; `navigator.webdriver` under a normal browser User-Agent → `suspect` with `automation_flag`; multiplicity attack → `suspect`, also on a site with `visitor_id = off`, where L6 counts events per subnet (C-80); challenge token from an unknown key epoch → `suspect` (C-68); known-bot UA → `rejected` at the gateway (Umami only ever sees the reduced UA, C-36); **competitor flood** through a public site key → stored as `suspect`, does not consume the victim's quota (quotas count verified events only), and any `429` is reported per site (C-80, C-90) | Nightly | web.frontend-origin-only, bot.anti-inflation-strategy, bot.js-execution-proof, bot.ip-multiplicity, bot.engine-bot-detection, trust.verified-vs-raw |
| Edge quotas and rate limits (C-90) | Per-node share = limit ÷ live edge nodes; the control plane marks `over_quota` from counter records and the next snapshot enforces it within about a minute | Nightly | enrol.self-service-open, slo.ingest-availability |
| Edge key exchange (C-04, C-68) | The three memory-only keys (`K_day`, multiplicity key, hourly `K_chal` with the previous epoch accepted) converge after node restarts, a mesh partition and clock skew; divergence is counted and alerted. Specified as a separate package with this test plan before the gateway is built | PR (package) + nightly (multi-node) | bot.anti-inflation-strategy, bot.ip-multiplicity |
| Erasure e2e | Preview count, job, audit row, aggregates updated (ADR-0030); after completion plus 56 days (C-111, C-112) the literal selector is replaced by its type and length, and the audit row never holds the literal (C-88) | Nightly | privacy.tenant-erasure, privacy.erasure-workflow |
| Durability reconciliation (C-76) | Per node: records fsync'd = acknowledged + expired under the 72-hour rule + still queued; canary events of a known hourly count arrive in Umami | Nightly + production daily | slo.ingest-availability, slo.dashboard-availability |
| Availability indicator (C-78) | The probe client counts a round as good only if at least one ingest hostname accepts the canary within 2 s with one retry; 2-of-3 quorum; per-hostname and per-node figures computed and alerting when one node or one domain is dead | Nightly + production | slo.ingest-availability, slo.dashboard-availability |
| Deploy credentials (C-79) | No repository workflow or environment holds production credentials (checked against the repository's environments and secrets inventory) | PR | ops.rebuild-from-repo |
| Load (10× design target) | Throughput, latency, cardinality guard under 10M API requests/day and 10M web page views/day equivalent (design assumptions: 1M API requests/day, 1M page views/day across tenants; C-48) | Pre-release + monthly | capacity.1m-requests-day, slo.ingest-availability |
| Chaos | Kill the database, the engine, one core node with its engine proxy, one edge node, the Collector, the writer, the control plane; partition the private mesh (C-48); stop one writer to exercise the Collector's failover to the other core (C-77): ingest keeps answering 2xx, spools and queues drain, no accepted event is lost unless it could not be delivered for more than 72 hours (C-18) | Pre-release + monthly | slo.ingest-availability, slo.dashboard-availability, support.public-issue-tracker |
| Restore drill | pgBackRest restore into scratch instance + integrity checks (ADR-0021); runs on our own EU infrastructure, never on GitHub-hosted runners; backup keys never leave it; only pass/fail, timings and checksums are published (C-56) | Weekly, production | handover.data-migration, ops.rebuild-from-repo |
| Rebuild from IaC | Clean environment from the repo alone, timed (ADR-0019) | Before each major release; mandatory before a handover | ops.rebuild-from-repo, infra.iac-complete, repo.monorepo-complete, repo.single-monorepo |
| Production canaries | Canary tenants (ADR-0013), synthetic journeys and probes (ADR-0031) | Production, continuous | slo.ingest-availability, slo.dashboard-availability, isolation.tenant-rls |

**Gates before a merge** (run by the maintainer; a change is not merged unless all pass):
1. Unit, PostgreSQL integration, Umami integration and adapter contract tests (pinned versions).
2. Path-normalisation corpus: 451/451 plus fuzz with no crash and idempotence holding.
3. Database gates (ADR-0013): every table and partition has RLS ENABLE + FORCE and the restrictive backstop; no
   grants on partitions; every view `security_invoker`; every `SECURITY DEFINER` function allow-listed.
4. HTTP isolation matrix, generated from the OpenAPI document so new endpoints are covered automatically.
5. Data-inventory tests, including a scan of service logs produced during the e2e run for IP/UA/token patterns;
   bot-list parity (C-36), web-path scrubbing (C-52) and anonymous-report API tests (C-51).
6. Wallets Kit outbound allow-list test (no StrKey `/[GCM][A-Z2-7]{55}/`, no XDR) and tracker client-guard tests.
7. Tracker size budget (`strict` ≤ 2.5 kB gzip, `standard` ≤ 3.5 kB gzip, both including the challenge solver — C-32) and static check for `eval`/dynamic import
   (ADR-0004); reproducible tracker build verified by an independent job (ADR-0023).
8. Supply chain (ADR-0023): every new dependency reviewed against the licence allow-list (ADR-0001).
9. Generated artefacts up to date: OpenAPI types, one runbook per alert (ADR-0022).

Not merge-blocking but release-blocking: nightly full e2e, bot simulations, erasure e2e, upstream-tag contract test,
filter-list check (ADR-0004), load and chaos. A failing nightly opens an issue; a release cannot be tagged while one
is open. Flaky tests are quarantined only with a linked issue and a 14-day expiry.

## Consequences
Positive: each risky assumption in the register has a named test; evidence is reproducible and can be quoted in public
documentation; the community-appointed service operator inherits the same suite and gates.

Negative: the suite needs Docker and substantial time (Umami, PostgreSQL, Collector, Playwright browsers); multi-language
SDK fixtures (Node, Python, Go, Rust) must be kept current with upstream SDKs that change often (e.g. Node
`instrumentation-http` emits stable-only names since 0.221.0, Python still emits old names by default).

Honesty in assertions: the headless-browser simulation asserts the documented outcome — default headless Chrome is rejected as `ua_bot`,
`navigator.webdriver` under a normal User-Agent is `suspect` (`automation_flag`),
a stealth-patched browser may be `verified` at the gateway and is expected to surface only in L6–L7 aggregates. The
test exists to keep that limit visible, not to claim it away.

Revisit if the suite's cost becomes prohibitive for the community-appointed service operator (then move load and chaos to a
scheduled self-hosted runner), or if Umami gains a versioned stats API (then contract tests could narrow).

Unproven: nothing in this table has run yet. Layers depend on **S-01** (Umami integration), **S-03** (RLS on real
PostgreSQL 18), **S-04** (Collector), **S-05** (histogram SQL), **S-06** (SDK fixtures), **S-07** (PoW timing feeds
the tracker performance budget), **S-08** (restore drill against real buckets), **S-11** (Umami latency under load),
**S-12** (country accuracy of truncated addresses, C-38). S-13 (JA4) is dropped with JA4 itself (C-77).
The machines that run the suite must carry these layers.


## Open points
None outstanding. (Web load assumption and the extended chaos list are settled by C-48.)
