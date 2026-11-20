# Capabilities

What UsageMap does, one row per capability, with where each one is implemented and which test proves it. The
capability IDs (`area.short-name`) are stable: code comments, tests and design documents refer to them. Design
decisions are logged in [`adr/README.md`](adr/README.md) (`C-nn`); deliberate narrow readings and limits are the
design trade-offs in §2 (`DV-nn`).

"Where it lives" names the design document (ADR or guide) and the components; "Proven by" names the automated tests
or scripts that exercise the capability. Rows proven by a design document or an operational procedure say so.

## 1. Capabilities

### Platform

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `platform.multi-tenant-web-api-analytics` | Umbrella: multi-tenant web and API analytics platform that is designed, implemented, operable and transferable | [`architecture.md`](architecture.md); [`handover-plan.md`](handover-plan.md); all | design document / review |
| `platform.production-deployment` | Fully working multi-tenant platform in production | [`architecture.md`](architecture.md); all | design document / review |

### Web analytics

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `web.adblock-safe-endpoints` | Collect endpoints do not trigger common ad blockers | [ADR-0005](adr/0005-web-ingest-gateway.md); gateway | `tracker/scripts/filter-list-check.ts`; `tracker/test/filter-matcher.test.ts`; `services/gateway/cmd/gateway/e2e_test.go` |
| `web.adblock-safe-script-name` | Tracker script name and host do not trigger common ad blockers | [ADR-0004](adr/0004-tracker-strategy.md); [ADR-0005](adr/0005-web-ingest-gateway.md); tracker, gateway | `tracker/scripts/filter-list-check.ts`; `tracker/test/filter-matcher.test.ts` |
| `web.frontend-only-privacy-first` | Web analytics collected only from frontend instrumentation, privacy-first | [ADR-0004](adr/0004-tracker-strategy.md); [ADR-0005](adr/0005-web-ingest-gateway.md); [ADR-0027](adr/0027-privacy-and-compliance-posture.md); [`privacy/`](privacy/); tracker, gateway, engine (Umami) | design document / review |
| `web.frontend-origin-only` | Events originate only from frontend code | [ADR-0005](adr/0005-web-ingest-gateway.md); [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); tracker, gateway | `tracker/test/payload.test.ts`; `tracker/e2e/smoke.spec.ts`; `tracker/e2e/fixtures.spec.ts`; `tracker/e2e/privacy.spec.ts` |

### API analytics

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `api.attr-latency` | Request latency | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); collector, metrics-writer | `collector/processor/scfsanitizeprocessor/fixtures_test.go`; `collector/tests/e2e_test.go`; `services/metrics-writer/integration/e2e_test.go`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.attr-route` | Normalised path / http.route | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `collector/processor/scfsanitizeprocessor/attributes_test.go`; `packages/pathnorm/vectors_test.go` |
| `api.attr-status-code` | http.response.status_code | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); collector, metrics-writer | `collector/processor/scfsanitizeprocessor/attributes_test.go`; `services/metrics-writer/integration/store_test.go`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.attr-tenant-service` | tenant.id / service.name attribution (tenant bound from token) | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [ADR-0016](adr/0016-api-keys-and-ingest-tokens.md); collector, metrics-writer | `collector/tests/e2e_test.go`; `services/gateway/internal/otlp/door_test.go`; `infra/compose/scripts/smoke.sh`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.attribute-allowlist` | Keep only what standard metrics need (counters, histograms) | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); collector, metrics-writer | `collector/processor/scfsanitizeprocessor/attributes_test.go`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.drop-logs` | Collector drops deep logs | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); collector | `collector/tests/e2e_test.go`; `collector/tests/configlint_test.go`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.drop-traces` | Collector drops traces and spans (used only to derive metrics) | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); collector | `collector/tests/e2e_test.go`; `tests/e2e/api/30-api.e2e.test.ts` |
| `api.dual-export` | Tenants dual-export standard OTLP to their APM and to UsageMap | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [`guides/tenant-onboarding.md`](guides/tenant-onboarding.md); [`guides/quickstarts/`](guides/quickstarts/) (api-*.md); collector, docs | `tests/e2e/api/30-api.e2e.test.ts` |
| `api.otlp-to-postgres-metrics` | OTLP ingest, heavy APM payloads dropped, standard metrics stored in PostgreSQL | [ADR-0009](adr/0009-opentelemetry-pipeline-topology.md); [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); collector, metrics-writer | design document / review |
| `api.postgres-metrics` | Metrics written to PostgreSQL | [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); metrics-writer | `services/metrics-writer/integration/e2e_test.go`; `infra/compose/scripts/smoke.sh` |

### Browser tracker

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `tracker.intentional-upgrade` | Tenants upgrade tracker versions intentionally; old versions stay served | [ADR-0004](adr/0004-tracker-strategy.md); tracker, portal, docs | `tracker/test/build.test.ts`; `services/control-plane/test/integration/privacy-and-public.test.ts`; `services/control-plane/test/unit/basics.test.ts`; `apps/portal/e2e/mock/sharing.spec.ts` |
| `tracker.no-remote-updates` | No dynamic remote updates of tracking code (reproducible, immutable releases) | [ADR-0004](adr/0004-tracker-strategy.md); [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md); tracker | `tracker/test/build.test.ts`; `tracker/e2e/fixtures.spec.ts`; `tracker/e2e/privacy.spec.ts`; `tracker/e2e/smoke.spec.ts` |
| `tracker.spa` | Low-friction integration for single-page applications | [ADR-0004](adr/0004-tracker-strategy.md); tracker | `tracker/test/navigation.test.ts`; `tracker/e2e/smoke.spec.ts`; `tracker/e2e/fixtures.spec.ts`; `tracker/e2e/privacy.spec.ts` |
| `tracker.ssr-frameworks` | Low-friction integration for SSR frameworks | [ADR-0004](adr/0004-tracker-strategy.md); tracker, docs | `tracker/test/navigation.test.ts`; `tracker/e2e/fixtures.spec.ts` |
| `tracker.static-html` | Low-friction integration for static HTML sites | [ADR-0004](adr/0004-tracker-strategy.md); [`guides/tenant-onboarding.md`](guides/tenant-onboarding.md); [`guides/quickstarts/`](guides/quickstarts/) (web-script-tag.md); tracker, docs | `tracker/test/navigation.test.ts`; `tracker/test/build.test.ts`; `tracker/e2e/smoke.spec.ts`; `tracker/e2e/fixtures.spec.ts` |
| `tracker.version-pinned` | Tenant snippet is pinned to an exact tracker version | [ADR-0004](adr/0004-tracker-strategy.md); [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md); tracker, gateway | `tracker/test/build.test.ts`; `tracker/e2e/smoke.spec.ts`; `services/control-plane/test/integration/privacy-and-public.test.ts`; `services/gateway/integration/run.sh` |

### Bot and anti-inflation

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `bot.anti-inflation-strategy` | Strategy for detecting and mitigating bots and artificial metric inflation | [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); [`threat-model.md`](threat-model.md); gateway, jobs, docs | `services/gateway/cmd/gateway/e2e_test.go`; `services/gateway/integration/run.sh`; `tests/bot/20-bot.e2e.test.ts` |
| `bot.engine-bot-detection` | Keep and build on Umami's own bot detection | [ADR-0002](adr/0002-base-project-umami.md); [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); engine (Umami), gateway | `vendor/umami/test/hardening-check.sh`; `services/engine-proxy/integration/integration_test.go`; `services/gateway/integration/run.sh`; `tests/bot/20-bot.e2e.test.ts` |
| `bot.ip-multiplicity` | Treat many distinct fingerprints from one IP with suspicion | [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); [ADR-0006](adr/0006-ip-handling-and-geo-source.md); gateway, jobs | `services/gateway/cmd/gateway/e2e_test.go`; `services/gateway/integration/run.sh`; `tests/bot/20-bot.e2e.test.ts` |
| `bot.js-execution-proof` | Distinguish real browser JS execution from server-side posts | [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); tracker, gateway | `services/gateway/integration/run.sh`; `tests/bot/20-bot.e2e.test.ts` |

### Web metrics

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `metric.bounce-rate` | Bounce rate | [ADR-0002](adr/0002-base-project-umami.md); engine (Umami) | `tests/e2e/web/10-web.e2e.test.ts` |
| `metric.browser` | Browser breakdown | [ADR-0005](adr/0005-web-ingest-gateway.md); gateway, engine (Umami) | `services/gateway/integration/run.sh`; `apps/portal/e2e/mock/dashboard.spec.ts`; `tests/e2e/web/10-web.e2e.test.ts` |
| `metric.country` | Geographic distribution at country level | [ADR-0006](adr/0006-ip-handling-and-geo-source.md); gateway, engine (Umami) | `services/control-plane/test/integration/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `services/gateway/scripts/fetch-geo-db.sh` |
| `metric.device` | Device breakdown | [ADR-0005](adr/0005-web-ingest-gateway.md); gateway, engine (Umami) | `services/gateway/integration/run.sh`; `apps/portal/e2e/mock/dashboard.spec.ts`; `tests/e2e/web/10-web.e2e.test.ts` |
| `metric.identical-definitions` | Identical metric definitions across tenants, low-friction onboarding, comparable dashboards | [ADR-0024](adr/0024-portal-stack.md); [ADR-0028](adr/0028-trust-score-assurance-levels-onchain.md); [ADR-0032](adr/0032-scf-programme-integration.md); portal, jobs, control-plane | design document / review |
| `metric.pageviews` | Page views | [ADR-0002](adr/0002-base-project-umami.md); tracker, engine (Umami) | `services/engine-proxy/integration/integration_test.go`; `infra/compose/scripts/smoke.sh`; `tracker/test/payload.test.ts`; `tracker/e2e/smoke.spec.ts` |
| `metric.referrers` | Referrers | [ADR-0004](adr/0004-tracker-strategy.md); [ADR-0005](adr/0005-web-ingest-gateway.md) (C-65); tracker, gateway, engine (Umami) | `tracker/test/payload.test.ts`; `services/gateway/internal/ingest/ingest_test.go`; `services/control-plane/test/integration/web.test.ts`; `tests/e2e/web/10-web.e2e.test.ts` |
| `metric.session-duration` | Session (visit) duration | [ADR-0002](adr/0002-base-project-umami.md); engine (Umami) | `tests/e2e/web/10-web.e2e.test.ts`; `services/engine-proxy/integration/integration_test.go` |
| `metric.unique-visitors` | Unique visitors (privacy-limited across sessions) | [ADR-0007](adr/0007-visitor-identifier-and-salt-policy.md); gateway, engine (Umami) | `services/gateway/integration/run.sh`; `services/control-plane/test/integration/web.test.ts`; `tests/e2e/web/10-web.e2e.test.ts` |

### Privacy

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `privacy.data-residency` | Explicit data-residency declaration | [ADR-0017](adr/0017-data-residency.md); [`privacy/data-residency.md`](privacy/data-residency.md); docs, infra | `infra/opentofu/modules/azure-lean/tests/plan.tftest.hcl` |
| `privacy.erasure-workflow` | Right-to-erasure workflow documented and implemented | [ADR-0030](adr/0030-right-to-erasure-workflow.md); [`privacy/`](privacy/); docs, control-plane | `services/control-plane/test/integration/erasure.test.ts`; `apps/portal/e2e/mock/api.spec.ts` |
| `privacy.gdpr-no-consent` | GDPR-compliant without client-side opt-in | [ADR-0027](adr/0027-privacy-and-compliance-posture.md); [ADR-0006](adr/0006-ip-handling-and-geo-source.md); [ADR-0007](adr/0007-visitor-identifier-and-salt-policy.md); [`privacy/strategy.md`](privacy/strategy.md); tracker, gateway, docs | `tests/inventory/90-inventory.e2e.test.ts`; `infra/compose/scripts/smoke.sh` |
| `privacy.jurisdiction-statement` | Statement of GDPR-without-opt-in jurisdictions | [`privacy/`](privacy/); docs | design document / review |
| `privacy.jurisdictions` | Statement of jurisdictions that still need end-user opt-in | [`privacy/jurisdictions.md`](privacy/jurisdictions.md); docs | design document / review |
| `privacy.minimal-erasure-scope` | Minimise the set of users who could exercise right to erasure (store nothing identifying) | [ADR-0027](adr/0027-privacy-and-compliance-posture.md); [ADR-0030](adr/0030-right-to-erasure-workflow.md); tracker, gateway, engine (Umami) | `tests/inventory/90-inventory.e2e.test.ts`; `infra/compose/scripts/smoke.sh` |
| `privacy.residency-statement` | Explicit data-residency statement | [`privacy/`](privacy/); docs | design document / review |
| `privacy.strategy-docs` | Full privacy and compliance documentation pack, checked against the implementation | [`privacy/`](privacy/); docs | `tests/privacy-docs/` |
| `privacy.tenant-erasure` | Tenant-triggered erasure workflow | [ADR-0030](adr/0030-right-to-erasure-workflow.md); [`privacy/erasure.md`](privacy/erasure.md); control-plane, portal, engine (Umami) | `services/control-plane/test/integration/erasure.test.ts`; `services/control-plane/test/unit/erasure.test.ts`; `db/tests/followups_test.go`; `db/tests/jobs_followups_test.go` |

### Dashboards

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `dashboard.api-latency-percentiles` | Tenant API dashboard: latency p50/p95 | [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); portal, metrics-writer | `services/control-plane/test/integration/api-metrics.test.ts`; `apps/portal/e2e/mock/api.spec.ts`; `apps/portal/test/unit/api-dashboard.test.tsx`; `services/metrics-writer/integration/e2e_test.go` |
| `dashboard.api-status-codes` | Tenant API dashboard: status-code distribution | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/api-metrics.test.ts`; `apps/portal/e2e/mock/api.spec.ts`; `apps/portal/test/unit/api-dashboard.test.tsx` |
| `dashboard.api-tenant` | Private tenant API dashboard of normalised endpoint traffic | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/api-metrics.test.ts`; `apps/portal/e2e/mock/api.spec.ts`; `apps/portal/test/unit/api-dashboard.test.tsx`; `apps/portal/e2e/real/api-operator.spec.ts` |
| `dashboard.api-time-ranges` | Tenant API dashboard: selectable time ranges | [ADR-0011](adr/0011-retention-and-rollups.md); [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/api-metrics.test.ts`; `apps/portal/e2e/mock/api.spec.ts` |
| `dashboard.api-volume` | Tenant API dashboard: request volume | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/api-metrics.test.ts`; `apps/portal/e2e/mock/api.spec.ts`; `apps/portal/test/unit/api-dashboard.test.tsx` |
| `dashboard.time-ranges` | Selectable time ranges | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `tests/e2e/web/10-web.e2e.test.ts` |
| `dashboard.web-bounce-rate` | Tenant dashboard: bounce rate | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-country` | Tenant dashboard: country-level geography | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-device-browser` | Tenant dashboard: device and browser breakdown | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-pageviews` | Tenant dashboard: page views | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-referrers` | Tenant dashboard: referrers | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-session-duration` | Tenant dashboard: session duration | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-tenant` | Private tenant web dashboard | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |
| `dashboard.web-visitors` | Tenant dashboard: unique visitors | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/web.test.ts`; `services/control-plane/test/unit/web.test.ts`; `apps/portal/e2e/mock/dashboard.spec.ts`; `apps/portal/test/unit/dashboard.test.tsx` |

### Operator view

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `operator.api-compare` | Operator view compares API metrics across projects | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts` |
| `operator.api-fair-comparison` | Fair cross-project comparison (same definitions, self-attested label) | [ADR-0028](adr/0028-trust-score-assurance-levels-onchain.md); portal, jobs | `packages/pathnorm/vectors_test.go`; `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/test/unit/operator.test.tsx`; `services/jobs/test/unit/trust.test.ts` |
| `operator.api-global-access` | Operators read API metrics across tenants | [ADR-0014](adr/0014-authentication-authorisation-roles.md); control-plane, portal | `db/tests/ops_test.go`; `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `apps/portal/e2e/real/api-operator.spec.ts` |
| `operator.api-global-view` | Operator global API view aggregating metrics over all projects | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `apps/portal/test/unit/operator.test.tsx` |
| `operator.api-usage-ranking` | Identify high- and low-usage services | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/test/unit/operator.test.tsx`; `apps/portal/e2e/mock/operator.spec.ts` |
| `operator.global-view-credentials` | Designated operators hold separate, strongly authenticated credentials for the global view | [ADR-0014](adr/0014-authentication-authorisation-roles.md); control-plane, portal | `services/control-plane/test/integration/operator-console.test.ts`; `db/tests/ops_test.go`; `db/tests/followups_test.go`; `apps/portal/e2e/mock/operator.spec.ts` |
| `operator.real-usage-ranking` | Answer which projects are actually used: operator ranking, registry and on-chain linkage | [ADR-0015](adr/0015-enrollment-and-verification.md); [ADR-0028](adr/0028-trust-score-assurance-levels-onchain.md); [ADR-0032](adr/0032-scf-programme-integration.md); portal, jobs | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `services/jobs/test/integration/registry.test.ts`; `services/control-plane/test/integration/ladder-trust.test.ts` |
| `operator.web-compare` | Operator view compares core web metrics across projects | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `services/jobs/test/integration/rollup.test.ts`; `apps/portal/test/unit/operator.test.tsx`; `apps/portal/e2e/mock/operator.spec.ts` |
| `operator.web-filter` | Operator web view filtering | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `apps/portal/e2e/real/api-operator.spec.ts` |
| `operator.web-global-view` | Operator global web view aggregating core metrics over all projects | [ADR-0024](adr/0024-portal-stack.md); [ADR-0014](adr/0014-authentication-authorisation-roles.md); portal, control-plane | `services/control-plane/test/integration/operator-console.test.ts`; `services/jobs/test/integration/rollup.test.ts`; `services/jobs/test/unit/trust.test.ts`; `services/jobs/test/integration/trust.test.ts` |
| `operator.web-side-by-side` | Operator side-by-side project comparison | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `apps/portal/test/unit/operator.test.tsx`; `apps/portal/e2e/real/api-operator.spec.ts` |
| `operator.web-sort` | Operator web view sorting | [ADR-0024](adr/0024-portal-stack.md); portal | `services/control-plane/test/integration/operator-console.test.ts`; `apps/portal/e2e/mock/operator.spec.ts`; `apps/portal/e2e/real/api-operator.spec.ts` |

### Tenant isolation

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `isolation.api-dashboard` | Tenant API dashboard isolated from other tenants | [ADR-0013](adr/0013-tenancy-and-isolation.md); portal, control-plane | `services/control-plane/test/integration/api-metrics.test.ts`; `db/tests/matrix_test.go`; `apps/portal/e2e/mock/api.spec.ts` |
| `isolation.api-metrics` | API metrics follow the same tenant isolation | [ADR-0013](adr/0013-tenancy-and-isolation.md); metrics-writer, control-plane | `db/tests/matrix_test.go`; `services/metrics-writer/integration/store_test.go`; `services/control-plane/test/integration/api-metrics.test.ts`; `db/tests` |
| `isolation.tenant-rls` | Each tenant sees only its own data (RLS + data-access layer + API authorisation) | [ADR-0013](adr/0013-tenancy-and-isolation.md); [ADR-0003](adr/0003-integration-strategy-wrap.md); control-plane, portal, engine (Umami) | `db/tests/matrix_test.go`; `services/control-plane/test/integration/isolation.test.ts`; `db/tests`; `tests/isolation/run.ts` |
| `isolation.tenant-vs-operator` | Strict tenant isolation with an operator global view | [ADR-0013](adr/0013-tenancy-and-isolation.md); [ADR-0014](adr/0014-authentication-authorisation-roles.md); control-plane, portal, metrics-writer | design document / review |
| `isolation.web-dashboard` | Tenant web dashboard has no access to other tenants' data | [ADR-0013](adr/0013-tenancy-and-isolation.md); portal, control-plane | `db/tests/matrix_test.go`; `services/control-plane/test/integration/isolation.test.ts` |

### Tenancy

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `tenancy.multi-tenant-model` | Tenant is a first-class entity in every schema, token and API | [ADR-0013](adr/0013-tenancy-and-isolation.md); control-plane, metrics-writer, portal | `db/tests/gates_test.go`; `db/tests` |
| `tenancy.sites-and-services` | Teams register sites and API services themselves | [ADR-0013](adr/0013-tenancy-and-isolation.md); [ADR-0015](adr/0015-enrollment-and-verification.md); control-plane, portal | `services/control-plane/test/integration/tenants.test.ts`; `services/control-plane/test/integration/verification.test.ts`; `services/control-plane/test/integration/api-services.test.ts`; `apps/portal/e2e/mock/wizard.spec.ts` |

### Enrolment

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `enrol.approval-mode` | Switchable approval-required enrolment mode | [ADR-0015](adr/0015-enrollment-and-verification.md); control-plane, portal | `services/control-plane/test/integration/tenants.test.ts`; `services/control-plane/test/integration/lifecycle.test.ts`; `apps/portal/e2e/mock/operator.spec.ts` |
| `enrol.operator-removal` | Operators can suspend and remove non-ecosystem projects | [ADR-0015](adr/0015-enrollment-and-verification.md); control-plane, portal, gateway, collector | `db/tests/ops_test.go`; `services/control-plane/test/integration/lifecycle.test.ts`; `db/tests/jobs_followups_test.go`; `services/jobs/test/integration/tenant-purge.test.ts` |
| `enrol.self-service-ecosystem` | Self-service enrolment of Stellar projects; operator removal; approval mode later | [ADR-0015](adr/0015-enrollment-and-verification.md); control-plane, portal | design document / review |
| `enrol.self-service-open` | Self-service enrolment open to any Stellar project | [ADR-0015](adr/0015-enrollment-and-verification.md); control-plane, portal | `services/control-plane/test/integration/tenants.test.ts`; `services/jobs/test/integration/registry.test.ts`; `db/tests/jobs_followups_test.go` |

### API keys

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `keys.operator-api-keys` | Operators generate scoped, expiring metrics API keys for machine consumers | [ADR-0016](adr/0016-api-keys-and-ingest-tokens.md); [`api/`](api/); control-plane, portal | `services/control-plane/test/integration/operator-console.test.ts`; `services/control-plane/test/unit/keys.test.ts`; `db/tests/followups_test.go`; `apps/portal/e2e/mock/operator.spec.ts` |
| `keys.revocation` | Operators revoke metrics API keys with bounded propagation time | [ADR-0016](adr/0016-api-keys-and-ingest-tokens.md); control-plane | `services/control-plane/test/integration/opmetrics.test.ts`; `db/tests/followups_test.go`; `apps/portal/e2e/mock/operator.spec.ts`; `db/tests` |

### Licensing

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `licence.osi-only` | All code OSI-licensed; dependency licence allow-list applied on review | [ADR-0001](adr/0001-licence.md); [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md); all | `tools/spdx/check-headers.ts`; `tools/spdx/check-headers.test.ts` |

### Repository

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `repo.application-code` | All application code in the repository | [ADR-0025](adr/0025-languages.md); all | `services/onchain-reader/internal/count/count_test.go`; `services/jobs/test/unit/onchain.test.ts` |
| `repo.monorepo-complete` | One open-source monorepo with IaC, docs and operational artifacts, enough for an independent operator | [ADR-0001](adr/0001-licence.md); [ADR-0019](adr/0019-infrastructure-as-code.md); all | `infra/opentofu/scripts/check.sh`; `infra/ansible/tests/lean/run.sh` |
| `repo.single-monorepo` | Whole solution including IaC in a single repository | [ADR-0003](adr/0003-integration-strategy-wrap.md); [ADR-0019](adr/0019-infrastructure-as-code.md); all | design document / review |

### Cost

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `cost.zero-fees` | No fees for tenants, operators or anyone else; no billing code | [`architecture.md`](architecture.md); docs, control-plane | design document / review |

### Base engine

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `engine.umami-base` | Built on Umami as the base engine (choice justified in ADR-0002) | [ADR-0002](adr/0002-base-project-umami.md); [ADR-0003](adr/0003-integration-strategy-wrap.md); engine (Umami) | `vendor/umami/test/hardening-check.sh`; `services/engine-proxy/integration/integration_test.go`; `infra/compose/scripts/smoke.sh`; `packages/umami-adapter/test/contract/umami.contract.test.ts` |

### Trusted usage data

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `trust.verified-vs-raw` | Trusted usage data: verified vs raw counts, trust indicators, self-attested labels | [ADR-0008](adr/0008-bot-and-anti-inflation-model.md); [ADR-0028](adr/0028-trust-score-assurance-levels-onchain.md); [`threat-model.md`](threat-model.md); [ADR-0032](adr/0032-scf-programme-integration.md); gateway, jobs, portal | `services/jobs/test/integration/rollup.test.ts`; `services/gateway/integration/run.sh`; `tests/bot/20-bot.e2e.test.ts`; `services/jobs/test/unit/trust.test.ts` |

### Sharing

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `share.signed-usage-report` | Builders export/share a signed usage report; optional public stats page | [`architecture.md`](architecture.md); [ADR-0032](adr/0032-scf-programme-integration.md); portal, control-plane | `apps/portal/e2e/mock/dashboard.spec.ts`; `services/control-plane/test/integration/programme.test.ts`; `services/control-plane/test/unit/programme.test.ts`; `db/tests/jobs_followups_test.go` |

### Path normalisation

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `pathnorm.default-ruleset` | Hard-coded, versioned default path-normalisation rule set | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go` |
| `pathnorm.hex-hashes` | Rule: hex and crypto hashes | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go` |
| `pathnorm.numeric-ids` | Rule: numeric IDs | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go` |
| `pathnorm.other-patterns` | Further common patterns (ULID, tokens, e-mails, assets, cap) | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go`; `services/metrics-writer/integration/store_test.go` |
| `pathnorm.stellar-strkeys` | Rule: Stellar G-/C-/M- StrKeys (secret seeds redacted) | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go`; `packages/pathnorm/strkey_test.go` |
| `pathnorm.tenant-http-route` | No custom-rule UI; tenant-set http.route honoured | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer, docs | `collector/processor/scfsanitizeprocessor/attributes_test.go` |
| `pathnorm.trailing-slashes` | Rule: trailing and duplicate slashes | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go` |
| `pathnorm.uuids` | Rule: UUIDs | [ADR-0012](adr/0012-path-normalisation-rules.md); metrics-writer | `packages/pathnorm/vectors_test.go`; `collector/processor/scfsanitizeprocessor/attributes_test.go` |

### Capacity

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `capacity.1m-requests-day` | Design target ~1,000,000 API requests per day (load-tested at 10x) | [ADR-0010](adr/0010-postgresql-metrics-schema-and-histograms.md); [ADR-0018](adr/0018-hosting-and-topology.md); [ADR-0026](adr/0026-test-strategy.md); collector, metrics-writer, infra | `services/metrics-writer/integration/zz_load_test.go` |

### Retention

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `retention.aggregates-24m` | Aggregated views kept at least 24 months | [ADR-0011](adr/0011-retention-and-rollups.md); metrics-writer, jobs | `db/tests/partitions_test.go`; `db/tests/retention_test.go`; `services/jobs/test/integration/partitions.test.ts`; `db/tests` |
| `retention.raw-metrics` | Raw metrics kept for a short documented window | [ADR-0011](adr/0011-retention-and-rollups.md); jobs | `db/tests/partitions_test.go`; `services/jobs/test/integration/partitions.test.ts`; `db/tests` |

### Service levels

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `slo.concrete-commitments` | Concrete, measurable operational commitments (SLOs, reporting) | [`sla.md`](sla.md); docs | design document / review |
| `slo.dashboard-availability` | Dashboard availability objective (99.9 %) | [ADR-0018](adr/0018-hosting-and-topology.md); [ADR-0020](adr/0020-high-availability-and-spool.md); [ADR-0031](adr/0031-service-level-indicators-and-objectives.md); [`sla.md`](sla.md); portal, control-plane, infra | `infra/compose/ha/tests/run.sh` |
| `slo.ingest-availability` | Ingestion availability objective (99.99 %) | [ADR-0020](adr/0020-high-availability-and-spool.md); [ADR-0018](adr/0018-hosting-and-topology.md); [ADR-0031](adr/0031-service-level-indicators-and-objectives.md); [`sla.md`](sla.md); gateway, collector, infra | `services/gateway/integration/run.sh`; `services/gateway/internal/otlp/door_test.go`; `tests/chaos/run.ts`; `tests/load/run.ts` |

### Support

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `support.first-response` | Support first response within 5 business days | [`sla.md`](sla.md); operator | `tools/support/test/sla.test.ts` |
| `support.public-issue-tracker` | Public issue tracker; no mandatory on-call | [`sla.md`](sla.md); [ADR-0020](adr/0020-high-availability-and-spool.md); infra, operator | design document / review |
| `support.resolution` | Support resolution within 10 business days | [`sla.md`](sla.md); operator | `tools/support/test/sla.test.ts` |
| `support.user-support` | User support for the public instance | [`sla.md`](sla.md); operator | design document / review |

### Security

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `security.patch-24h` | Critical/high vulnerabilities patched or mitigated within 24 h | [`security/vulnerability-response.md`](security/vulnerability-response.md); [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md); operator | design document / review |
| `security.supply-chain` | Defence against supply-chain attacks (pins, SBOM, signing, scans) | [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md); [`security/supply-chain.md`](security/supply-chain.md); tracker, infra | `infra/compose/scripts/smoke.sh`; `tools/spdx/check-headers.ts` |

### Operator handover

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `handover.data-migration` | Full data migration to the new operator | [`handover-plan.md`](handover-plan.md); [ADR-0021](adr/0021-backup-and-disaster-recovery.md); infra, docs | `infra/compose/ha/tests/run.sh`; `infra/compose/ha/tests/azblob-msi.sh`; `infra/ansible/tests/lean/run.sh` |
| `handover.domain-transfer` | Domain transfer or permanent redirect | [`handover-plan.md`](handover-plan.md); [ADR-0023](adr/0023-release-and-supply-chain-pipeline.md) (C-50); infra, operator | design document / review |
| `handover.independent-operator` | Handover complete when a new operator runs the system independently | [`handover-plan.md`](handover-plan.md); operator, docs | design document / review |
| `handover.ready` | System kept ready for an orderly operator handover at any time | [`handover-plan.md`](handover-plan.md); infra, docs, operator | design document / review |
| `handover.repo-transfer` | Repository ownership transfer | [`handover-plan.md`](handover-plan.md); operator, docs | design document / review |
| `handover.window` | Operator handover can be executed on notice | [`handover-plan.md`](handover-plan.md); operator, docs | design document / review |

### Operations

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `ops.end-of-window-read-only` | End of service window: read-only mode and aggregate-only export | [`handover-plan.md`](handover-plan.md); operator, docs | design document / review |
| `ops.hosted-service-window` | The public instance is hosted and supported for a defined service period | [`sla.md`](sla.md); [ADR-0018](adr/0018-hosting-and-topology.md); infra, operator | design document / review |
| `ops.hosting` | Hosting of the public instance | [ADR-0018](adr/0018-hosting-and-topology.md); [`sla.md`](sla.md); infra, operator | design document / review |
| `ops.monitoring-alerting` | Monitoring and alerting baseline (dashboards, alerts, status page) | [ADR-0022](adr/0022-observability.md); [`monitoring-plan.md`](monitoring-plan.md); infra | `ops/alerts/tests/`; `ops/alerts/test.sh`; `infra/compose/ha/tests/run.sh`; `infra/compose/scripts/smoke.sh` |
| `ops.rebuild-from-repo` | Infrastructure rebuildable from the monorepo | [ADR-0019](adr/0019-infrastructure-as-code.md); [ADR-0021](adr/0021-backup-and-disaster-recovery.md); infra | `infra/opentofu/scripts/check.sh`; `infra/ansible/tests/run.sh`; `infra/compose/scripts/smoke.sh`; `infra/ansible/tests/lean/run.sh` |
| `ops.service-window-start` | Start of the hosted service period and its clock | [`sla.md`](sla.md); operator | design document / review |

### Infrastructure

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `infra.iac-complete` | Full infrastructure as code | [ADR-0019](adr/0019-infrastructure-as-code.md); infra | `infra/opentofu/scripts/check.sh`; `infra/ansible/tests/run.sh`; `infra/compose/scripts/smoke.sh`; `infra/compose/ha/tests/run.sh` |

### Documentation

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `docs.deployment-guide` | Deployment (self-hosting) guide, written to be run verbatim | [`guides/self-hosting.md`](guides/self-hosting.md); docs | design document / review |
| `docs.operator-runbooks` | Operator runbooks | docs | design document / review |
| `docs.privacy` | Privacy and compliance documentation | [`privacy/`](privacy/); docs | design document / review |
| `docs.quickstarts-run` | Tenant onboarding guide and quickstarts, run as written by the quickstart tests | [`guides/tenant-onboarding.md`](guides/tenant-onboarding.md); [`guides/quickstarts/`](guides/quickstarts/); docs, portal | `apps/portal/e2e/mock/wizard.spec.ts`; `apps/portal/test/unit/api-dashboard.test.tsx`; `tests/e2e/api/30-api.e2e.test.ts`; `tests/quickstarts/40-quickstarts.e2e.test.ts` |
| `docs.security` | Security documentation (threat model, supply chain, vulnerability response) | [`security/`](security/); [`threat-model.md`](threat-model.md); docs | design document / review |
| `docs.tenant-walkthrough-video` | Tenant-perspective walkthrough recording | [`guides/demo-script.md`](guides/demo-script.md); operator | design document / review |

### Tests

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `test.automated-suite` | Automated test suite and coverage report | [ADR-0026](adr/0026-test-strategy.md); all | `db/tests`; `tests/load/*`; `tests/chaos/*`; `infra/compose/ha/tests/run.sh` |

### Adoption

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `adoption.api-project-live` | A real project instrumented for API traffic in production | operator | design document / review |
| `adoption.operator-view-live` | Live operator global view on the public instance | [`guides/demo-script.md`](guides/demo-script.md); portal, operator | design document / review |
| `adoption.web-projects-live` | Real projects instrumented for web analytics in production | [`guides/tenant-onboarding.md`](guides/tenant-onboarding.md); [`guides/quickstarts/`](guides/quickstarts/); operator | design document / review |

### Features

| ID | Capability | Where it lives | Proven by |
|---|---|---|---|
| `feature.anchor-metrics` | Anchor SEP funnel and Anchor Platform listener | packages, tools | design document / review |
| `feature.app-events` | App events from native and Telegram Mini Apps | gateway, control-plane, packages | design document / review |
| `feature.browser-rpc-panel` | Browser RPC aggregate storage and tenant panel | gateway, control-plane, portal | design document / review |
| `feature.custom-events` | Custom events API with property allow-list | [ADR-0004](adr/0004-tracker-strategy.md); tracker, engine (Umami), portal | `tracker/test/guard.test.ts`; `tracker/e2e/smoke.spec.ts`; `tracker/e2e/fixtures.spec.ts`; `tracker/e2e/privacy.spec.ts` |
| `feature.daily-seal` | Daily seal of snapshots and audit-chain head on Stellar testnet, inclusion proofs | jobs, control-plane, portal | design document / review |
| `feature.defi-interactions` | DeFi protocol interaction counts | jobs, onchain-reader, portal | design document / review |
| `feature.dev-origins-debug` | Dev/preview origins never counted, debug mode, first-event panel | tracker, gateway, control-plane, portal | design document / review |
| `feature.docs-site` | End-user docs site, agent skill, llms.txt | docs | design document / review |
| `feature.ecosystem-usage-map` | Per-project contract usage for every registry project from public ledger data | jobs, onchain-reader, control-plane, portal | `services/control-plane/test/integration/usage-map.test.ts` |
| `feature.edge-middleware` | Edge runtime middleware (Workers, Vercel Edge, Deno, Bun) | packages, templates | design document / review |
| `feature.evidence-link` | Evidence link (snapshot v3: funnel, programme blocks, cohort percentile) | jobs, control-plane, portal | design document / review |
| `feature.footprint-keys` | Footprint registration keys | control-plane, db | `services/control-plane/test/integration/footprint-keys.test.ts` |
| `feature.hosted-mcp` | Hosted MCP server with OAuth 2.1 | services/mcp, control-plane | `services/control-plane/test/integration/oauth.test.ts` |
| `feature.integration-examples` | Minimal runnable example per integration | examples, tests | `tests/quickstarts/examples.test.ts` |
| `feature.integration-metrics` | Integration metrics stream (partner calls) | collector, metrics-writer, packages | design document / review |
| `feature.integrations-catalogue` | Portal integrations catalogue with generated config and test command | control-plane, portal | design document / review |
| `feature.ledger-files-source` | Public ledger files as primary on-chain source | onchain-reader, jobs, compose | `services/onchain-reader/internal/fetch/*_test.go`; `services/onchain-reader/integration/onchain_test.go` |
| `feature.operator-cli` | Operator CLI usagemap-op | tools | design document / review |
| `feature.operator-cohorts` | Operator cohorts by SCF round, category and award stage | jobs, control-plane, portal | design document / review |
| `feature.payment-counters` | Agent payment counters (x402, MPP) | packages | design document / review |
| `feature.registered-footprint` | Tenant-declared contracts verified before they count | control-plane, jobs, portal | design document / review |
| `feature.signed-snapshot-v2` | Signed traction snapshot v2 with preset windows and weekly series | jobs, control-plane, portal | `services/control-plane/test/integration/differentiation.test.ts` |
| `feature.stellar-cli-plugin` | stellar CLI plugin and GitHub tracker-pin Action | tools | design document / review |
| `feature.stellar-event-schema` | Stellar event schema v1, signing/transaction events, wallet funnel | tracker, gateway, control-plane, portal | `tracker/test/stellar.test.ts`; `tracker/test/wallets*.test.ts`; `services/gateway/internal/ingest/stellar_test.go` |
| `feature.stellar-sdk-metrics` | Stellar SDK client metrics packages (JS, Python) | packages, collector, metrics-writer | design document / review |
| `feature.tracker-1-2` | Tracker 1.2.0 wallet context, WalletConnect funnel, browser RPC aggregate | tracker, gateway, control-plane | `tests/inventory/86-tracker-paths.e2e.test.ts` |
| `feature.verify-this-number` | Sealed anchors, verifier keys, public verify endpoints, badges | jobs, control-plane, portal | design document / review |
| `feature.wallets-kit-autocapture` | Automatic Stellar Wallets Kit event capture | [ADR-0029](adr/0029-stellar-wallets-kit-capture.md); tracker | `tracker/test/payload.test.ts`; `tracker/e2e/fixtures.spec.ts`; `tracker/test/wallets-kit.test.ts`; `tracker/test/wallets.test.ts` |

## 2. Design trade-offs

Places where UsageMap deliberately reads a capability narrowly, goes beyond it, or accepts a limit. Each trade-off
has a stable ID `DV-nn`; numbers that no longer carry a technical trade-off are marked withdrawn so the numbering
stays stable.

| ID | Capability | Trade-off | Why |
|---|---|---|---|
| DV-01 | `api.attr-latency` | Server-side request duration is the latency metric (`http.server.request.duration` in seconds; legacy `http.server.duration` in milliseconds is converted). Client-side metrics are dropped and never counted as usage. | `http.client.duration` is the legacy name of the *outbound client* metric; an API's own latency is the server metric (OpenTelemetry semantic conventions). |
| DV-02 | — | Withdrawn (no technical content). | — |
| DV-03 | `licence.osi-only` | Geo-IP *data* is consumed under an open-data licence (e.g. CC BY 4.0), which is not an OSI software licence. | It is data, not code; OSI does not approve data licences. Decided in ADR-0001 and ADR-0006 (DB-IP Lite CC BY 4.0; sapics PDDL as fallback). |
| DV-04 | `dashboard.api-latency-percentiles` | p99 is provided in addition to p50 and p95. | More useful tail latency. |
| DV-05 | `feature.custom-events`, `feature.wallets-kit-autocapture` | Zero-configuration Wallets Kit capture (Tier 0) is limited to address-free page signals and does not run in the `strict` profile; full wallet events need a one-line adapter (Tier 1). | The kit has no global build and no sign or modal events; the tracker does not touch wallet objects unless the tenant's code asks for it (ADR-0029, C-13). |
| DV-06 | `repo.single-monorepo` | The public status page's history lives in a separate repository generated by the status tool. | It is generated output (probe results), not source; the workflow that generates it is defined in the monorepo. |
| DV-07 | `engine.umami-base` | Umami runs unmodified as a private engine; tenants and operators use the UsageMap portal, not Umami's UI. | Umami has no operator role, no cross-site view, unscoped keys, and a public surface with a serious advisory history. Its sessions, visits and metric definitions remain the source of every web number shown. |
| DV-08 | `bot.engine-bot-detection` | Umami's own check stays enabled, and the same bot list is also applied at the gateway before anything is stored. | Umami's detection is a single User-Agent list check; the anti-inflation model needs layers in front of it. |
| DV-09 | `metric.unique-visitors` | Uniques are per site per UTC day; multi-day figures are sums of daily uniques and labelled so; no cross-site identity exists. | The visitor key is random, in memory only and destroyed daily (ADR-0007). |
| DV-10 | `operator.web-global-view`, `operator.web-compare`, `operator.web-filter`, `operator.web-sort`, `operator.web-side-by-side`, `operator.api-global-access`, `operator.api-global-view`, `operator.api-compare`, `operator.api-usage-ranking`, `operator.api-fair-comparison` | The operator view is built only from per-tenant aggregates with a minimum-count threshold and rounding; cross-tenant unique visitors are never computed. The threshold applies to every operator read path, including machine API keys (C-17). | Published French and UK criteria restrict pooling and onward sharing of audience data (ADR-0027). |
| DV-11 | `api.dual-export` | Tenants without OpenTelemetry are supported too (first-time instrumentation guides); either SDK metrics or server spans are accepted. | Few Stellar API backends run OpenTelemetry today; standard HTTP metrics carry no path unless `http.route` is set. |
| DV-12 | `api.drop-traces` | Logs are refused at the door (no pipeline). Server spans are used in memory to derive metrics and then discarded; nothing from a span is persisted. | Without spans there is no endpoint path for services that do not set `http.route`. |
| DV-13 | `dashboard.api-latency-percentiles` | Every percentile is shown with an accuracy class: ≤ 4.33 % for exponential histograms, bucket width for default explicit buckets. | Percentiles from fixed buckets can be off by up to a bucket width; the dashboard says so instead of hiding it. |
| DV-14 | — | Withdrawn (no technical content). | — |
| DV-15 | `retention.aggregates-24m` | Daily API aggregates are kept indefinitely, hourly for 25 months. Web daily aggregates are kept indefinitely; event-level web data 90 days by default. | Long-lived aggregates; short event-level data for privacy. |
| DV-16 | `web.frontend-only-privacy-first`, `privacy.gdpr-no-consent`, `privacy.jurisdictions` | The `standard` profile is designed to run without consent where national ePrivacy rules allow it (France, Spain, Italy, Netherlands; Switzerland and the UK with notice and opt-out). In Germany, Belgium and most other EU/EEA states opt-in is required for `standard`; `strict` without a visitor identifier is contested in Germany. A consent-gated tracker mode serves tenants there. | The obstacle is ePrivacy Art. 5(3) as implemented nationally, not the GDPR. UsageMap states this instead of claiming consent-free operation everywhere (ADR-0027, C-41, C-55). Not legal advice. |
| DV-17 | `metric.unique-visitors`, `metric.session-duration`, `metric.bounce-rate`, `dashboard.web-visitors`, `dashboard.web-session-duration`, `dashboard.web-bounce-rate` | For sites or countries with `visitor_id = off` (the default for `strict`), events go to a twin Umami website and count toward page views, country and device only. Uniques, visits, bounce rate and duration come from identified events only, and the dashboard says so. | Required for the `strict` position (C-53, C-73). |
| DV-18 | `dashboard.web-pageviews` … `dashboard.web-device-browser` | `anonymous_reports` is on by default: breakdown rows below 10 merge into "Other" and counts are rounded to 10. A tenant may switch it off. | The French audience-measurement criteria the `standard` profile is built to (C-51). |
| DV-19 | `metric.referrers`, `dashboard.web-referrers` | Referrer host only. No query strings, no campaign (UTM) reporting. The `strict` profile sends no referrer. | Data minimisation; the same criteria (C-65). |
| DV-20 | `metric.pageviews`, `dashboard.web-pageviews` | Web page paths pass through the path normaliser: identifier-shaped segments become placeholders; secrets and e-mail addresses become `{redacted}`, which cannot be switched off. | Stops wallet addresses or personal data in URLs from being stored (C-52, C-70). |
| DV-21 | `metric.pageviews`, `metric.country` | Events from browsers sending GPC or DNT, from visitors who opted out, and from countries in a site's `exclude_countries` are not counted. | Privacy signals honoured; country exclusion is the only measure offered for localisation regimes (ADR-0004, C-58). |
| DV-22 | `web.frontend-origin-only` | Origin cannot be proven. Events without a valid challenge are rejected; events without proof or with inconsistent signals are stored as `suspect` and appear in raw figures only. | A server can run a browser; UsageMap raises the cost and labels the result (ADR-0008). |
| DV-23 | `bot.ip-multiplicity` | Distinct visitor surrogates per truncated subnet (/24, /48), counted in memory per edge node, with thresholds by network class; carrier NAT and Private Relay are carved out. | No IP is kept; shared addresses are not punished (ADR-0008). |
| DV-24 | `dashboard.time-ranges`, `dashboard.api-time-ranges` | Event-level web data is kept 90 days (settable 30–395). Each site's dashboard is answered live by Umami only for its **live window** — the current UTC day and as many preceding days as keep a query under ~250,000 events (1 day for the largest sites, up to 90 for small ones), plus any range starting within the last 24 hours; every earlier part of a range comes from hourly and daily rollups (totals and top-N breakdowns, daily rows kept indefinitely). | Short event-level retention for privacy (C-54); Umami cannot answer long ranges fast enough at the design load (C-109, C-112). |
| DV-25 | `operator.web-global-view`, `operator.web-compare`, `operator.api-global-view`, `operator.api-compare` | Unverified (L0) tenants are excluded from operator rankings by default; an SCF operator can include them. | Unverified tenants would distort comparisons and invite gaming (ADR-0015). |
| DV-26 | `enrol.self-service-open` | Open, but unverified tenants are quota-limited (2 sites, 1 API service, 50,000 web events/day, 100 routes) until they verify a domain. Identities of removed tenants are tombstoned. | Abuse control (C-19, C-64). |
| DV-27 | `keys.operator-api-keys`, `keys.revocation` | Only an `operator_admin` with a fresh passkey assertion creates or revokes keys. Keys are scoped, expire (90 days by default, 365 at most) and return thresholded data. Tenants may also create read-only keys for their own programme endpoint. | Least privilege; programme integration (C-09, C-14, C-70, ADR-0032). |
| DV-28 | `repo.single-monorepo`, `repo.monorepo-complete` | Umami's source is fetched by pinned commit (the repository holds the pin, build recipe and patch queue). Third-party IP range lists are fetched at run time and not committed. The audit-chain head goes to a public evidence repository. | Upstream stays unmodified; the range lists have no clear redistribution licence (C-38, C-63). See also DV-06. |
| DV-29 | `slo.ingest-availability` | Available = a 2xx answer after durable local persistence. Events that cannot be delivered for 72 hours are discarded and counted. An event accepted by a node that is then permanently lost before forwarding is lost (exposure: the undrained backlog, normally seconds). Rejected events are outside the indicator. | Bounded spool; no long-lived raw queues; no spool copies in the first release (C-18, C-39, C-77). |
| DV-30 | `security.patch-24h` | "Patched or mitigated" within 24 hours of the advisory appearing in a watched source; compensating controls when upstream has no fix. | Upstream fixes are outside the project's control (C-67). |
| DV-31 | `support.public-issue-tracker` | No paging, but a daily watch roster (one person per calendar day) and two patch responders. | The 24-hour patch and 72-hour spool commitments need someone to look daily (C-49, C-67). |
| DV-32 | `handover.domain-transfer` | Domains are transferred. A redirect is documented as insufficient for ingest and offered only temporarily for the portal. | Cross-origin redirects of beacons and POSTs are unreliable (C-50). |
| DV-33 | — | Withdrawn (no technical content). | — |
| DV-34 | `metric.session-duration`, `metric.bounce-rate`, `dashboard.web-session-duration`, `dashboard.web-bounce-rate`, `operator.web-global-view`, `operator.web-compare` | Verified and raw figures exist for page views and unique visitors. Visits, bounce rate and session duration have **one** figure each, computed over all identified non-rejected events, shown with the share of page views that are suspect. A visit containing any custom or wallet event is not a bounce (Umami's definition); no automatic event fires on page load. | Filtering events inside a visit would distort these three metrics and make them incomparable (C-73, C-75). |
| DV-35 | `slo.ingest-availability`, `slo.dashboard-availability`, `slo.concrete-commitments` | 99.99 % and 99.9 % are objectives measured and published against, with an error-budget policy. The commitment is the measurement method, monthly publication with raw probe data, post-mortems, and response times. | Nobody can honestly guarantee 99.99 % without months of history; transparency is the remedy (C-78). |
| DV-36 | `enrol.approval-mode` | The switch applies to new enrolments immediately; existing tenants can be put back under approval in bulk by verification level. | So the transition can cover tenants already enrolled (C-91). |
| DV-37 | `operator.web-global-view` … `operator.web-side-by-side` | In the SCF operator view a site's totals are shown as they are; minimum count and rounding apply to breakdown rows only (amends DV-10). | Thresholding totals would hide small projects from operators (C-91). |
| DV-38 | `dashboard.time-ranges`, `dashboard.api-time-ranges` | A custom web range whose part before the site's live window does not consist of whole UTC days is answered `400 validation_failed`; all presets comply. | Unique visitors, visit metrics and breakdowns are not additive within a day, and the rollups are daily (C-109, C-112). |
| DV-39 | `tracker.ssr-frameworks` | The SSR end-to-end fixture is a **React Router (framework mode) SSR** app instead of Next.js or Astro (`tracker/e2e/fixtures.spec.ts`, C-116). The tracker itself is framework-agnostic; hydration and no-double-count rules are tested the same way. | Next.js and Astro fail the licence gate as test dependencies (`caniuse-lite` CC-BY-4.0; `sharp` with LGPL libvips), and the gate covers every dependency in the lockfile. |
| DV-40 | `bot.ip-multiplicity`, `bot.anti-inflation-strategy` | Network classes (datacenter, tor, vpn, relay, and the eyeball classes) come **only from configured range lists** (`GW_RANGELISTS_DIR`); an address in none of them is `unknown` and uses `max(T[unknown], T[eyeball_mobile])` — 40 / 160 distinct visitors, 400 / 1,600 page loads per 10 minutes (C-124, replacing C-118's `eyeball_fixed`); operators can run multiplicity in `shadow` mode (platform or per site) to measure its false-positive rate. | No open ASN-to-access-type data set with an allow-listed licence distinguishes fixed from mobile eyeball networks; without eyeball lists nearly every visitor is `unknown`, and fixed-line thresholds marked carrier-NAT and campus audiences suspect, so `unknown` takes the mobile thresholds — a bot farm behind one unclassified address can show up to 40 surrogates per 10 minutes before the cell is high; PoW, rate limits, `transport_mismatch` and the trust score still apply. |
| DV-41 | `slo.ingest-availability`, `slo.dashboard-availability` | The single-VM (lean) profile runs the Compose stack on one VM in one region; its objectives are 99.5 % per month for ingest and for the dashboard (`docs/sla.md`), with durability of accepted events, database RPO ≤ 60 s and RTO ≤ 4 h as targets. The 99.99 % / 99.9 % objectives belong to the scale-out profile (edges in several failure domains, two cores, Patroni; `docs/scale-out-plan.md`), which stays in the repository and is tested (C-123, C-180). | A cloud provider's own single-VM SLA is typically 99.9 %, so 99.99 % cannot honestly be claimed on one VM. |
