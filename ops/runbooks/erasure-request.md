# Runbook: erasure request handling

Status: exercised 2026-11-14 (tenant workflow through the API, Compose) — see the drill log
Owner: service operator (supports tenants); the tenant (controller) runs the request itself
Last reviewed: 2026-11-14

Design: `docs/privacy/erasure.md` (authoritative), ADR-0030, C-46, C-87, C-88 as corrected by C-111 and C-112(2).
Erasure concerns personal data that leaks into page paths, custom-event names and properties, and API routes;
no identifiers of visitors are stored (GDPR Art. 11 posture).

**Build state.** Built: the tenant-facing operations (`createErasureRequest` → preview, `confirmErasureRequest`,
`cancelErasureRequest`, `getErasureRequest`, `listErasureRequests`; handlers in `services/control-plane/src/erasure/`),
the portal page (project navigation → Data erasure, `/t/<tenant>/erasure`, `apps/portal/src/pages/Erasure.tsx`), the worker in the **jobs
service** (woken by `NOTIFY scf_erasure`, C-125), the operator list `GET /v1/operator/erasure-requests` (selector
type only, migration 0058) and the selector redaction in the `retention` job. Not built: an automated re-apply after
a restore (§4).

## 1. Request arrives from a visitor or API end user

- Visitors are directed to the **tenant**, not to us. If a request reaches the service operator, forward it to
  the tenant within 5 business days (proposed) and tell the requester so. Do not act on it without the tenant's
  instruction (DPA clause 7).
- Give the tenant the response templates from `docs/privacy/erasure.md` §4 (Art. 11(2) answer for visitor rows;
  the workflow below for content in URLs or events).

## 2. Tenant runs the workflow

1. A tenant `owner` or `admin` opens the project's **Data erasure** page, or calls
   `POST /v1/tenants/{tenantId}/erasure-requests` with selectors (site or API service/route, time range
   `start` inclusive / `end` exclusive in UTC, path pattern, event name, property key).
   Body: `{"site_id": …, "scope": "filtered", "criteria": {"start": "…Z", "end": "…Z", "path_pattern": "/users/jane/*"}}`
   → `202` with `status: previewing`.
2. The preview (`GET …/erasure-requests/{requestId}` until `status: previewed`, about a second on a small site) shows
   counts only: `website_events`, `event_data_rows`, `sessions_orphaned`, `breakdown_rows`, `api_routes`,
   `api_metric_rows`, `aggregate_days`; the selector appears as type and length only.
3. Confirmation (`POST …/erasure-requests/{requestId}/confirm`, **no request body**) needs a fresh sign-in
   ≤ 10 minutes old (C-87; the portal asks for confirmation in a dialog first); otherwise `403` `recent_auth_required`. A request is
   confirmable only in `previewed` (`409` otherwise).
4. The job runs **under the tenant's context only**: in `umami` as `scf_umami_maint` (DELETE on event, session and
   their data tables only) on the tenant's main and twin websites; in `scf`, matching breakdown rows and API route rows
   are deleted, site totals remain (C-46).
5. Spool sweep 72 hours later re-applies the selectors (configured by `SCF_ERASURE_SWEEP_DELAY_MS`, default 72 h).
6. Completion report (`status: completed`): `result` with the same counts, times, and `backup_expiry_note` —
   "Erased data leaves all backups within 56 days (by <date>)" (C-112(2)).

## 3. Service-operator checks while a request runs

- Job progress and failures: jobs-service log (counts and SQLSTATE only, never selectors or values), the request's
  `status` / `failure_code`, the operator list `GET /v1/operator/erasure-requests`, and the audit log
  (`erasure.requested`, `erasure.confirmed`, `erasure.completed` with selector **type** and counts, never the literal
  selector, C-88).
- A stuck job: it is batched and resumable; restart the jobs service (`$DC restart jobs`) only after it has committed
  its current batch.
- Never copy selectors into tickets or chat: the literal selector may itself name a person. It is kept only until the
  job has finished plus 56 days, then replaced by its type and length (`retention` job,
  `scf.erasure_redact_selectors()` — built in `services/jobs`).

## 4. After a restore from backup

Before a restored database serves traffic, re-apply every completed erasure request whose selector is still kept
(selectors outlive every backup version: C-111, C-112). Find them in the **current** database before you switch
(the restored copy may predate some requests):

```sql
SELECT tenant_id, request_id, site_id, service_id, scope, completed_at FROM scf.erasure_requests
WHERE status = 'completed' AND selector_redacted_at IS NULL ORDER BY completed_at;
```

**No automated re-apply command exists yet** (`docs/privacy/erasure.md` §3 step 9). Until it does, the restore is not
finished: keep ingest paused for the affected tenants and have a maintainer re-run each request's `criteria` on the
restored database with the erasure worker's code path, then compare the counts with the original `result`. Coordinate
with [`restore-pitr.md`](restore-pitr.md) and [`restore-logical-dump.md`](restore-logical-dump.md).

## 5. Tenant or site removal

Handled by `tenant-lifecycle.md`: removal → 30-day grace → purge (`tenant_purge`, built; drilled 2026-11-14).

## Drill

In the local stack send events with a canary path, request erasure of that path, check the
preview, confirm, verify that Umami (`/metrics?type=path` through the adapter) and `web_daily_breakdowns` no longer
contain it while totals are unchanged, and that the audit row has no literal selector. Record it in `README.md`.

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), images built from the working tree | Owner (SEP-53 sign-in) created a tenant, site and domain through the API (domain marked verified by SQL — no public DNS); 7 events through the gateway, 3 with canary paths `/users/jane-canary/…`; `createErasureRequest` with `path_pattern` `/users/jane-canary/*` for the UTC day → preview → `confirm` (no body; sign-in 8 minutes old) → completed; Umami, audit log and container logs checked | **pass** — preview after 1.1 s: `website_events` 3, other counts 0, selector shown as `path_pattern` length 20; confirm `202`, completed about 1 s later with `result` = preview and the note "Erased data leaves all backups within 56 days (by 2027-01-08)"; Umami afterwards: the 3 canary events gone, the 4 other events kept; audit rows `erasure.requested/confirmed/completed` carry selector type and counts, 0 rows and 0 log lines contain the literal path. Deviations: `breakdown_rows` 0 because the day had not been rolled up yet, so "totals unchanged" was not checked; a first `confirm` sent with `content-type: application/json` and an empty body got `400` (client error: the operation takes no body — documented above). |
