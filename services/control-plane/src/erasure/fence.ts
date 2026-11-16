// SPDX-License-Identifier: Apache-2.0
// The erasure fence between job `erasure` and job `web_rollup` (privacy.tenant-erasure, C-46).
//
// The race it closes: a rollup that read a site-day from Umami before an erasure's Umami delete, but wrote that day's
// `web_daily_breakdowns` rows after the erasure's `scf` delete, would put an erased path back.
//
// The contract (both sides use the SAME key, ERASURE_FENCE_KEY_SQL, also exported by services/jobs web-rollup.ts):
//   - job web_rollup reads Umami for a site-day AND writes its rows inside one `scf` transaction holding the tenant's
//     fence SHARED (`pg_try_advisory_xact_lock_shared`); when the fence is taken it defers that site-day to its next pass
//     (nothing written);
//   - job erasure (and its 72 h spool sweep) holds the tenant's fence EXCLUSIVE (`pg_advisory_xact_lock`, FENCE_LOCK_SQL)
//     in one `scf` transaction that is open from before its first Umami delete until the `scf` delete and the
//     `completed` update commit. It waits for running rollups of the tenant to commit first, so their rows are deleted
//     by the erasure's `scf` delete; a rollup starting meanwhile finds the fence taken and writes nothing.
// Transaction-level locks: released at commit or rollback, also when a worker dies (its connection ends).

/** The tenant's fence key; $1 = tenant id (uuid). Identical text in services/jobs/src/jobs/web-rollup.ts. */
export const ERASURE_FENCE_KEY_SQL = "hashtextextended('scf.erasure-fence/' || $1::uuid::text, 0)";

/** The erasure side: takes the tenant's fence exclusively for the rest of the transaction; $1 = tenant id. */
export const FENCE_LOCK_SQL = `SELECT pg_advisory_xact_lock(${ERASURE_FENCE_KEY_SQL})`;

/** The rollup side: true when the fence was taken shared (the site-day may be read and written); $1 = tenant id. */
export const FENCE_TRY_SHARED_SQL = `SELECT pg_try_advisory_xact_lock_shared(${ERASURE_FENCE_KEY_SQL}) AS ok`;

// The API erasure fence between job `erasure` and the metrics writer (privacy.tenant-erasure, privacy.erasure-workflow).
//
// The deadlock it closes: a writer transaction upserts a tenant's series into api_metrics_1d, then _1h, then _1m
// (services/metrics-writer/internal/store/upsert.go), while a service-scope erasure deleted the same series in
// _1m, _1h, _1d order — each held a row the other needed next, and PostgreSQL aborted one of them (40P01). The
// erasure could only complete with the writer paused.
//
// The contract (both sides use the SAME key text, API_FENCE_KEY_SQL, also in
// services/metrics-writer/internal/store/fence.go — a test compares the two):
//   - every writer transaction takes the tenant's API fence SHARED (blocking, `pg_advisory_xact_lock_shared`) as its
//     first lock, before any row lock;
//   - the erasure (and its spool sweep) takes it EXCLUSIVE immediately before its first api_* delete, in the same
//     transaction that commits the deletion. It waits for the tenant's running writer transactions to commit (their
//     rows are then deleted too) and holds new ones back only for the short scf delete — never during the Umami delete.
// No transaction can hold a metric-row lock the other side needs while waiting on the fence, so no cycle can form.
// A different key from the web fence above: the web fence is held across the Umami delete, which may take minutes.

/** The tenant's API fence key; $1 = tenant id (uuid). Identical text in services/metrics-writer (fence.go). */
export const API_FENCE_KEY_SQL =
  "pg_catalog.hashtextextended('scf.api-erasure-fence/' || $1::uuid::text, 0)";

/** The erasure side: the tenant's API fence exclusively for the rest of the transaction; $1 = tenant id. */
export const API_FENCE_LOCK_SQL = `SELECT pg_catalog.pg_advisory_xact_lock(${API_FENCE_KEY_SQL})`;

/** The writer side (what every writer transaction runs first); $1 = tenant id. */
export const API_FENCE_SHARED_SQL = `SELECT pg_catalog.pg_advisory_xact_lock_shared(${API_FENCE_KEY_SQL})`;
