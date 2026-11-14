// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Audit chain (docs/data-model.md §5, C-103): append through the SECURITY DEFINER trigger owned by
// scf_audit_definer; no runtime role can write audit_chain_heads; audit_log is append-only; every chain verifies.

// verifySQL recomputes every chain: each row's hash covers its predecessor's hash and its canonical text, seq is
// contiguous from 1, and each head holds the last row's seq and hash. Returns one row per defect.
const verifySQL = verifyRowsSQL + `
UNION ALL
SELECT 'head ' || h.chain_id FROM scf.audit_chain_heads h
  LEFT JOIN LATERAL (SELECT a.seq, a.row_hash FROM scf.audit_log a WHERE a.chain_id = h.chain_id ORDER BY a.seq DESC LIMIT 1) l ON true
 WHERE l.seq IS DISTINCT FROM h.last_seq OR l.row_hash IS DISTINCT FROM h.last_hash
UNION ALL
SELECT 'headless ' || a.chain_id FROM (SELECT DISTINCT chain_id FROM scf.audit_log) a
 WHERE NOT EXISTS (SELECT 1 FROM scf.audit_chain_heads h WHERE h.chain_id = a.chain_id)`

// verifyRowsSQL is the row half (what job audit_verify can check: it reads audit_log, not the heads).
const verifyRowsSQL = `
WITH r AS (
  SELECT a.chain_id, a.seq, a.prev_hash, a.row_hash,
         lag(a.row_hash) OVER w AS prev_row_hash, row_number() OVER w AS n,
         sha256(a.prev_hash || convert_to(scf.audit_canonical(a), 'UTF8')) AS recomputed
    FROM scf.audit_log a WINDOW w AS (PARTITION BY a.chain_id ORDER BY a.seq))
SELECT 'row ' || chain_id || '/' || seq FROM r
 WHERE recomputed <> row_hash OR seq <> n
    OR prev_hash <> COALESCE(prev_row_hash, decode(repeat('00', 32), 'hex'))`

func verifyChains(t *testing.T, q querier) {
	t.Helper()
	bad, err := queryStrings(context.Background(), q, verifySQL)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	if len(bad) > 0 {
		t.Fatalf("audit chains do not verify: %v", bad)
	}
}

func appendAudit(t *testing.T, conn *pgx.Conn, c Ctx, tenant any, action string) error {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := setCtx(ctx, tx, c); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, details)
	    VALUES ($1::uuid, $2, $3, $4, '{"k":"v"}')`, tenant, c.Kind, nullStr(c.Actor), action); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func TestAuditChainAppendAndVerify(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	verifyChains(t, su)
	var before int64
	_ = su.QueryRow(ctx, `SELECT last_seq FROM scf.audit_chain_heads WHERE chain_id = $1`, A).Scan(&before)

	app := runtimeConn(t, "scf_app")
	userA := Ctx{Tenant: A, Kind: "user", Actor: users[A], RequestID: "req-audit"}
	if err := appendAudit(t, app, userA, A, "site.updated"); err != nil {
		t.Fatalf("append to own chain: %s", sqlState(err))
	}
	if err := appendAudit(t, app, userA, nil, "auth.signed_in"); err != nil {
		t.Fatalf("append to the platform chain: %s", sqlState(err))
	}
	var after int64
	if err := su.QueryRow(ctx, `SELECT last_seq FROM scf.audit_chain_heads WHERE chain_id = $1`, A).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before+1 {
		t.Errorf("chain head of A: want %d, got %d", before+1, after)
	}
	// another tenant's chain is refused (WITH CHECK), and the head update rolls back with it
	if err := appendAudit(t, app, userA, B, "site.updated"); code(err) != "42501" {
		t.Errorf("append to B's chain under A: want 42501, got %s", sqlState(err))
	}
	// actor_kind must match the context (audit_insert policy)
	// an unknown action has no writer list, so the per-role allow-list refuses it (C-114) …
	if err := appendAudit(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, A, "x.y"); code(err) != "42501" {
		t.Errorf("unknown action (allow-list, C-114): want 42501, got %s", sqlState(err))
	}
	// … and the C-89 foreign key still holds where RLS does not apply (superuser)
	if err := inCtxSuper(t, su, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, action) VALUES (NULL, 'system', 'x.y')`)
		return err
	}); code(err) != "23503" {
		t.Errorf("unknown action (C-89 FK): want 23503, got %s", sqlState(err))
	}
	// writer may write service.auto_registered only (CR-20)
	wr := runtimeConn(t, "scf_writer")
	if err := appendAudit(t, wr, Ctx{Tenant: A, Kind: "writer", Actor: "writer"}, A, "service.auto_registered"); err != nil {
		t.Errorf("writer service.auto_registered: %s", sqlState(err))
	}
	if err := appendAudit(t, wr, Ctx{Tenant: A, Kind: "writer", Actor: "writer"}, A, "site.updated"); code(err) != "42501" {
		t.Errorf("writer other action: want 42501, got %s", sqlState(err))
	}
	verifyChains(t, su)

	// audit_verify reads every chain (as scf_jobs, through PgBouncer) and finds it intact
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Kind: "job", Actor: "audit_verify", Job: "audit_verify"}, func(ctx context.Context, tx pgx.Tx) error {
		var chains int
		if err := tx.QueryRow(ctx, `SELECT count(DISTINCT chain_id) FROM scf.audit_log`).Scan(&chains); err != nil {
			return err
		}
		if chains < 4 {
			return fmt.Errorf("audit_verify sees %d chains, want ≥ 4 (A, B, C, platform)", chains)
		}
		bad, err := queryStrings(ctx, tx, verifyRowsSQL)
		if err != nil {
			return err
		}
		if len(bad) > 0 {
			return fmt.Errorf("defects seen by audit_verify: %v", bad)
		}
		return nil
	}); err != nil {
		t.Error(sqlState(err))
	}
}

func TestAuditChainHeadsNotWritable(t *testing.T) {
	for _, role := range []string{"scf_app", "scf_writer", "scf_jobs", "scf_metrics_ro"} {
		for _, stmt := range []string{
			`UPDATE scf.audit_chain_heads SET last_hash = decode(repeat('ff', 32), 'hex') WHERE chain_id = '00000000-0000-0000-0000-000000000000'`,
			`INSERT INTO scf.audit_chain_heads (chain_id, last_seq, last_hash) VALUES (gen_random_uuid(), 0, decode(repeat('00', 32), 'hex'))`,
			`DELETE FROM scf.audit_chain_heads`,
		} {
			conn := runtimeConn(t, role)
			for _, c := range []Ctx{{Tenant: A, Kind: "user", Actor: users[A]}, {Kind: "job", Actor: "audit_anchor", Job: "audit_anchor"}} {
				err := inCtx(t, conn, c, func(ctx context.Context, tx pgx.Tx) error {
					tag, err := tx.Exec(ctx, stmt)
					if err == nil && tag.RowsAffected() > 0 {
						return fmt.Errorf("%d rows changed", tag.RowsAffected())
					}
					return err
				})
				if code(err) != "42501" {
					t.Errorf("%s %q: want 42501, got %v", role, firstLine(stmt), sqlState(err))
				}
			}
		}
	}
	// job audit_anchor may read the heads (C-63)
	conn := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, conn, Ctx{Kind: "job", Actor: "audit_anchor", Job: "audit_anchor"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.audit_chain_heads`).Scan(&n); err != nil {
			return err
		}
		if n < 4 {
			return fmt.Errorf("audit_anchor sees %d heads", n)
		}
		return nil
	}); err != nil {
		t.Error(sqlState(err))
	}
}

func TestAuditLogAppendOnly(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	for _, stmt := range []string{`UPDATE scf.audit_log SET outcome = 'failure'`, `DELETE FROM scf.audit_log`} {
		err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, stmt)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("scf_app %q: want 42501, got %s", stmt, sqlState(err))
		}
	}
	// even the superuser is stopped by the triggers
	su := super(t)
	ctx := context.Background()
	for _, stmt := range []string{`UPDATE scf.audit_log SET outcome = 'failure'`, `DELETE FROM scf.audit_log`, `TRUNCATE scf.audit_log`} {
		tx, _ := su.Begin(ctx)
		_, err := tx.Exec(ctx, stmt)
		_ = tx.Rollback(ctx)
		if code(err) != "42501" || err == nil {
			t.Errorf("superuser %q: want 42501 from the append-only trigger, got %s", stmt, sqlState(err))
		}
	}
}

// Concurrent appends to one chain through PgBouncer serialise on the head row: seq stays contiguous, chain verifies.
func TestAuditChainConcurrentAppends(t *testing.T) {
	const workers, each = 8, 10
	var wg sync.WaitGroup
	errs := make(chan error, workers*each)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := pgx.Connect(context.Background(), dsn("scf_app", "scf", true))
			if err != nil {
				errs <- err
				return
			}
			defer conn.Close(context.Background())
			for i := 0; i < each; i++ {
				if err := appendAudit(t, conn, Ctx{Tenant: C, Kind: "system", Actor: "edge"}, C, "site.updated"); err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent append: %s", sqlState(err))
	}
	verifyChains(t, super(t))
}
