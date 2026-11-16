# `services/jobs` — scheduled jobs

Node.js 24 / TypeScript, runtime dependencies `pg` and the workspace package `@usagemap/umami-adapter` (bundled). Spec: `docs/data-model.md` §6.3 (named jobs), §8.9 (web
rollups, live window), §10 (partitions), §14 (retention), §16 (the `umami` database); `docs/contracts/wire-formats.md`
§j.5–§j.6, §m, §p; register C-54, C-73, C-103, C-109, C-110, C-112, C-115, C-135, C-136, C-137 (daily seal,
footprint contracts, cohort vocabularies, ledger files primary).

| Job | Schedule (UTC) | What it does |
|---|---|---|
| `partitions` | hourly at :MM (`SCF_JOBS_HOURLY_MINUTE`, default :05) | `scf.ensure_partitions()` (ahead, RLS forced, parent policies, no grants) and `scf.drop_expired_partitions()` |
| `retention` | hourly at :MM+20 | `scf.retention_apply()` for every `delete` rule of job `retention` (C-136/C-137: `web_dev_events` after 24 hours; `footprint_items` rejected, removed or never verified 30 days after rejection, removal or claim); rejected or removed footprint ACCOUNT items (`G…`) at the next run (`purgeUnprovenFootprint`; the data-inventory scanner allows exactly verified accounts and open claims under 30 days), one tenant per transaction under its context (F1); `scf.erasure_redact_selectors()` (C-88, 56 days); Umami event-level pruning (`revenue`, `event_data`, `website_event`, `session_data`, `session_link`, orphaned `session`; every Umami table with `website_id`+`created_at` is classified in `UMAMI_TABLES` and checked by a contract test) per site on main and twin websites (`LEAST(COALESCE(event_retention_days,395), web_event_retention_days)`, default 90 days, batches of 10,000) as `scf_umami_maint`; audit `retention.umami_pruned` with counts per pruned tenant |
| `stream_gc` | daily 03:30 (`SCF_STREAM_GC_DAILY_AT`) | the `stream_gc` rules of `scf.retention_rules()` |
| `tenant_purge` | hourly at :MM+10 | C-08/C-64: removed tenants past `purge_after`, found through `scf.job_queue` (no cross-tenant read); per tenant ONE transaction under its context that locks the tenant row (a restore waits and is then refused), writes tombstones through `scf.write_removal_tombstones` (verified hosts, owners' GitHub ids, valid Stellar accounts; idempotent, a lifted tombstone stays lifted), purges the engine through `packages/umami-adapter` via the engine proxy with the provisioner certificate (visit-token purge on every core first, P13 + P9 for main and twin websites, P13 + P11), releases host claims, deletes every row of the 36 tables whose `jobs_delete` policy names `tenant_purge` (children first; C-136 adds `web_dev_events`, `web_event_property_daily`, `seal_leaves`, `footprint_items` — a purged tenant's seal leaves go, the days' roots stay), sets `purged_at`, audit `tenant.purged` (counts only); a failed purge rolls back and is audited as `tenant.purge_failed` (error class only) in its own transaction. Keeps tenant row, audit chain and tombstones. Idempotent and restartable |
| `durability_reconcile` | daily 02:00 (`SCF_DURABILITY_DAILY_AT`) | C-76: per edge node and day from `edge_spool_accounting` (`queued_start + fsynced = acked_* + expired_72h + queued_end`) → `balanced` / `loss` / `unaccounted` (restart window, surplus, reports missing after 24 h) / `pending`; canary check per probe source (Prometheus `sum by (source) (increase(scf_probe_canary_accepted_total[1h]))` vs Umami page views of `/canary/<source>/…` on the canary tenants' main websites via `scf_ro`), shortfalls inside 72 h `pending`; upserts `durability_reports` for D-1 and re-checks pending days up to D-4; gauges `scf_durability_reports{kind,status}`, `scf_durability_shortfall_records{kind}` |
| `registry_sync` | daily 04:00 (`SCF_REGISTRY_SYNC_DAILY_AT`) | §8.5: Stellarlight `/api/projects/search?scfAwarded=true` and PG Atlas `/projects` (+ details only when `updated_at` changed) → `registry_projects` with provenance and a content hash over the stable fields; the SCF cohort vocabularies of wire-formats §i.4 (C-136): `scf_categories` from the category label, `award_stage` from the tranche label (PG Atlas `scf_tranche_completion`), `award_round` = the latest numbered award round (Stellarlight; PG Atlas states submissions, not awards) — labels outside the closed lists stay empty, nothing is inferred; `registry_sync_runs` per source (failed / suspicious when > 20 % of rows vanish — then nothing is marked missing); links by verified host (equal or subdomain at a label boundary) → auto-confirmed, or verified contract → candidate; never name or GitHub org (C-20); operator decisions kept; `registry_match` evidence for confirmed links to awarded rows, lapsed after 14 days missing; audits `registry.synced`, `verification.evidence_lapsed` |
| `contract_verification` | daily 05:00; every 5 min for items whose `next_check_at` is due (C-136) | C-19 / Registered Footprint (data-model §12.1; contracts only — accounts and WASM hashes are not checked yet): a declared contract on this deployment's network is `verified` (method `deployer_admin_match`) when a tenant account with valid `stellar_account` evidence is its deployer (Horizon create-contract operations + CAP-46 id) or current admin (Stellar RPC instance storage, `SCF_STELLAR_RPC_URL`); with verified accounts but no match it is `rejected` (`not_found_on_ledger` — no live instance — or `not_deployer_or_admin`, audit `footprint.item_rejected`) — only on a definite ledger answer: a deployer look-up that did not cover the account's whole life (page bound of 500 × 200 operations, or a bounded Horizon history without the account's creation) or a missing RPC is `undetermined` and changes nothing; a deployer-based verification stands while its evidence is valid (the deployer never changes); a lost verification is audited as `verification.contract_unverified`; a rejected claim is re-checked only on demand (`next_check_at`); an operator's `claimed_by_other_tenant` stands. Conflicts (C-137): a contract verified for two or more tenants gets `conflict_since` on every item (cross-tenant read, writes per tenant) and is counted nowhere; the flag is cleared when no verified twin remains; ledger outage changes nothing |
| `trust_scoring` | daily 03:00 | ADR-0028 / C-44 / CR-35: `web_trust_scores` (windows 1 and 28) for D-1 and D-4 (the final rollup) with algorithm `trust/1.0.0` (src/trust/algorithm.ts: thresholds, worked examples in test/unit/trust.test.ts; weights and version from settings), NULL + `insufficient_data` below `op_min_count`, burstiness from the day's `web_hourly_totals`; `api_service_assurance` A0–A1 (A1-1.0.0), A2 needs a probe this service does not run, A3 badge |
| `audit_anchor` | daily 00:15 (`SCF_AUDIT_ANCHOR_DAILY_AT`), retried hourly at :MM+15 | C-63, wire-formats §m.1: chain heads as of D+1 00:00 → `audit-anchors/<D>.json` in `SCF_AUDIT_ANCHOR_DIR` (written with link(2): never overwritten, whatever state an existing file is in); every run anchors EVERY day missing since the first published one (at most 400 days back), so a failed run never stops `daily_seal`; audit `audit.anchored` per day written. The document's sha256 is the audit leaf of the day's seal. The per-day `manage_data scf-audit-<YYYYMMDD>` publisher is withdrawn (C-136: superseded by `daily_seal`; `SCF_AUDIT_ANCHOR_STELLAR_*` is no longer read and logged as `setting_ignored`); entries written before stay verifiable (`manageDataAnchorName`/`manageDataAnchorMatches` in `src/stellar/tx.ts`) |
| `daily_seal` | daily 00:30 (`SCF_SEAL_DAILY_AT`) and hourly at :MM+25 | C-136/C-137, wire-formats §m.2 (src/seal/): builds every missing day up to D−1 in ascending order (the first run starts at D−1): the day's anchor document (a missing one stops the run at that day; alertable when older than D−1), the previous day's root, salted leaves of every signed snapshot of a `seal_enabled` tenant without a final leaf; deletes the day's provisional leaves, writes each tenant's `seal_leaves` under its context, then the `seal_days` row (`built`, `head_path`, `segment`) with audit `seal.published`; with a key, submits one transaction per day in day order — `BUMP_SEQUENCE` to 0, `MEMO_HASH(root)`, base fee, 5-minute time bounds (the hash is stored before the POST and looked up after a lost answer) → `confirmed` + `seal.published`; `failed` 24 h after building (testnet: final; mainnet: resubmitted). Testnet reset, only on proof (a ledger numbered below the newest confirmed day's that closed after its confirmation, or that day's ledger closing at another time) seen again ≥ 50 minutes later; no day is built meanwhile; a lagging, catching-up or bounded Horizon proves nothing → confirmed days become `network_reset`, the same key is funded through friendbot, the next built day starts `segment` + 1; a mark the network later contradicts is reverted day by day. Daily (not hourly) the seal history walk (src/seal/verify.ts) reads the sealing account's whole transaction history and compares it with every stored day (`chain_break`, `root_mismatch`, `memo_mismatch`, `ledger_mismatch`, `confirmed_tx_missing`, `unknown_seal_tx`, `out_of_order`): metric `scf_seal_history_problems`, run fails on any. Without `SCF_SEAL_SECRET_FILE` days are built, nothing is submitted. Tamper-evidence of published numbers, never proof they are genuine |
| `audit_verify` | daily 00:45 | recomputes every chain (canonical text v2 computed in TypeScript, equal to `scf.audit_canonical`), checks hashes, links, sequence and the latest published anchor; gauge `scf_audit_chain_problems`; audit `audit.verified`; fails when anything is broken |
| `web_rollup` | hourly at :MM+5 (today; the previous day until 02:00) and daily 01:30 (`SCF_WEB_ROLLUP_DAILY_AT`: D-1, D-2, D-3, and D-4 final — the spool delivers up to 72 h after receipt) | per site and UTC day, in one transaction under the tenant's context that holds the tenant's erasure fence shared (`ERASURE_FENCE_KEY_SQL`; the erasure worker holds it exclusive across its Umami and scf deletes, so a rollup never writes back erased data; a fenced site-day is deferred, not failed): `web_daily_totals` (upsert), the day's `web_hourly_totals`, `web_daily_breakdowns` (top-N of both variants) — read from Umami only through `scf_ro` as `scf_umami_ro`; every run also catches up days of the last 7 that were never rolled or never finalised |
| `onchain_correlation` | daily 06:00 (`SCF_ONCHAIN_DAILY_AT`) | ADR-0028 / C-42 / C-128 / C-136 (`ledger_files` is the PRIMARY source; a complete `ledger_files` day replaces a `hubble` row, never the reverse). Step 1, fetch (wire-formats §p.1): `onchain-reader fetch -source SCF_ONCHAIN_LEDGER_SOURCE_URL -dest SCF_ONCHAIN_LEDGER_DIR -from-day -to-day -network <passphrase>` for the days the count still needs (exit 1: the count stores complete days only and the run fails; other exits stop the run). Step 2, count: runs `services/onchain-reader` (built into this image at `/usr/local/bin/onchain-reader`) over the read-only local mirror `SCF_ONCHAIN_LEDGER_DIR` for the verified, not removed declared contracts without an open footprint conflict (`conflict_since`, C-137) on `SCF_STELLAR_NETWORK` of tenants with `onchain_correlation_enabled`; the days of the last `SCF_ONCHAIN_LOOKBACK_DAYS` (3) that still lack a row are read in one run (contracts on stdin, strict line parser, timeout, output bound); only days the reader marks `complete` (contiguous ledgers and both neighbouring boundary ledgers seen) are upserted into `onchain_daily`, one transaction per tenant under its context, replacing a `hubble` row; partial days are retried next run (`scf_job_units_total{outcome="day_incomplete"}`); before a complete day is used its anchor (the first ledger after the day, whose hash commits through the reader's verified chain to the whole day) is compared with Horizon `GET /ledgers/{seq}` (`SCF_ONCHAIN_HORIZON_URL`, default `SCF_HORIZON_URL`; C-144): a mismatch refuses the day, logs `onchain_anchor_mismatch`, sets `scf_onchain_anchor_mismatch_days` (alert `OnchainLedgerAnchorMismatch`) and fails the run (`OnchainAnchorMismatch`); a Horizon that cannot answer leaves the day unused and retried (`scf_onchain_anchor_unverified_days`, `OnchainAnchorUnverified`); the run fails when the window's oldest day is still missing (it would never be retried). Logs carry counts and days only — invokers never leave the reader. Without `SCF_ONCHAIN_LEDGER_DIR`, or without a Horizon for the anchor check, the job is `job_disabled`; only on testnet may `SCF_ONCHAIN_LEDGER_HASH_CHECK=off` skip the check (the synthetic development lake of `compose.dev.yaml` has no network to compare with; logged `onchain_anchor_check_off`). Without `SCF_ONCHAIN_LEDGER_SOURCE_URL` on testnet (or with `none`) the mirror is filled outside this service; the mirror must be writable for the fetch step |

**Core workers moved from the control plane.** The internet-facing control plane runs no
background work and holds no signing key, scf_jobs or scf_umami_maint credential: this service starts the workers of
`@usagemap/control-plane/workers` (their code and tests stay in that package, which shares the data layer) in
the same process, each with its own small scf_jobs pool and LISTEN session. The control plane hands work over with
NOTIFY at commit.

| Worker | Wake-up | What it does | Credentials only this container holds |
|---|---|---|---|
| `edge_snapshot` | every 10 s, `NOTIFY scf_edge` | builds and signs the edge snapshot (wire-formats §e; `expires_at` = issued_at + `SCF_EDGE_SNAPSHOT_MAX_AGE_S`, re-issued after a quarter of it, F12) | `SCF_EDGE_SIGNING_KEY` |
| `umami_reconcile` | 5 min, `NOTIFY scf_umami` | tenant teams/users/keys, websites P7/P7t, orphans, key rotation; reports websites outside the tenant's team (`misplaced`) | provisioner certificate + admin password, `SCF_UMAMI_CREDS_KEYS` (encrypt) |
| `domain_verification` | 5 min, `NOTIFY scf_verify` | DNS/HTTPS domain checks (egress) | — |
| `erasure` | 60 s, `NOTIFY scf_erasure` | erasure requests (preview, execution, spool sweep) | `SCF_UMAMI_MAINT_URL` (shared with `retention`) |
| `public_metrics` | hourly | metrics_endpoint documents; signs traction snapshots v1 and v2 (C-136: series, methodology, pasteable text, open anomaly-flag counts) | — |
| `traction_snapshot_sign` | 30 s, `NOTIFY scf_snapshot` | computes and signs pending traction snapshots (migration 0060) | `SCF_SNAPSHOT_SIGNING_KEY` |

Settings: `src/workers/config.ts` of the control plane (`SCF_JOBS_LISTEN_DATABASE_URL`, `SCF_CORE_WORKERS` to pick a
subset, `SCF_EDGE_SIGNING_KEY[_FILE]`, `SCF_EDGE_SIGNING_KID`, `SCF_EDGE_SNAPSHOT_MAX_AGE_S` (86400),
`SCF_TRACKER_MANIFEST_DIR`, `SCF_TRACKER_RELEASES_FILE`, `SCF_ENGINE_PROXY_READER_CERT/KEY`, `SCF_UMAMI_CREDS_KEYS`,
`SCF_PORTAL_ORIGIN`, `SCF_SNAPSHOT_SIGNING_KEY[_FILE]`, `SCF_SNAPSHOT_KID`, intervals). The scf_jobs and
scf_umami_maint URLs are this service's own (passwords from their files). A worker without its settings is logged once
as `core_worker_disabled`; each pass counts in `scf_job_runs_total{job,outcome}`. `/metrics` also carries
`scf_cp_verifier_blocked_targets_total{class}` from the domain verifier.

**Single instance.** Each run holds `pg_try_advisory_xact_lock(hashtextextended('scf.jobs/<job>', 0))` in a
transaction that stays open on a dedicated connection for the whole run (works through PgBouncer in transaction
mode; released by COMMIT or by the server if the connection dies, which also aborts the run). Two instances may run
side by side; the second records `skipped_locked`. **Fencing** (src/lock.ts): every scf transaction of a
run first takes `hashtextextended('scf.jobs-fence/<job>', 0)` shared and checks in `pg_locks` that the run's lock is
still granted to its lock connection's backend (else `JobLockLost`, nothing written); a new holder takes the fence key
exclusive once before its run starts (waits for the old holder's in-flight transactions, `lock_timeout` 60 s). So no
write of a run that lost its lock commits after the next run began.

**Context.** Every unit of work is one transaction that starts with `scf.set_tenant_ctx(p_tenant, 'job', <job>,
p_job => <job>)`; cross-tenant reads with the tenant unset, every write and delete under the target tenant.

**Privacy.** Logs are JSON lines whose values are numbers, booleans or short identifiers; anything resembling an IP,
URL, query string, e-mail, user agent or Stellar key is replaced by `{redacted}`; errors are logged by SQLSTATE and
constraint, never by message. Metric labels are job names and fixed words.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCF_JOBS_DATABASE_URL[_FILE]` | — (required) | `scf` as `scf_jobs`, through PgBouncer |
| `SCF_JOBS_DB_PASSWORD_FILE` | — | overrides the URL's password |
| `SCF_UMAMI_RO_URL[_FILE]`, `SCF_UMAMI_RO_PASSWORD_FILE` | required with `web_rollup` | `umami` as `scf_umami_ro` |
| `SCF_UMAMI_MAINT_URL[_FILE]`, `SCF_UMAMI_MAINT_PASSWORD_FILE` | required with `retention` | `umami` as `scf_umami_maint` |
| `SCF_JOBS_LISTEN_HOST`, `SCF_JOBS_PORT` | `0.0.0.0`, `8080` | `GET /healthz`, `/readyz`, `/metrics` |
| `SCF_JOBS_ENABLED` | all jobs whose requirements are met (others logged as `job_disabled`) | comma-separated subset; a named job without its requirements is a configuration error |
| `SCF_JOBS_RUN_ON_START` | `true` | run every job once at start |
| `SCF_JOBS_HOURLY_MINUTE` | `5` | 0–54 |
| `SCF_WEB_ROLLUP_DAILY_AT`, `SCF_STREAM_GC_DAILY_AT` | `01:30`, `03:30` | HH:MM UTC |
| `SCF_ENGINE_VERSION` | `umami/3.5.0` | stamped on `web_daily_totals` |
| `SCF_JOBS_SHUTDOWN_GRACE_MS` | `30000` | SIGTERM: running jobs stop at their next unit boundary |
| `SCF_JOBS_NODE` | hostname | node name in logs |
| `SCF_ENGINE_PROXY_URL`, `SCF_ENGINE_PROXY_URLS` | — | `tenant_purge`: this core's engine proxy; every core's (visit-token purge; default: the first) |
| `SCF_ENGINE_PROXY_CA[_FILE]`, `SCF_ENGINE_PROXY_PROVISIONER_CERT[_FILE]`, `…_KEY[_FILE]` | — | `tenant_purge`: CA and a client certificate with OU `provisioner` |
| `SCF_UMAMI_PROVISIONER_USER[_FILE]`, `SCF_UMAMI_PROVISIONER_PASSWORD[_FILE]` | — | `tenant_purge`: the provisioning admin (P1) |
| `SCF_DURABILITY_DAILY_AT`, `SCF_DURABILITY_PROMETHEUS_URL`, `SCF_DURABILITY_CANARY_LAG_HOURS` | `02:00`, —, `72` | canary check only with the Prometheus URL (needs `SCF_UMAMI_RO_URL`) |
| `SCF_REGISTRY_SOURCES`, `SCF_REGISTRY_STELLARLIGHT_URL`, `SCF_REGISTRY_PG_ATLAS_URL`, `SCF_REGISTRY_MAX_DROP_PERCENT`, `SCF_REGISTRY_SYNC_DAILY_AT` | —, `https://stellarlight.xyz`, `https://api.pgatlas.xyz`, `20`, `04:00` | `registry_sync` (egress, C-10) |
| `SCF_HORIZON_URL`, `SCF_STELLAR_RPC_URL`, `SCF_STELLAR_NETWORK`, `SCF_CONTRACT_VERIFICATION_DAILY_AT` | —, —, `public`, `05:00` | `contract_verification` (egress); admin check only with the RPC URL |
| `SCF_TRUST_SCORING_DAILY_AT` | `03:00` | `trust_scoring` |
| `SCF_ONCHAIN_LEDGER_DIR`, `SCF_ONCHAIN_READER_BIN`, `SCF_ONCHAIN_DAILY_AT`, `SCF_ONCHAIN_LOOKBACK_DAYS`, `SCF_ONCHAIN_READER_TIMEOUT_S` | —, `/usr/local/bin/onchain-reader`, `06:00`, `3` (1–30), `3600` | `onchain_correlation` (absolute paths; network from `SCF_STELLAR_NETWORK`) |
| `SCF_AUDIT_ANCHOR_DIR`, `SCF_AUDIT_ANCHOR_DAILY_AT`, `SCF_AUDIT_VERIFY_DAILY_AT` | —, `00:15`, `00:45` | `audit_anchor` (file publisher), `audit_verify` (reads the latest file anchor), `daily_seal` (reads the day's anchor) |
| `SCF_SEAL_HORIZON_URL`, `SCF_SEAL_NETWORK`, `SCF_SEAL_NETWORK_PASSPHRASE`, `SCF_SEAL_RPC_URL`, `SCF_SEAL_FRIENDBOT_URL`, `SCF_SEAL_SECRET_FILE`, `SCF_SEAL_MAINNET_APPROVED`, `SCF_SEAL_DAILY_AT`, `SCF_SEAL_FEE_STROOPS` | —, `testnet` (or the network the passphrase names; the two must agree; only the testnet and mainnet passphrases), that network's passphrase, —, `https://friendbot.stellar.org` (testnet only; refused on mainnet), — (build only), — (`1` required for `mainnet`, also when only the passphrase names it, C-135), `00:30`, `100`; every URL https only | `daily_seal` (needs `SCF_AUDIT_ANCHOR_DIR` too); the key only from a file, never logged |
| `SCF_ONCHAIN_HORIZON_URL`, `SCF_ONCHAIN_LEDGER_HASH_CHECK` | `SCF_HORIZON_URL`, `on` (`off` accepted on testnet only) | `onchain_correlation` day-anchor check against Horizon `/ledgers/{seq}` (C-144) |
| `SCF_ONCHAIN_LEDGER_SOURCE_URL`, `SCF_ONCHAIN_FETCH_TIMEOUT_S` | `https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet` on `public`, none on `testnet` (`none` turns the fetch off; https only), `21600` | `onchain_correlation` fetch step (§p.1) |

Known limits: if the engine purge succeeded and the scf transaction then failed, the engine data is gone
while the tenant is still `removed` until the next run completes the purge (the failure is audited as
`tenant.purge_failed`). A2 (liveness probe)
is not produced by this service. `contract_verification` misses factory deployments and admins kept outside the
instance storage. `registry_sync` matches hosts and their subdomains instead of PSL eTLD+1 (no PSL dependency).

Connections: `scf` pool ≤ 3 plus one lock connection per running job (≤ 4), core workers ≤ 13 through PgBouncer plus five direct LISTEN sessions; `umami` ≤ 2 (ro) + 1 (maint) + 2 (erasure).

## Tests

```sh
pnpm --filter @usagemap/jobs test:unit          # no Docker
pnpm --filter @usagemap/jobs test:integration   # Docker; projects scf-wsg (56260–56262) and scf-wsg-eng (real
                                                      # engine proxy + Umami, 56265–56266; started by tenant-purge.test.ts);
                                                      # in-process fakes on 56267–56274 (Prometheus, registries, Horizon,
                                                      # RPC, the seal's Horizon + friendbot); every project name and port
                                                      # can be moved with SCF_WSG_* variables (test/support/global-setup.ts)
SCF_SEAL_LIVE=1 pnpm --filter @usagemap/jobs test:unit  # + one live seal transaction on Stellar testnet (friendbot key)
# onchain.test.ts builds services/onchain-reader with the Go toolchain (mise) and writes a fixture ledger lake with
# its internal/fixture/lakegen
KEEP=1 …  /  SCF_WSG_REUSE=1 …                         # keep / reuse the stack
docker build -f services/jobs/Dockerfile -t usagemap/jobs:dev .
```

The integration stack is PostgreSQL 18.6 with `db/migrate.sh migrate` (gates on), `usagemap/umami-migrate:3.5.0-d3c62a8`,
`db/migrate.sh umami-views`, PgBouncer 1.26.1 (transaction mode) and `usagemap/umami:3.5.0-d3c62a8`. The rollup test sends
a fixture day through Umami's `/api/send` and compares every stored figure with Umami's own `/stats`,
`/metrics/expanded`, `/metrics?type=event` and `/pageviews?unit=hour` answers (raw and `tag=v`).
