// SPDX-License-Identifier: Apache-2.0

package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// The API erasure fence (privacy.tenant-erasure, privacy.erasure-workflow). Contract in
// services/control-plane/src/erasure/fence.ts: every writer transaction takes the tenant's fence SHARED as its first
// lock, before any row lock; job `erasure` takes it EXCLUSIVE immediately before its api_* deletes. Without it a
// service-scope erasure (deleting _1m, _1h, _1d) and a writer transaction (upserting _1d, _1h, _1m) each held a row
// the other needed and PostgreSQL aborted one of them (40P01): the erasure only completed with the writer paused.
// With it, an erasure waits for the tenant's open writer transactions and holds new ones back for its short delete
// only; writers never wait for each other (shared mode).
//
// apiFenceKeySQL must stay identical to API_FENCE_KEY_SQL in fence.ts (a control-plane test compares the text).
const apiFenceKeySQL = `pg_catalog.hashtextextended('scf.api-erasure-fence/' || $1::uuid::text, 0)`

const apiFenceSharedSQL = `SELECT pg_catalog.pg_advisory_xact_lock_shared(` + apiFenceKeySQL + `)`

// APIFenceExclusiveSQL is the erasure side ($1 = tenant id), exported for tests that stage an erasure.
const APIFenceExclusiveSQL = `SELECT pg_catalog.pg_advisory_xact_lock(` + apiFenceKeySQL + `)`

// fence takes the tenant's API erasure fence shared for the rest of the transaction (blocking; bounded by the
// transaction's context).
func fence(ctx context.Context, tx pgx.Tx, tenant string) error {
	_, err := tx.Exec(ctx, apiFenceSharedSQL, tenant)
	return err
}
