# One entry point for the whole monorepo. Requires: mise (toolchain), docker.
SHELL := /bin/bash
# Generated modules (collector/_build, git-ignored; built and tested by `make collector-it`) are not source modules.
GO_MODULES := $(shell find . -name go.mod -not -path './spikes/*' -not -path '*/node_modules/*' -not -path './.git/*' -not -path '*/_build/*' -exec dirname {} \; | sort)
# The local stack: compose.yaml + the development and test fixtures of compose.dev.yaml (never part of a deployment).
COMPOSE := docker compose -f infra/compose/compose.yaml -f infra/compose/compose.dev.yaml
# Skips a module until it contains Go packages (go vet / go test fail when "./..." matches nothing).
HAS_PKGS = [ -n "$$(cd $$m && go list ./... 2>/dev/null)" ] || { echo "== skip $$m (no Go packages yet)"; continue; }

.PHONY: install lint test test-go test-ts build up down e2e collector-it smoke test-engine engine-images \
	test-writer test-jobs test-portal test-tracker-e2e test-db load chaos isolation-report \
	ha-test restore-drill tofu-check ansible-test \
	spdx coverage privacy-docs quickstarts \
	quickstarts-frameworks quickstarts-backends quickstarts-integrations quickstarts-integrations-browser handover-drill rebuild-drill support-selftest \
	demo-seed demo-seed-operator demo-seed-reset test-demo-seed \
	test-node-tools

install:            ## install toolchain and dependencies
	mise install
	pnpm install --frozen-lockfile

lint:               ## static checks for Go and TypeScript
	@for m in $(GO_MODULES); do $(HAS_PKGS); echo "== go vet $$m"; (cd $$m && go vet ./...) || exit 1; done
	pnpm lint

test-go:            ## Go unit and integration tests
	@for m in $(GO_MODULES); do $(HAS_PKGS); echo "== go test $$m"; (cd $$m && go test -count=1 ./...) || exit 1; done

test-ts:            ## TypeScript unit and integration tests
	pnpm test

test: test-go test-ts

build:
	@for m in $(GO_MODULES); do $(HAS_PKGS); (cd $$m && go build -o /dev/null ./...) || exit 1; done
	pnpm build

up:                 ## whole platform on this machine (creates dev secrets and PKI on first use)
	infra/compose/scripts/init.sh
	$(COMPOSE) up -d --build --wait

down:
	$(COMPOSE) down

e2e:                ## end-to-end suites against the running stack
	pnpm --filter tests e2e

load:               ## load tests against the running stack (tests/load)
	node tests/load/run.ts --views-per-load 30 && node tests/load/run-api.ts

chaos:              ## chaos tests against the running stack (tests/chaos)
	node tests/chaos/run.ts && node tests/chaos/run-api.ts

isolation-report:   ## tenant-isolation report, including the database matrix (tests/isolation)
	node tests/isolation/run.ts --run-db

coverage:           ## coverage report of the unit suites (Go + TypeScript) into coverage/; fails below 45 % (test.automated-suite)
	node --test tools/coverage/lib.test.ts
	node tools/coverage/run.ts --fail-under 45

privacy-docs:       ## docs/privacy/data-inventory.md claims vs a migrated database and the sources (Docker)
	pnpm --filter tests run privacy-docs

quickstarts:        ## quickstart guides as written against their own stack (scf-tgq, ports 56460-56469)
	tests/quickstarts/run.sh

quickstarts-frameworks: ## framework example apps (examples/) built, served and driven in Chromium; no Docker
	tests/quickstarts/frameworks/run.sh

quickstarts-backends: ## backend examples (examples/api-*) in UsageMap-only and dual-export mode against a local OTLP receiver (Docker for Python, Java, Rust, Anchor Platform)
	tests/quickstarts/backends/run.sh

quickstarts-integrations: ## server/edge/mobile/tool integration examples (examples/<integration>) against local stand-ins of UsageMap and third parties (Docker for Deno, Bun, Python, Dart, Kafka)
	tests/quickstarts/integrations/run.sh

quickstarts-integrations-browser: ## wallet, Stellar RPC and Telegram browser examples built and driven in Chromium against the ingest mock; no Docker
	tests/quickstarts/integrations/browser/run.sh

test-node-tools:    ## Node tools outside the workspace: hosted + stdio MCP, operator CLI, tracker pin Action (no network, no Docker)
	services/mcp/run test
	tools/mcp/run selftest
	tools/usagemap-op/run selftest
	tools/pin-action/run selftest

spdx:               ## SPDX header gate (C-129): self-tests, then every source file carries a licence header
	node --test tools/spdx/*.test.ts
	node tools/spdx/check-headers.ts

collector-it:       ## Collector: build with verified ocb, then binary + image + Compose tests
	collector/scripts/build.sh
	cd collector/tests && GOWORK=off SCF_COLLECTOR_IT=1 SCF_COLLECTOR_DOCKER=1 go test -count=1 ./...

smoke:              ## whole-stack smoke test: every service, web event and OTLP request end to end (own project, down -v)
	infra/compose/scripts/smoke.sh

engine-images:      ## the pinned Umami images (app + migrate) that the integration tests and Compose use
	docker buildx build --load --target app     -t usagemap/umami:3.5.0-d3c62a8         vendor/umami
	docker buildx build --load --target migrate -t usagemap/umami-migrate:3.5.0-d3c62a8 vendor/umami

test-db:            ## database gates, RLS matrix, migrations = data-model.md (Docker)
	cd db/tests && go test -count=1 ./...

test-writer:        ## metrics writer: unit (race) + integration incl. Collector e2e and load (Docker, built Collector)
	collector/scripts/build.sh
	cd services/metrics-writer && go test -count=1 -race ./internal/... && go test -count=1 ./integration/...

test-jobs:          ## jobs service: unit + integration against real Umami (Docker, make engine-images)
	pnpm --filter @usagemap/jobs test

test-portal:        ## portal: unit + mock Playwright end to end
	pnpm --filter @usagemap/portal test
	pnpm --filter @usagemap/portal run test:e2e

test-tracker-e2e:   ## tracker: Playwright fixtures (static, SPA, SSR), privacy, smoke
	pnpm --filter @usagemap/tracker run test:e2e

# ---- demo walkthrough: 20 synthetic DEMO projects in the stack of `make up` (tools/demo-seed/README.md)
demo-seed:          ## seed the DEMO projects and a read-only demo account into the running stack (idempotent)
	node tools/demo-seed/seed.ts

demo-seed-operator: ## as demo-seed, plus a read-only demo operator (role operator, never operator_admin)
	node tools/demo-seed/seed.ts --operator

demo-seed-reset:    ## remove the DEMO projects from the running stack
	node tools/demo-seed/seed.ts --reset

test-demo-seed:     ## demo seed: unit tests (standard library only, no Docker)
	node --test tools/demo-seed/test/*.test.ts

test-engine:        ## Umami pin + image hardening checks + engine-proxy integration test (needs Docker)
	vendor/umami/scripts/verify-pin.sh
	vendor/umami/test/hardening-check.sh
	services/engine-proxy/integration/run.sh

# ---- HA, backups and infrastructure as code (C-120)
ha-test:            ## PostgreSQL HA on Compose: failover under write load, fencing, rejoin (Docker)
	infra/compose/ha/tests/run.sh

restore-drill:      ## restore drill against the HA overlay: restore, pg_amcheck, RLS gates
	infra/compose/ha/scripts/restore-drill.sh

handover-drill:     ## handover data-migration drill: two operators, dump + pgBackRest paths, fingerprints (Docker, ~4 min)
	tests/handover/run.sh

rebuild-drill:      ## clean-clone rebuild following docs/guides/self-hosting.md verbatim (Docker-in-Docker, internet, ~9 min)
	tests/rebuild/run.sh

support-selftest:   ## support tooling: issue forms, labels, ticket SLA rule, support and SLO reports (no Docker)
	tools/support/run selftest

tofu-check:         ## OpenTofu fmt/validate/test against the mock provider (nothing is applied)
	infra/opentofu/scripts/check.sh

ansible-test:       ## Ansible syntax, lint and role tests
	infra/ansible/tests/run.sh

ops-alerts-test:    ## promtool check + unit tests of every alert rule
	ops/alerts/test.sh

ops-e2e:            ## monitoring overlay against the real stack
	ops/e2e/run.sh
