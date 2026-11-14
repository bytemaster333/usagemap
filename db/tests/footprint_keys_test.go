// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0081: footprint registration keys `scfa_reg_…`. A tenant member (scf_app under the tenant) lists, creates and revokes
// its own tenant's keys only; the label, hash, network and creator of a key never change after creation (column
// grant); at most 5 usable keys per tenant; scf.lookup_footprint_key finds a key by id before any tenant is known and
// returns only that key's verification data; scf_metrics_ro and the op definer have nothing; tenant_purge deletes.
func TestFootprintKeys0081(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	ua := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	keyA, keyB := alnum(A, 6, 12), alnum(B, 6, 12)

	ins := func(tx pgx.Tx, tenant, id, network string) error {
		return savepoint(context.Background(), tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(context.Background(), `INSERT INTO scf.footprint_keys (tenant_id, key_id, secret_hash, last4, label,
			  network, created_by) VALUES ($1, $2, decode(repeat('ab', 32), 'hex'), 'wxyz', 'ci', $3, $4)`,
				tenant, id, nullStr(network), users[A])
			return err
		})
	}

	if err := inCtx(t, app, ua, func(ctx context.Context, tx pgx.Tx) error {
		var own, other int
		if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE tenant_id = $1), count(*) FILTER (WHERE tenant_id <> $1)
		    FROM scf.footprint_keys`, A).Scan(&own, &other); err != nil {
			return err
		}
		if own != 1 || other != 0 {
			t.Errorf("app under A sees own=%d other=%d (want 1, 0)", own, other)
		}
		if err := ins(tx, B, "zzzzzzzzzzz1", ""); code(err) != "42501" {
			t.Errorf("insert of B's key under A: want 42501, got %q", sqlState(err))
		}
		if err := ins(tx, A, "zzzzzzzzzzz2", "pubnet"); code(err) != "23514" {
			t.Errorf("unknown network: want 23514, got %q", sqlState(err))
		}
		// the seed holds one key of A: four more are allowed (kept in this transaction), the sixth usable key is refused
		for i := 0; i < 4; i++ {
			if _, err := tx.Exec(ctx, `INSERT INTO scf.footprint_keys (tenant_id, key_id, secret_hash, last4, label, network,
			    created_by) VALUES ($1, $2, decode(repeat('ab', 32), 'hex'), 'wxyz', 'ci', 'mainnet', $3)`,
				A, fmt.Sprintf("yyyyyyyyyyy%d", i), users[A]); err != nil {
				t.Fatalf("key %d: %s", i, sqlState(err))
			}
		}
		if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `INSERT INTO scf.footprint_keys (tenant_id, key_id, secret_hash, last4, label, created_by,
			    revoked_at) VALUES ($1, 'xxxxxxxxxxx1', decode(repeat('ab', 32), 'hex'), 'wxyz', 'ci', $2, now())`, A, users[A])
			return err
		}); code(err) != "42501" {
			t.Errorf("insert with revoked_at: want 42501, got %q", sqlState(err))
		}
		if err := ins(tx, A, "yyyyyyyyyyy9", ""); code(err) != "23514" {
			t.Errorf("sixth active key: want 23514, got %q", sqlState(err))
		}
		// a revoked key frees its slot
		if _, err := tx.Exec(ctx, `UPDATE scf.footprint_keys SET revoked_at = now(), revoked_by = $2
		    WHERE tenant_id = $1 AND key_id = 'yyyyyyyyyyy0'`, A, users[A]); err != nil {
			t.Fatalf("revoke: %s", sqlState(err))
		}
		if err := ins(tx, A, "yyyyyyyyyyy9", ""); err != nil {
			t.Errorf("after a revocation: %s", sqlState(err))
		}
		for _, col := range []string{"label = 'x'", "network = 'mainnet'", "secret_hash = '\\x00'", "created_by = created_by"} {
			if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, `UPDATE scf.footprint_keys SET `+col+` WHERE tenant_id = $1`, A)
				return err
			}); code(err) != "42501" {
				t.Errorf("update %s: want 42501, got %q", col, sqlState(err))
			}
		}
		// B's key is invisible under A, so a revocation names nothing
		tag, err := tx.Exec(ctx, `UPDATE scf.footprint_keys SET revoked_at = now() WHERE key_id = $1`, keyB)
		if err != nil || tag.RowsAffected() != 0 {
			t.Errorf("revoke B's key under A: rows=%d err=%q", tag.RowsAffected(), sqlState(err))
		}
		// the lookup answers for any id (the caller then checks the HMAC) and returns the named key only
		var tenant, network string
		var usable bool
		if err := tx.QueryRow(ctx, `SELECT tenant_id::text, network, usable FROM scf.lookup_footprint_key($1)`, keyB).
			Scan(&tenant, &network, &usable); err != nil {
			return err
		}
		if tenant != B || network != "testnet" || !usable {
			t.Errorf("lookup of B's key: %s %s %v", tenant, network, usable)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.lookup_footprint_key('nosuchkey000')`).Scan(&n); err != nil || n != 0 {
			t.Errorf("unknown id: n=%d err=%q", n, sqlState(err))
		}
		if err := tx.QueryRow(ctx, `SELECT usable FROM scf.lookup_footprint_key('yyyyyyyyyyy0')`).Scan(&usable); err != nil || usable {
			t.Errorf("revoked key usable=%v err=%q", usable, sqlState(err))
		}
		return nil
	}); err != nil {
		t.Fatal(sqlState(err))
	}

	// The key's own requests run under its tenant as `system`: last_used_at only.
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "system", Actor: "footprint_key:" + keyA}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE scf.footprint_keys SET last_used_at = now() WHERE tenant_id = $1 AND key_id = $2`, A, keyA)
		if err == nil && tag.RowsAffected() != 1 {
			t.Errorf("touch: %d rows", tag.RowsAffected())
		}
		return err
	}); err != nil {
		t.Errorf("touch as system: %s", sqlState(err))
	}

	ro := runtimeConn(t, "scf_metrics_ro")
	if err := inCtx(t, ro, Ctx{Kind: "op_key", Actor: "k"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.footprint_keys`).Scan(&n)
	}); code(err) != "42501" {
		t.Errorf("scf_metrics_ro read: want 42501, got %q", sqlState(err))
	}
	if err := inCtx(t, ro, Ctx{Kind: "op_key", Actor: "k"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.lookup_footprint_key($1)`, keyA).Scan(&n)
	}); code(err) != "42501" {
		t.Errorf("scf_metrics_ro lookup: want 42501, got %q", sqlState(err))
	}

	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.footprint_keys WHERE tenant_id = $1`, A)
		if err == nil && tag.RowsAffected() != 1 {
			t.Errorf("purge deleted %d rows", tag.RowsAffected())
		}
		return err
	}); err != nil {
		t.Errorf("tenant_purge delete: %s", sqlState(err))
	}
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM scf.footprint_keys WHERE tenant_id = $1`, A)
		return err
	}); err != nil {
		// no policy for retention: RLS hides every row (no error, nothing deleted) — an error is unexpected
		t.Errorf("retention delete: %s", sqlState(err))
	}
}
