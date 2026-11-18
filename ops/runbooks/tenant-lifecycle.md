# Runbook: tenant lifecycle (approve, suspend, reinstate, remove, restore, purge, tombstones)

Status: exercised 2026-11-14 (whole cycle through the real portal session of an `operator_admin` with a passkey, Compose) — see the drill log
Owner: SCF operators (`operator` / `operator_admin`); service operator for the purge job
Last reviewed: 2026-11-14

Decisions: ADR-0015, C-08, C-09, C-19, C-64, C-70, C-87, C-91, C-94. Contract: `docs/api/control-plane.openapi.yaml`;
the state machine is the database function `scf.op_tenant_transition()` (`db/migrations/0040_op_functions.sql`),
which authorises, writes the audit row and changes the status in one transaction. The edge refuses ingest for a
`pending`, `suspended` or `removed` tenant at its next snapshot (≤ 60 s, C-06).

Every operation below needs a signed-in SCF operator with a passkey; the ones marked **step-up** need a passkey
assertion at most 10 minutes old (C-09). Every operation is written to the hash-chained audit log and raises the
`SCFOperatorPrivilegedAction` notice (`operator-activity.md`). Use the portal's SCF-operator views or the API.

## State machine (as built)

| Action | From | To | Endpoint | Step-up |
|---|---|---|---|---|
| approve | `pending` | `active` | `POST /v1/operator/tenants/{tenantId}/transitions` `{"action":"approve","reason":…}` | yes |
| suspend | `active`, `pending` | `suspended` | same, `"action":"suspend"` | yes |
| reinstate | `suspended` | `active` | same, `"action":"reinstate"` | yes |
| remove | `active`, `pending`, `suspended` | `removed`; `purge_after` = now + 30 days; tombstones created | `POST /v1/operator/tenants/{tenantId}/removal` `{"reason":…}` | yes |
| restore | `removed` (not yet purged) | `suspended` (C-94) — then reinstate | `POST /v1/operator/tenants/{tenantId}/restoration` | yes |
| purge now | `removed` | `removed`, `purge_after` = now | `POST /v1/operator/tenants/{tenantId}/purge` | yes |
| require re-approval (bulk) | `active` at the given levels | `pending` | `POST /v1/operator/reapprovals` `{"levels":["L0",…],"reason":…}` | yes |

`transitions` carries `x-requires-step-up` like the other rows (the contract; a passkey sign-in within the last 10
minutes counts). Lifting a tombstone answers `204`. Invalid transitions answer `409`; an unknown or already purged tenant `404`. Reasons are free text kept in the audit
log — write facts, never personal data of end users.

A tenant owner can remove their own tenant (`POST /v1/tenants/{tenantId}/removal`, fresh sign-in ≤ 10 minutes,
C-87); same 30-day grace.

## Procedures

### Approve a pending tenant (`approval_required` mode)
1. Review the tenant's verification ladder in the portal (L0 unverified … L4 operator-approved).
2. `approve` with a reason. Ingest starts at the next snapshot.

### Suspend (abuse, legal request, investigation)
1. `suspend` with the reason. Data is kept; ingest is refused within 60 s (`tenant_suspended` reason at the edge).
2. Tell the tenant through its contact (if stored) why and how to appeal (issue tracker or private channel, C-19).
3. `reinstate` when resolved.

### Remove
1. Confirm the decision (an `operator_admin` decides appeals, C-19). Step-up.
2. `remove`. Effects: ingest stops within 60 s, data is hidden, `purge_after` = +30 days, the site key answers `404`
   like an unknown key (C-72), and **tombstones** are created for the tenant's verified hosts, owners' GitHub
   identities and verified Stellar accounts, blocking re-enrollment (C-64).
3. Restore is possible until the purge runs: `restore` (lands in `suspended`), then `reinstate`.

### Purge
- `purge now` only shortens the grace period (`purge_after` = now); it is irreversible once the purge has run.
- The purge is the jobs service's `tenant_purge` (`services/jobs/README.md`): hourly at minute
  `SCF_JOBS_HOURLY_MINUTE` + 10 (default :15). It purges the engine through the engine proxy with the provisioner
  certificate (visit tokens on every core, then the main and twin websites, the tenant's Umami user and team),
  releases host claims, deletes the tenant's rows of every table whose `jobs_delete` policy names it, writes the
  tombstones, sets `purged_at` and audits `tenant.purged` (counts only); a failure rolls back and is audited as
  `tenant.purge_failed`. The tenant row, its audit chain and the tombstones stay.
- To purge at once instead of waiting for the hour: `$DC restart jobs` — the jobs service runs every enabled job at
  start (`SCF_JOBS_RUN_ON_START`, default true).
- Check: `SELECT status, purge_after, purged_at FROM scf.tenants WHERE tenant_id = '<id>'`; `scf_job_runs_total{job="tenant_purge"}`
  (success, no `failure`).
- Backups: erased data leaves all backups within 56 days (C-112); a restore before then must re-run the purge
  (`restore-pitr.md`).

### Require re-approval in bulk (C-91, C-94)
1. Set enrollment to approval required: `PUT /v1/operator/settings/enrollment-mode` `{"enrollment_mode":"approval_required"}`
   (`operator_admin`, step-up). This alone affects new enrollments only (C-19).
2. `POST /v1/operator/reapprovals` with the levels to move; the answer lists `moved_count` and the tenant ids.
3. Approve them one by one after review.

### Tombstones
- List: `GET /v1/operator/tombstones` (`items[]` with `kind` `host` / GitHub / Stellar, `subject`, `tenant_id`; table
  `scf.enrollment_tombstones`).
- Lift (an `operator_admin` only, step-up): `POST /v1/operator/tombstones/{tombstoneId}/lift`. Lifting re-allows
  enrollment with that host, GitHub identity or Stellar account; record why.

## Not built yet (planned)

- Portal notices to `operator_admin`s. (`operatorGetTenant`, `operatorResolveDomainDispute` and
  `operatorApproveTenantLevel` are built.)

## Drill

In the local stack, with a test tenant: create, `suspend` → check the installation check counts `tenant_suspended`
rejections once the gateway is running → `reinstate` → `remove` → `restore` → `reinstate`; list and lift its
tombstones. Record it in `README.md` (drill log).

## Drill log

| Date | Environment | What was done | Result |
|---|---|---|---|
| 2026-11-14 | Compose, project `scf-tg` (ports 56450–56452), images built from the working tree; operator steps from a real Chromium session (Playwright, virtual WebAuthn authenticator) on the portal, the operator role granted in the database (no other bootstrap path locally, as in `apps/portal/e2e/real`) | Owner created a tenant, site and domain through the API (SEP-53 sign-in; domain marked verified by SQL — no public DNS); 3 events → stored. Operator: passkey enrolment, then `suspend` → 3 events after 70 s → `reinstate` → 3 events after 70 s → `remove` → tombstones listed → `restore` → `reinstate` → `remove` → `purge now` → `$DC restart jobs` → checks → tombstone lifted | **pass** — every call answered as documented (transitions/removal/restoration/purge `200`, lift `204`); suspended: 0 of 3 events stored, reinstated: 3 of 3; remove set `purge_after` = +30 days and created the host tombstone; restore landed in `suspended`, then `active`; the purge completed 2.7 s after the jobs restart: `scf.sites` 1 → 0, the Umami website and its 6 events gone, `purged_at` set; audit chain `tenant.created, suspended, reinstated, removed, restored, reinstated, removed, purge_requested, purged`; the tombstone shows `lifted_at` after the lift. Not exercised: `approve` (enrollment mode `open`), bulk re-approval, the installation check's `tenant_suspended` count (ingest refusal checked by stored events instead). |
