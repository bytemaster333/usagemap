# Runbook: Umami upgrade

Status: exercised 2026-11-14 (no-op upgrade: pin check, hardening check, stop/start chain under load) — see the drill log
Owner: maintainers
Last reviewed: 2026-11-14

Umami runs **unmodified**, built by us from a pinned commit, never reachable from the internet (ADR-0002, ADR-0003,
C-104). Current pin: v3.5.0, commit `d3c62a805beda8643cb468924dda38617fb4c286` (`vendor/umami/UPSTREAM`). The upgrade
recipe is `vendor/umami/README.md` "Upgrading the pin"; this runbook adds the operational order and checks.
Security-driven upgrades also follow `security-patch-24h.md` (and may use the patch queue `vendor/umami/patches/`
instead of a new upstream commit).

## 1. Prepare (in a branch)

1. Read the release's changelog and advisories; note schema migrations, new API routes and changed environment
   variables.
2. Update `vendor/umami/UPSTREAM` (tag, commit, `IMAGE_TAG`) and the two `ARG` defaults in `vendor/umami/Dockerfile`;
   adjust the pnpm pin if upstream's `packageManager` changed.
3. Run, in this order:
   - `vendor/umami/scripts/verify-pin.sh` (no Docker);
   - `vendor/umami/test/hardening-check.sh` (builds both images, 40 checks — one, the dashboard check, is skipped
     unless `PW_DIR`/`CHROMIUM_PATH` point to Playwright; own project `PROJECT` (default `scf-umami-test`) and port
     `UMAMI_TEST_PORT` (default 56122): read-only root, no capabilities,
     internal network, no outbound connection, migrations only in the one-shot, blocked routes);
   - `services/engine-proxy/integration/run.sh` (visit rule, gate, deny-list on the real engine) — or `make test-engine`
     for all three;
   - the adapter contract tests in `packages/umami-adapter` (`pnpm --filter @usagemap/umami-adapter test:contract`, against the real engine);
   - the jobs integration test (rollups compared figure by figure with Umami's own answers,
     `pnpm --filter @usagemap/jobs test:integration`) — it also exercises the `scf_ro` views.
4. Compare the new release's `src/app/**/route.ts` with the engine proxy's allow-lists
   (`services/engine-proxy/internal/policy`): new routes are refused by default, but any new side door (share, batch,
   recorder, MCP, login, scripts…) must be added to the **one deny-list** (`docs/contracts/wire-formats.md` §c.5,
   C-112(11)).
5. Re-check the hardening variables the image must never set (`vendor/umami/README.md`) against the new release's
   environment handling.

## 2. Deploy

The schema migration is a one-shot step, never run by the Umami container itself (`SKIP_DB_MIGRATION=1`, C-40). The
`scf_ro` views over Umami's tables (read by the `web_rollup` job) must be dropped before the migration and recreated
after it (data-model §16.3, C-112(12)). `docker compose up` always runs the chain in this order:

```
umami-views-drop  →  umami-migrate (prisma migrate deploy as umami_app)  →  umami-views  →  umami
```

Local stack: `docker compose -f infra/compose/compose.yaml up -d --build --wait`. **Never run `umami-migrate` alone**
(`infra/compose/README.md`, "Umami upgrade blocked by a view").

`umami` depends on `umami-views` (which depends on `umami-migrate`, which depends on `umami-views-drop`), so starting
Umami by itself — `docker compose up umami`, `docker compose start umami`, or a recreate after an image change — runs
the whole chain and recreates the views before Umami starts. Before this order (C-121) a restart of Umami alone
re-ran the drop and the migration but not `umami-views`, leaving `web_rollup` without its views. A plain
`docker compose restart umami` restarts only the container and runs no migration. Check after any restart:
`$DC ps -a umami-views` shows `exited (0)` with a fresh timestamp
(`docker inspect -f '{{.State.FinishedAt}} {{.State.ExitCode}}' $($DC ps -aq umami-views)`), and the schema `scf_ro`
exists (`SELECT count(*) FROM information_schema.views WHERE table_schema = 'scf_ro'` in the `umami` database: 2).

Production (planned, multi-node): one core at a time is not possible for the schema step — the migration runs once
against the shared database. Order: stop the `web_rollup` job (or let it skip on the missing views), run the chain
once, then roll the `umami` containers on both cores. Events wait in the edge spools while Umami is down (≤ 72 h),
so a short stop costs freshness, not data.

## 3. Verify

- `infra/compose/scripts/smoke.sh` (bootstrap re-run is a no-op, an event is accepted, a replayed event joins
  the same visit, allow-/deny-lists hold, no personal data in logs).
- Engine proxy gate open (`scf_engine_proxy_bootstrap_gate_open == 1`) and `scf_gateway_forward_total` back to
  `delivered`.
- The next `web_rollup` run succeeds (`scf_job_runs_total{job="web_rollup",outcome="success"}`) and
  `engine_version` on new `web_daily_totals` rows shows the new version (`SCF_ENGINE_VERSION`).
- Dashboards: live figures for today match the previous behaviour (visits, bounce rate) — Umami changes to visit or
  bot logic change our numbers; record any such change in the metric definitions and annotate the day.

## 4. Roll back

Prisma migrations are forward-only. Roll back by restoring the database to the point before the migration (backup and
restore runbooks: [`restore-pitr.md`](restore-pitr.md), [`restore-logical-dump.md`](restore-logical-dump.md)) together with the previous image tag; events accepted meanwhile are still in
the spools only if they have not been acknowledged. Prefer fixing forward unless data is at risk.

## Nightly signal

Contract tests against upstream's newest tag (ADR-0003) are run by hand (`pnpm --filter @scf-analytics/umami-adapter test`
with the newer image); this runbook is triggered by releases or advisories (`vulnerability-response.md`).

## Drill

Rebuild the current pin from scratch and run sections 1.3 and 3 (a no-op upgrade); record it here and in `README.md`.

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | workstation + Compose project `scf-tg` (ports 56450–56452) and `scf-tg-umami` (port 56453), repository working tree | §1.3: `vendor/umami/scripts/verify-pin.sh`; `PROJECT=scf-tg-umami UMAMI_TEST_PORT=56453 vendor/umami/test/hardening-check.sh`. §2: under gateway probe traffic (~2 events/s), `$DC stop umami`, 10 s down, `$DC start umami` (runs `umami-views-drop` → `umami-migrate` → `umami-views` → `umami`). §3: smoke (see `app-secret-rotation.md`, same session) | **pass** — pin check pass (tag 3.5.0-d3c62a8 names the commit; Compose uses both pinned images); hardening 39 passed, 0 failed, 1 skipped (dashboard check: no Playwright path given); Umami unavailable ≈ 19 s (stop → healthy), `umami-views` re-ran (`exited 0`, new timestamp), `scf_ro` has its 2 views; 125 events accepted, 0 refused, 125/125 stored after the spool drained (61 forward attempts `core_failed` 502 while Umami was down, retried). **Not run** (concurrent agents were changing `services/jobs` and the engine-proxy suite uses the fixed project `scf-wsi-it`): `services/engine-proxy/integration/run.sh`, the adapter contract tests, the jobs integration test. |
