# `tools/demo-seed` — seeded DEMO projects for a guided demo

Seeds 20 **synthetic** projects into a running local stack, so a three-minute walk through the tenant and operator
views runs against the real control plane, portal, jobs and analytics engine. It needs no mocks, real projects or outside services.

Everything is labelled DEMO:
- every slug starts with `demo-`;
- every name starts with `DEMO · `;
- every description says *synthetic demo data*;
- hosts end in `.demo.invalid`.

The portal shows a DEMO banner for `demo-` slugs. No real project name is used: the names are invented, and a test
checks them against a list of real SCF-awarded projects and ecosystem tools.

## Commands

Standard library only (Node ≥ 24.19, TypeScript run directly). Run the commands from the repository root.

| What | Make target (see the root `Makefile`) | Command |
|---|---|---|
| Seed the stack of `make up` | `make demo-seed` | `node tools/demo-seed/seed.ts` |
| Seed another Compose project | — | `node tools/demo-seed/seed.ts --project scf-x --portal http://localhost:26562` |
| Also grant a read-only demo operator | `make demo-seed-operator` | `node tools/demo-seed/seed.ts --operator` |
| Remove the demo projects | `make demo-seed-reset` | `node tools/demo-seed/seed.ts --reset` |
| Write the SQL without running anything | — | `node tools/demo-seed/seed.ts --dry-run --sql-out /tmp/demo-sql` |
| PostgreSQL only (no control plane or engine) | — | `node tools/demo-seed/seed.ts --mode db --pg-container <id>` |
| Sign a sign-in message | — | `node tools/demo-seed/sign.ts '<message>'` (`--as <slug>`, `--operator`, `--account`) |
| Tests | `make test-demo-seed` | `node --test tools/demo-seed/test/*.test.ts` |

**Local stacks only** (`src/guard.ts`): the seed refuses a portal origin that is not a loopback
address and a PostgreSQL container that was not started with the development overlay `infra/compose/compose.dev.yaml`
(every local launcher adds it, no deployment loads it; a throwaway container may carry the label `scf.local-stack=1`
instead). `--reset` is guarded the same way.

Options:
- `--portal` (`SCF_DEMO_PORTAL`, default `http://localhost:5173`): the portal origin, which also proxies the API.
- `--project` (`SCF_DEMO_PROJECT`, default `compose`, the project name of `make up`): finds the PostgreSQL container.
- `--phrase` (`SCF_DEMO_PHRASE`): every key, contract id and figure is derived from it. The default is a public demo
  phrase; the same phrase always gives the same data.
- `--keep-live-budget`: see "Live window" below.
- `--no-engine`: skip the analytics-engine rows.

## Signing in

The seed prints two accounts:

- **Read-only viewer:** a user who is a `viewer` member of every demo project. Open `/signin`, choose "any wallet"
  and paste the account. Then run `node tools/demo-seed/sign.ts '<message>'` and paste the signature it prints.
  A `viewer` cannot change anything: every write answers `403` (checked against a real stack).
- **Demo operator** (`--operator`): granted the `operator` role (never `operator_admin`) through the database. A
  local stack has no other bootstrap path; the portal's real-stack test does the same. Its key is **not** derived from
  the public demo phrase: it comes from `--operator-secret` / `SCF_DEMO_OPERATOR_SECRET` (at least 16 characters, not
  the phrase), or the seed makes a random secret and prints it once. Sign with
  `SCF_DEMO_OPERATOR_SECRET=<secret> node tools/demo-seed/sign.ts --operator '<message>'`. An operator session is complete only after a passkey (C-09, C-114), so the first sign-in asks
  you to register one. Chromium's virtual authenticator or any platform passkey works.

The keys are derived from the phrase. They exist only to sign SEP-53 messages for a local stack: **never fund them or
use them on a public network.**

## What the projects look like

The cohort is shaped on public SCF award data (390 awards, rounds #30–#45):

| Award data | Demo cohort |
|---|---|
| anchors, ramps and payments are the largest product group | 6 payments projects; also API/SDK 4, DeFi 3, wallets 2, infrastructure 2, web dApp, RWA, marketplace |
| 315 of 390 have a web frontend (≈ 80 %) | 16 of 20 have a website (80 %) |
| 179 of 390 offer an API or SDK (≈ 45 %) | 9 of 20 have an API service (45 %) |
| 5 SCF categories | all 5; *End-User Application* (6) and *Financial Protocols* (5) are large enough to be shown in operator cohorts (`cohort_min_tenants` = 5), the other three are suppressed |
| rounds weighted to the recent ones | rounds #44 and #45 have 5 projects each (shown); #30, #35, #40 and #42 are suppressed |
| award progress | award stages `t0_prelaunch` … `t3_mainnet`; verification levels L1–L4 (L3/L4 projects are registry-linked and so in the cohorts) |
| Soroban is the most cited surface | 12 projects declare contracts (synthetic `C…` ids with valid checksums that exist on no network); 11 are verified; one stays *claimed* |

Built-in stories for the demo:
- **A launch spike with an annotation.** 12 days back, `demo-alder-remit` has 6.5× its usual traffic, 72 % of it
  suspect. That day's trust score drops, with the reason codes `step_change`, `proof_coverage_low`,
  `network_datacenter_share_high` and others. The project's own annotation explains the spike as a launch campaign.
  It is created through the API.
- **Persistent suspect traffic.** About half of `demo-kestrel-swap`'s sessions are suspect, so it has open anomaly
  flags and a lower trust score, with no explanation.
- **Wallet funnel.** For mainnet and testnet, by wallet type: Freighter, xBull, LOBSTR, Albedo, Hana, passkey,
  WalletConnect, Rabet, HOT and unknown. It runs modal → connect → sign → submit, with SEP-43 error classes and
  submit result classes. The two passkey-wallet projects also count `smart_wallet_created` and `passkey_used`.
- **API services.** Horizon-like, RPC-like (by method), REST and x402 (`402` responses) services, with latency
  histograms, so p50/p95/p99 have an accuracy class. Assurance runs A0–A2; projects with verified contracts are
  on-chain `consistent`.
- **Evidence packs.** Two projects ask for a signed traction snapshot through the API: a Build award period, and the
  last full quarter as a PG renewal. A v2 request (with preset) is tried first, then v1. The jobs service signs them
  as it signs every snapshot. **The seed never forges a signature.** Seal opt-in (`seal_enabled`) is on for every
  second project.

Everything is deterministic. A re-run with the same phrase recreates the same figures, relative to today.

## What is written where, and why

**Through the public API**, as each project's own owner, signed in with SEP-53 (one owner key per project, because a
user may create at most 3 projects):
- projects;
- websites (Umami provisions each one, through the engine proxy);
- API services;
- declared contracts;
- the demo viewer's `viewer` membership, by invitation and acceptance;
- the spike annotation;
- the snapshot requests.

**Through the documented DB path**, as the database superuser inside the stack's PostgreSQL container, the same way
the db test seed (`db/tests/seed_test.go`) and the portal's real-stack test write jobs-only rows. It is one
transaction. Every `DELETE` is bounded by the tenant ids of `demo-` slugs, and the script refuses to run unless every
planned demo project exists and is active. It writes only what verifiers and jobs would produce, and what the demo
cannot produce for real:

| Rows | Why not through the API |
|---|---|
| `site_domains` (verified), `host_claims`, `verification_evidence` (domain, owner account, registry match, operator approval) | the `.demo.invalid` hosts cannot be proven by DNS or HTTP. These rows record the outcome a verifier would record; the level check (`scf.verification_level`) must match the plan |
| `registry_projects` (source `operator`, `demo:<slug>`, with `scf_categories`, `award_round`, `award_stage` and a `source_url` under `registry.demo.invalid`, shown as the registry link in the operator console) and confirmed `tenant_registry_links` | written by `registry_sync` and operator decisions; there is no demo registry |
| `declared_contracts` status `verified` (role `deployer`, method `deployer_admin_match`) | the synthetic contracts exist on no network |
| `tenants` flags: `public_stats_enabled`, `seal_enabled`, `onchain_correlation_enabled` | tenant settings an owner could switch in the portal |
| `web_daily_totals`, `web_daily_breakdowns`, `web_edge_counters`, `web_trust_scores`, `web_event_property_daily` | rollups of the jobs service and the edge (120 days; wallet events 45 days) |
| `api_routes`, `api_stream_groups`, `api_metrics_1d` (120 days), `api_metrics_1h` (32 days), `api_route_day`, `api_service_day_groups`, `api_service_assurance` | written by the metrics writer and the jobs. Past `api_metrics_*` partitions are created exactly as `scf.ensure_partitions()` creates them (as `scf_migrator`, with `scf_admin.secure_partition`), because the function only makes current and future ones |
| `onchain_daily` (verified contracts only, `data_source = ledger_files`) | the on-chain reader's output |
| `platform_operators` (only with `--operator`) | the only operator bootstrap on a local stack |
| setting `web_live_events_budget` = 10,000 | see "Live window" |

**Analytics engine (Umami database)**, for the demo websites only. These are synthetic `session` and `website_event`
rows for each site's live window, using the gateway's conventions:
- normalised path;
- empty query string;
- no page title;
- referrer host only;
- tag `v`/`s`;
- no region or city.

They are generated from the same sessions as the rollup rows, so the live part of a dashboard range and the rolled-up
part agree. A later `web_rollup` run re-derives the same totals; this was checked against a real stack.

**Live window (C-109).** A dashboard answers a site's most recent `scf.web_live_window_days()` days from the engine.
The seed sets the platform budget to its minimum (10,000 engine events). This keeps each window short, so at most
about 10,000 events per site are written to the engine. The figures are unaffected, because live and rolled-up parts
compose exactly (wire-formats §j.6); the setting only changes which source answers. Pass `--keep-live-budget` to leave
the setting alone; the seed then writes as many engine events as each window needs.

**What a running jobs service changes.** `trust_scoring` recomputes D-1 and D-3 from the seeded edge counters, so
those two days may differ from the seeded scores; the spike is 12 days back and stays. `web_rollup` re-derives the same
totals from the engine rows. `contract_verification` has no Horizon or RPC on a local stack and leaves the demo
contracts alone. Audit rows are written only for the API calls; the direct DB writes are not audited, the same as the
test seeds.

## Privacy

No IP address, User-Agent, request header, query string, page title, secret seed or end-user address appears anywhere
in the generated data; a test scans the generated SQL. The only Stellar accounts stored are the demo owners' own keys
(project-owned, stellar_account evidence and sign-in identities) and the demo viewer's and operator's sign-in identities. Contract
ids are project-owned and synthetic.

## Reset

`--reset` (`make demo-seed-reset`) signs in as each demo owner and removes the project through the API. The project
becomes `removed`, and the `tenant_purge` job purges it, with its engine data, after the grace period. Until then its
slug stays taken, so a re-seed needs a fresh stack: `make down` with `-v`, then `make up`. A re-run *without* a reset
is always safe: it keeps the projects and replaces every derived row.

## Files

- `seed.ts`: the command. It runs the API phase, then the SQL phase, then the API follow-ups (annotation, snapshots),
  then the engine phase.
- `sign.ts`: SEP-53 signatures for the portal's "any wallet" sign-in.
- `src/plan.ts`: the cohort table.
- `src/traffic.ts`: sessions and events, and the rollup rules of `services/jobs/src/rollup`.
- `src/derived.ts`: trust (algorithm `trust/1.0.0`), edge counters, wallet-event rows, API rows and histograms,
  assurance and on-chain counts.
- `src/sql.ts`: builds the scf script.
- `src/umami.ts`: builds the engine script.
- `src/api.ts`: the API client.
- `src/psql.ts`: the psql runner.
- `src/stellar.ts`: StrKey and demo keys.
- `src/random.ts`: the seeded randomness.
- `test/seed.test.ts`: unit tests.
