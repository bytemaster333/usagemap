# Runbook: end of the service window without a successor (ops.end-of-window-read-only)

Status: export exercised 2026-11-18 on migrated drill data (`tests/handover/run.sh` step `n-aggregate-export`);
the read-only switch and the hand-off to the steward not yet exercised
Owner: service operator (outgoing team); the steward receives the export
Last reviewed: 2026-11-18

**When:** the hosted service window ends and the steward (the organisation the hosted instance is run for) has not
appointed a successor operator. The documented default is a final aggregate export to the steward, a read-only freeze,
then shutdown on a date agreed with the steward. If a successor exists, use
[`handover-migration.md`](handover-migration.md) instead.

**Built (2026-11-18):** the setting `read_only_mode` = `{"enabled": true|false, "ingest": "accept"|"pause"}`
(migration `0070`): with `enabled`, every write is refused with `403` except sign-in, data-subject rights, removals,
revocations and the switch itself, and the portal shows a banner; with `"ingest": "pause"` the edge snapshot treats
every tenant as suspended, so gateways stop accepting events. The aggregate exporter
`services/control-plane/scripts/export-aggregates.ts` writes the bundle `usagemap-aggregate-export` 1.0.0: one JSON
Lines file per allow-listed aggregate table and `manifest.json` (rows, bytes, SHA-256 and column schema per file),
read in one `READ ONLY, REPEATABLE READ` transaction. It never reads event-level data, the engine (Umami), sessions,
users, keys, tokens or credentials; removed, purged and canary tenants are excluded; small counts that leave a project
get the platform floor (ADR-0027).

## 1. Notice (D−30)

- Tell tenants and the steward the dates: read-only from D0, export handed to the steward on D0 + 1 business day, shutdown date as
  agreed. Status page notice (Upptime issue, `ops/status/README.md`). Tenants who want their own raw data use the
  existing in-product exports and erasure before D0.

## 2. Switch to read-only (D0)

An `operator_admin` with a fresh passkey step-up, through the operator settings API
(`PATCH /v1/operator/settings/read_only_mode`, body `SettingUpdate` in `docs/api/control-plane.openapi.yaml`):

```json
{"value": {"enabled": true, "ingest": "accept"}}
```

Keep `"ingest": "accept"` until the export is taken if tenants should still see the last day; set `"pause"` before
the export so the export is final (no event arrives after it). Check: a tenant write answers `403` with "the platform
is in read-only mode", the portal shows the banner, and — with `pause` — the gateways stop accepting events once
they load the next edge snapshot (watch the accepted-event rate on the ingest dashboard fall to zero).

## 3. Export (D0)

On the application host, with a role that bypasses row-level security (the backup superuser), into a new directory:

```sh
SCF_EXPORT_DATABASE_URL='postgres://postgres:…@<db host>:5432/scf' \
  pnpm --filter @usagemap/control-plane export:aggregates -- --out /srv/scf/export/usagemap-aggregate-$(date -u +%Y%m%d)
```

Local stack or a host without the workspace: run the script in a Node 24 container on the database network, as
`tests/handover/run.sh` does (`node scripts/export-aggregates.ts --out <dir>` with the repository mounted read-only).

## 4. Verify (D0)

```sh
cd /srv/scf/export/usagemap-aggregate-<date>
jq -r '.format + " " + .version' manifest.json                      # usagemap-aggregate-export 1.0.0
jq -r '.files[] | "\(.sha256)  \(.name)"' manifest.json | sha256sum -c -   # every file: OK
ls | grep -vxF -f <(jq -r '.files[].name' manifest.json; echo manifest.json)   # must print nothing
sha256sum manifest.json                                              # → the value you send to the steward separately
```

Also check that row counts are plausible against the operator dashboards (tenants, sites, services) and that no
file outside the allow-list exists. Any mismatch: do not hand over; re-run the export into a new directory.

## 5. Hand to the steward (D0 + 1 business day)

- Transfer the directory (archive it with `tar`; encrypt it to the steward's age or PGP key if one is provided) over a
  channel the steward names. Send the SHA-256 of `manifest.json` through a **different** channel (e-mail plus the signed
  hand-off note), so the steward can check the bundle it received is the one made.
- The steward confirms receipt and a successful check in writing; file the confirmation in the private operations tracker.

## 6. Shutdown (agreed date)

- Final status-page notice; DNS: point the tracker hostnames at a static host that answers `410 Gone` for ingest
  and keeps serving the pinned tracker files, so tenant pages keep loading (SRI unchanged; analytics simply stops).
- Delete backups and the database after the retention the DPA states; record the deletion; keep `docs/evidence/`.
- Domains: let the steward decide transfer or expiry (handover plan §5.3; registrar renewal is prepaid past month 12).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-18 | handover drill, new operator's stack `scf-hob` on migrated DEMO data (`tests/handover/run.sh`) | §3–§4: exporter of the working tree run in `node:24.19.0-alpine3.23` on the database network; every file's SHA-256 checked against `manifest.json`; no unlisted file | **pass** — 15 files, 295,026 rows (`docs/evidence/handover-drill-2026-11-18.md`). Not exercised: the read-only switch (§2) — the drill's images were built from `main`, which predates the switch — and the hand-off (§5). |
