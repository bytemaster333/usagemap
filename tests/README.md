# `tests/` — cross-cutting suites

End-to-end, simulation, data-inventory, load, chaos and isolation-report suites that run against a whole stack
(ADR-0026). Node 24 / TypeScript run directly by Node (type stripping), vitest, Playwright (Chromium). No other
dependency; no k6 (AGPL) — the load and chaos generators are in `load/` and `chaos/`.

| Path | What | Gate / IDs |
|---|---|---|
| `e2e/web/10-web.e2e.test.ts` | Real Chromium (desktop + Android profile) on a tenant page with the SRI-pinned tracker from the gateway → engine proxy → Umami → jobs rollup → control-plane API → portal dashboard; all seven web metrics against values fixed by the script; verified vs raw; scripted POSTs not counted as verified | G2 · web.frontend-origin-only, bot.js-execution-proof, metric.*, dashboard.web-tenant |
| `bot/20-bot.e2e.test.ts` | Bot/inflation simulations read back through the installation-check API: no/invalid/missing/tampered/foreign/moved/replayed/flooded challenge, webdriver, hidden, headless and known-bot UAs, origin mismatch/missing, impossible fetch metadata, unverified domain, datacenter address (`botnet` subnet on the datacenter range list), multiplicity over threshold (identified and identifier-free sites) and the same traffic in shadow mode (C-124: no `multiplicity_high`, counted as `high_shadow`), forged site key | web.frontend-origin-only, bot.* |
| `e2e/api/30-api.e2e.test.ts` | Node, Python, Go, Rust sample services (`fixtures/api`, copied from S-06a/S-06b) dual-export → OTLP front door → Collector → writer → PostgreSQL → API; volume (every request the app served, warm-up included: C-122 counts a fresh process's first points), status codes, percentiles; logs refused; canary trace leaves only derived metrics | G3 · api.* |
| `quickstarts/40-quickstarts.e2e.test.ts` | The quickstart guides as test fixtures: the code blocks of `docs/guides/quickstarts/` (script tag with SRI, npm, Node/Express, Python/FastAPI, Go, Rust/axum, tenant Collector fan-out) are extracted (`quickstarts/extract.ts`, `recipes.ts`) and run as written — only the documented placeholders replaced — against the stack; the control-plane API must report what each recipe sent. `quickstarts/extract.test.ts` (unit, no Docker) fails when a guide's block, placeholder, SRI hash or pinned version drifts. Own stack: `quickstarts/stack/up.sh` (project scf-tgq, ports 56460–56469) | docs.quickstarts-run |
| `quickstarts/frameworks/frameworks.spec.ts` | tracker.ssr-frameworks framework coverage without Docker: the example apps of `examples/` (plain HTML, Eleventy, Astro with view transitions, Vite + React SPA, Next.js App Router, Nuxt, SvelteKit, React Router/Remix, Next.js + Wallets Kit; a separate pnpm workspace, C-147) are installed from their frozen lockfile, built in production mode, served by their own production server and driven in Chromium against the tracker's protocol-v1 mock gateway (`quickstarts/frameworks/server.ts`, schema and proof checks): one page view per load, client-side navigation and back counted once, the custom event once, a deep link counted as its path only, no other host, no console error; the Wallets Kit app emits exactly the expected schema-v1 wallet events with no address or signature. `quickstarts/frameworks.test.ts` (unit) keeps the guides (`docs/onboarding/web-*.md`, `docs/guides/quickstarts/`) and the examples in step, including SRI hashes (`quickstarts/frameworks/sync-sri.ts [--check]` rewrites them after a tracker change) | tracker.*, docs.quickstarts-run |
| `inventory/86-tracker-paths.e2e.test.ts` | Tracker 1.2.0 paths through the real gateway and control plane: browser RPC/Horizon aggregates on js-stellar-sdk 17.4.0's browser bundle (exact totals per method and outcome in `getSiteBrowserRpc`), `wallet_connect_failed` with the wallet context and the WalletConnect funnel, the Privy wrapper and `wrapWalletsKitModules` (exact `getSiteWalletFunnel` and `web_event_property_daily` counts), the React Native helper in Node → `/v1/app-events` (exact `getAppEvents`); canaries checked in both databases and every log and handed to 90. Turns on the `app` and `rpc` counter parts for its run | feature.wallets-kit-autocapture, privacy.gdpr-no-consent, privacy.minimal-erasure-scope |
| `inventory/90-inventory.e2e.test.ts` | Canaries through the front doors, then `pg_dump` of `scf` and `umami`, the gateway spool (read while the engine is stopped), the Collector queue volume and every container log scanned for canaries and personal-data shapes | privacy.gdpr-no-consent, privacy.minimal-erasure-scope, api.attribute-allowlist |
| `load/run.ts`, `load/run-api.ts` | Open-model load at 10× the design target (115.7 events/s web; 115.7 SERVER spans/s through the OTLP front door), drain and exact-count checks | capacity.1m-requests-day, slo.ingest-availability |
| `chaos/run.ts`, `chaos/run-api.ts` | SIGKILL of PostgreSQL, Umami, engine proxy, control plane, writer, Collector, jobs under web load; gateway crash with a full spool; writer and Collector killed under OTLP load | slo.ingest-availability |
| `isolation/run.ts` | One G4 report from `db/tests` and the control plane's HTTP isolation matrix | isolation.tenant-rls |
| `lib/` | gateway protocol client (challenge, PoW §b.2), control-plane client (SEP-53 sign-in), Compose access, privacy scanner, evidence writer, gates | — |

## Running

```sh
eval "$(mise env -s bash)"
pnpm --filter tests test                 # unit tests of the harness (no Docker)
tests/stack/up.sh                        # stack: project scf-wsl, host ports 56300–56319
pnpm --filter tests e2e                  # web → bot → api → quickstarts → inventory, in that order
pnpm --filter tests quickstarts          # only the quickstart fixtures (any stack; tests/quickstarts/stack/up.sh prints its env)
make quickstarts-frameworks              # framework example apps in Chromium, no Docker (= pnpm --filter tests quickstarts:frameworks; QS_FRAMEWORKS=nextjs,nuxt limits it)
node tests/load/run.ts --rate 116 --duration 120
node tests/load/run-api.ts --spans 116 --duration 120
node tests/chaos/run.ts --rate 8 --outage 20
node tests/chaos/run-api.ts
node tests/isolation/run.ts [--run-db | --db-json f] [--http-json g]
tests/stack/down.sh
```

Every suite takes its addresses from the environment (`lib/env.ts`): `SCF_GATEWAY_URL`, `SCF_GATEWAY_METRICS_URL`,
`SCF_CONTROL_PLANE_URL`, `SCF_PORTAL_URL`, `SCF_OTLP_URL`, `SCF_GATEWAY_CA`, `SCF_TEST_PROJECT`,
`SCF_TEST_COMPOSE_FILES`, `SCF_COMPOSE_SECRETS_DIR` (the stack's `.secrets` when it was started from another checkout), `SCF_EVIDENCE_DIR` — so they run unchanged against any `infra/compose`
stack. `tests/stack/up.sh` runs the real `infra/compose` stack on its own ports (56300 ingest + OTLP, 56302 control plane,
56303 portal) with `tests/stack/compose.override.yaml` adding only test needs: gateway `/metrics` on 56301, a stand-in
Horizon, the `botnet` network with its datacenter range list, and `SCF_CREATE_LIMIT_PER_HOUR=100000` on the control
plane (every fixture comes from one address; the production default is 60 creating calls per subnet per hour, C-64).
Against any other stack a creation `429` surfaces as a failure — nothing is restarted.

**Gates, never silent skips.** A test states what it needs (`requires(env, ctx, ["gateway", …])`). A missing
dependency marks it `NOT RUN — requires: <what> (<probe result>)`, appends the decision to `.work/gates.jsonl` and
shows up as "not run" in the evidence. With `SCF_REQUIRE_FULL_STACK=1` the same test
**fails**.

**Evidence (append-only).** Each suite writes
`docs/evidence/<layer>/<name>-<YYYYMMDDTHHMMSSZ>-<commit12>[-dirty].{md,json}` after a run in which at least one
check ran (commit, environment, every check with its outcome and capability ids (`docs/capabilities.md`), raw figures). Files are created
exclusively and never overwritten — every run is a new pair. A run from a tree with uncommitted changes carries
`-dirty` in the name, `dirty: true` in the JSON and a "Dirty tree" line in the Markdown; with
`SCF_EVIDENCE_REQUIRE_CLEAN=1` it is refused instead. Nothing is written for a run in which nothing ran.
Files from before this rule (`<YYYY-MM-DD>-<name>.*`) are kept as they are.

**Chaos (web).** Killed services come back with `docker compose up -d --no-deps --no-build --no-recreate <svc>`
(`lib/compose.ts` `upNoDeps`) — only the killed container; `compose start` would also start its dependencies. Every
load request carries its own page path (`load/web-load.ts` `uniquePaths`), so the run reports exactly: accepted vs.
stored per path, lost events (fail), and the surplus split into duplicate copies (at-least-once forwarding),
stored-although-the-answer-was-lost, refused-but-stored (fail) and unknown (fail); the gateway's
`scf_gateway_forward_ambiguous_retries_total` is shown as a cross-check. After the gateway kill the
`scf_gateway_spool_queued` gauge is re-measured once `/healthz` is 200 and must count the recovered records.

**Isolation matrix.** `isolation/run.ts` reports per test: the database part with its subtests (passed/failed),
the HTTP part with the number of assertions each test made (= operation × caller × identifier cases checked),
counted by `isolation/count-assertions.ts` injected through `isolation/vitest.http.config.ts`.

**Fixture steps done as superuser** (documented in `lib/fixture.ts`): enrollment mode `open` and marking declared
domains verified — the operator approval needs a passkey ceremony and domain verification needs public DNS; neither
is what these suites test. Sign-in, tenants, sites, domains, settings, Umami provisioning and the signed snapshot are
the real paths.

**Fixture apps** (`fixtures/api`) are test-only and never shipped: their Dockerfiles carry `ci-scan: skip`, the Go
module files are named `go.mod.fixture` / `go.sum.fixture` so the monorepo's Go tooling ignores them.
