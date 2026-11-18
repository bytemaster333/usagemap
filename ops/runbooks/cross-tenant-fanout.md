# Runbook: cross-tenant fan-out

Status: to be exercised (no drill has run)
Owner: security responders
Last reviewed: 2026-11-14
Alerts: CrossTenantFanout

Source: `docs/monitoring-plan.md` §4.4. Alert state (`ops/alerts/coverage.json`): **no rule yet** — the signal
`scf_cross_tenant_contexts{actor_class}` is not exported (owner: control plane / jobs). Until it is, run the
audit-log query below during the weekly review and whenever an isolation question comes up.

## Built today

- Every unit of work in the control plane is a transaction that calls `scf.set_tenant_ctx()`
  (`services/control-plane/src/db/database.ts`); RLS with `FORCE` on every tenant table (gates G1–G11, `db/README.md`).
- SCF operators read across tenants only through audited definer functions (`scf.op_*`, `db/migrations/0040_op_functions.sql`
  and later); each call writes `scf.audit_log` with `actor_kind` `operator` or `op_key` and `subject_tenant_ids`.
- Jobs that legitimately visit every tenant (allow-list): `web_rollup`, `retention`, `partitions`, `stream_gc`,
  `trust_scoring`, `durability_reconcile`, `tenant_purge`, `umami_reconcile`, `edge_snapshot`, `public_metrics`
  (`services/jobs/README.md`).
- **Not built:** a per-session counter of tenant contexts for application processes; the query below sees only
  audited actions.

## CrossTenantFanout (TM-ISO-06.M.1)

**Meaning.** One session, key or process touched more than N (20) tenant contexts in 10 minutes outside the
allow-listed jobs.

**First checks** — who touched many tenants (counts only; no row content):

```sql
-- $DC exec -T postgres sh -c 'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -U postgres -d scf'
SELECT actor_kind, actor_id, date_trunc('minute', occurred_at) - (extract(minute FROM occurred_at)::int % 10) * interval '1 minute' AS window,
       count(DISTINCT t) AS tenants, count(*) AS actions
FROM scf.audit_log, LATERAL unnest(coalesce(subject_tenant_ids, ARRAY[tenant_id])) AS t
WHERE occurred_at > now() - interval '24 hours' AND actor_kind IN ('user', 'operator', 'op_key', 'pub_key')
GROUP BY 1, 2, 3 HAVING count(DISTINCT t) > 20 ORDER BY tenants DESC;
```

- `operator` / `op_key`: expected only through `op_*` functions; check the actions (`SELECT action, count(*) … GROUP BY 1`
  for that `actor_id` and window) against a task the operator was doing (bulk re-approval, campaign comparison).
  Bulk reads also raise `SCFOperatorBulkRead` (`operator-activity.md`).
- `user`: a tenant member's session can only reach the tenants it belongs to; many tenants for one user means either
  a member of many tenants (check `scf.memberships`) or an isolation bug — then `isolation-breach.md`.
- An application process (no audit row; seen in its logs or in `pg_stat_activity`): stop it and investigate as a bug.

**Mitigation**

- Unexplained `op_key`: revoke it (`POST /v1/operator/api-keys/{keyId}/revoke`, effective within 5 s, C-06;
  `api-key-anomaly.md`). Unexplained operator session: revoke the operator role (`DELETE /v1/operator/operators/{userId}`)
  and the sessions.
- Unexplained user access across tenants: treat as an isolation breach (`isolation-breach.md`); run the isolation
  matrix (`node tests/isolation/run.ts --run-db`, `make isolation-report`) against the deployed release.

**Escalation**

- Security critical: push to both named security responders (C-67); open a private record (draft security advisory
  or private ops issue) with the start time.

## Related

- ADR-0013, C-17, `operator-activity.md`, `isolation-breach.md`, `api-key-anomaly.md`.
- `ops/runbooks/incident.md` — whenever tenants are affected or the cause is unknown after 30 minutes.
- Drill log: `ops/runbooks/README.md` (docs.operator-runbooks).
