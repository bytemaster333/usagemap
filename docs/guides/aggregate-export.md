# Aggregate-only export (ops.end-of-window-read-only)

**Status: built and tested** (`services/control-plane/test/integration/aggregate-export.test.ts`); run once on migrated
data in the handover drill of 2026-11-18 (15 files, 295,026 rows, every hash matched the manifest,
[`../evidence/handover-drill-2026-11-18.md`](../evidence/handover-drill-2026-11-18.md)). Decision: register C-142(9).

This is the export for the case where no successor service operator takes over when a deployment shuts down
([`../handover-plan.md`](../handover-plan.md) §10.1, step 1): every tenant's **aggregate** figures as a documented,
versioned bundle that the programme owner or anyone entitled can keep, read and check without UsageMap's software. It never contains event-level data.

## 1. What the bundle is

Bundle format `usagemap-aggregate-export`, version **1.0.0**. One directory:

- one [JSON Lines](https://jsonlines.org/) file per table — one JSON object per row, keys in the documented column order;
- `manifest.json` — format and version, generation time, the database and server version, the consistency statement,
  the privacy rules applied (with the `min_count` and `round_to` values in force), what was excluded, and per file:
  row count, SHA-256 and the column schema (name, type, description).

| File | Content |
|---|---|
| `tenants.jsonl` | projects whose figures are in the bundle |
| `sites.jsonl` | websites of the projects |
| `api_services.jsonl` | API services of the projects |
| `declared_contracts.jsonl` | declared Stellar contracts and their verification state |
| `web_daily_totals.jsonl` | web totals per website and UTC day (exact) |
| `web_hourly_totals.jsonl` | web totals per website and UTC hour (exact) |
| `web_daily_breakdowns.jsonl` | top values per dimension and UTC day, small-count floor applied |
| `web_wallet_events_daily.jsonl` | wallet-event counts per day, small-count floor applied |
| `web_trust_scores.jsonl` | advisory trust scores per website and day (algorithm version per row) |
| `api_routes.jsonl` | normalised API route templates (the key of the API metric files) |
| `api_metrics_1h.jsonl`, `api_metrics_1d.jsonl` | self-attested API telemetry per hour / day, route, method, status class and source, with the latency histogram |
| `api_service_assurance.jsonl` | API assurance level per service and day |
| `onchain_daily.jsonl` | on-chain figures per verified contract and UTC day (invoker addresses are never stored) |
| `traction_snapshots.jsonl` | the signed traction snapshots (verifiable offline against the published JWKS) |

The authoritative list, with every column, is `FILES` in `services/control-plane/scripts/export-aggregates.ts` and
the `manifest.json` of each bundle; this table is a summary.

## 2. What it never contains

- No engine (Umami) table, no individual event, session or visitor, no IP address, User-Agent, query string or page
  title; no dev events, spool records or audit details.
- No people: no user accounts, members, e-mail addresses, end-user wallet addresses, credentials, keys or tokens.
- Removed and purged tenants, synthetic canary tenants and websites being purged are excluded.
- Breakdown rows and wallet-event counts below the platform's small-count floor (`op_min_count`) are omitted and
  counts are rounded to `op_round_to` (ADR-0027, C-95).

Contents are chosen by an allow-list of tables **and** columns; anything not listed is never read.

## 3. Run it

The export reads across tenants, so it connects with a role that bypasses row-level security — the backup login
(`scf_dump_login`, read-only by design, ADR-0013); no new database role exists for it (C-143). Everything runs in one
`READ ONLY, REPEATABLE READ` transaction, so all files are one consistent snapshot. Run it on the operator's own
infrastructure, never on a GitHub-hosted runner (C-56).

Freeze writes first (§4), then:

```sh
eval "$(mise env -s bash)"
cd services/control-plane
SCF_EXPORT_DATABASE_URL='postgres://…'  pnpm run export:aggregates --out /srv/export/usagemap-$(date -u +%F)
# equivalent: node scripts/export-aggregates.ts --out <empty or new directory>
```

The output directory must be new or empty; files are created with mode `0600` and never overwritten.

## 4. Freeze writes: the read-only switch

The platform's read-only mode (setting `read_only_mode`, C-142(8)) is switched by an `operator_admin` with a fresh
sign-in, audited as `settings.updated`:

```http
PATCH /v1/operator/settings/read_only_mode
Content-Type: application/json

{"value": {"enabled": true, "ingest": "pause"}}
```

- `enabled: true` — every write answers `403` "the platform is in read-only mode", except sign-in, data-subject
  rights (erasure), removals, revocations and the switch itself. The portal shows a banner. It takes effect on every
  control-plane instance within 5 seconds.
- `ingest: "pause"` — the edge snapshot publishes every tenant as suspended, so the gateways accept nothing new
  (counters then say `tenant_suspended`); `"accept"` keeps ingest running while the control plane is frozen.
- Switch back with `{"value": {"enabled": false, "ingest": "accept"}}`.

## 5. Check a bundle

For every entry of `manifest.json` → `files`, the file's SHA-256 must equal `sha256` and its line count `rows` (the file name is `name`):

```sh
cd /srv/export/usagemap-YYYY-MM-DD
jq -r '.files[] | "\(.sha256)  \(.name)"' manifest.json | sha256sum -c -
jq -r '.files[] | "\(.rows) \(.name)"' manifest.json | while read -r n f; do [ "$(wc -l < "$f")" -eq "$n" ] || echo "row count differs: $f"; done
```

Publish the manifest's own SHA-256 through a separate channel (for example in the hand-over record), so a reader can
tell that the bundle was not replaced as a whole.

## 6. Versioning

A change that removes or renames a file or column, or changes a column's meaning, is a new **major** version of the
bundle; adding a file or column is a minor version. The version is in every manifest.
