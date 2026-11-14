// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// scf.set_tenant_ctx() (docs/data-model.md §4, C-103): the only way to set context; always transaction-local, so
// nothing survives on a pooled PgBouncer server connection (pool scf_one: exactly one server connection, so two
// clients deterministically share it).

var guc = []string{"app.tenant_id", "app.actor_kind", "app.actor_id", "app.platform_role", "app.step_up_at",
	"app.reauthenticated_at", "app.key_scopes", "app.key_tenants", "app.job", "app.request_id"}

func readGUCs(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}) (map[string]string, error) {
	out := map[string]string{}
	for _, g := range guc {
		var v *string
		if err := q.QueryRow(ctx, `SELECT current_setting($1, true)`, g).Scan(&v); err != nil {
			return nil, err
		}
		if v != nil {
			out[g] = *v
		} else {
			out[g] = ""
		}
	}
	return out, nil
}

func TestSetTenantCtxTransactionLocal(t *testing.T) {
	ctx := context.Background()
	c1 := connectTo(t, "scf_app", "scf_one", true)
	c2 := connectTo(t, "scf_app", "scf_one", true)
	now := time.Now()
	full := Ctx{Tenant: A, Kind: "operator", Actor: uOp, PlatformRole: "operator", KeyScopes: "web:read",
		KeyTenants: []string{A, B}, Job: "x", RequestID: "req-1", StepUp: &now, Reauth: &now}

	tx, err := c1.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := setCtx(ctx, tx, full); err != nil {
		t.Fatal(sqlState(err))
	}
	in, err := readGUCs(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	if in["app.tenant_id"] != A || in["app.actor_kind"] != "operator" || in["app.key_tenants"] != "{"+A+","+B+"}" ||
		in["app.request_id"] != "req-1" || in["app.step_up_at"] == "" || in["app.reauthenticated_at"] == "" {
		t.Errorf("values inside the transaction: %v", in)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// the other client gets the same server connection: nothing may survive
	after, err := readGUCs(ctx, c2)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range after {
		if v != "" {
			t.Errorf("after COMMIT, %s = %q is visible to another client", k, v)
		}
	}
	// a second call in the same transaction replaces every value (unset arguments become '')
	tx, _ = c1.Begin(ctx)
	_ = setCtx(ctx, tx, full)
	_ = setCtx(ctx, tx, Ctx{Kind: "anonymous"})
	in, _ = readGUCs(ctx, tx)
	_ = tx.Rollback(ctx)
	for k, v := range in {
		if k != "app.actor_kind" && v != "" {
			t.Errorf("second set_tenant_ctx left %s = %q", k, v)
		}
	}
}

// X1 of S-03: context set in a transaction that fails and rolls back does not survive either.
func TestSetTenantCtxRollback(t *testing.T) {
	ctx := context.Background()
	c1 := connectTo(t, "scf_writer", "scf_one", true)
	c2 := connectTo(t, "scf_writer", "scf_one", true)
	tx, _ := c1.Begin(ctx)
	if err := setCtx(ctx, tx, Ctx{Tenant: B, Kind: "writer", Actor: "writer"}); err != nil {
		t.Fatal(sqlState(err))
	}
	_, err := tx.Exec(ctx, `SELECT 1/0`)
	if code(err) != "22012" {
		t.Fatalf("want division by zero, got %s", sqlState(err))
	}
	_ = tx.Rollback(ctx)
	var v string
	if err := c2.QueryRow(ctx, `SELECT COALESCE(current_setting('app.tenant_id', true), '')`).Scan(&v); err != nil || v != "" {
		t.Errorf("after rollback another client sees app.tenant_id = %q (%v)", v, err)
	}
	var n int64
	if err := c2.QueryRow(ctx, `SELECT count(*) FROM scf.api_routes`).Scan(&n); err != nil || n != 0 {
		t.Errorf("no context: want 0 rows, got %d (%v)", n, err)
	}
}

func TestSetTenantCtxValidation(t *testing.T) {
	conn := runtimeConn(t, "scf_app")
	for _, c := range []Ctx{
		{Tenant: A, Kind: "root"},
		{Kind: "operator", PlatformRole: "superadmin"},
	} {
		err := inCtx(t, conn, c, func(context.Context, pgx.Tx) error { return nil })
		if code(err) != "22023" {
			t.Errorf("%+v: want 22023, got %s", c, sqlState(err))
		}
	}
	// an invalid UUID in app.tenant_id fails closed, loudly (22P02), when set by the superuser only path
	err := inCtx(t, conn, Ctx{Kind: "user"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT scf.set_tenant_ctx('not-a-uuid', 'user')`)
		return err
	})
	if code(err) != "22P02" {
		t.Errorf("invalid uuid: want 22P02, got %s", sqlState(err))
	}
	// EXECUTE: the four runtime roles only
	for _, role := range []string{"scf_app", "scf_writer", "scf_jobs", "scf_metrics_ro"} {
		var ok bool
		if err := super(t).QueryRow(context.Background(), `SELECT has_function_privilege($1,
		    'scf.set_tenant_ctx(uuid,text,text,text,timestamptz,timestamptz,text,uuid[],text,text)', 'EXECUTE')`, role).Scan(&ok); err != nil || !ok {
			t.Errorf("%s lacks EXECUTE on set_tenant_ctx (%v)", role, err)
		}
	}
	var pub bool
	_ = super(t).QueryRow(context.Background(), `SELECT has_function_privilege('public',
	    'scf.set_tenant_ctx(uuid,text,text,text,timestamptz,timestamptz,text,uuid[],text,text)', 'EXECUTE')`).Scan(&pub)
	if pub {
		t.Error("PUBLIC can execute set_tenant_ctx")
	}
}

// The tenant context reaches only the tenant's rows; the explicit WHERE of the repositories is a second filter.
func TestTenantContextReadsOwnRows(t *testing.T) {
	conn := runtimeConn(t, "scf_app")
	err := inCtx(t, conn, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		var own, all int64
		if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE tenant_id = $1), count(*) FROM scf.sites`, A).Scan(&own, &all); err != nil {
			return err
		}
		if own != 1 || all != 1 {
			return fmt.Errorf("sites under A: own=%d all=%d, want 1/1", own, all)
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
}

// C-87 fresh sign-in triggers: deleting an account, transferring ownership, owner removal and erasure confirmation.
func TestFreshSignInTriggers(t *testing.T) {
	conn := runtimeConn(t, "scf_app")
	stale := time.Now().Add(-11 * time.Minute)
	fresh := time.Now()
	cases := []struct{ name, sql string }{
		{"account deletion", `UPDATE scf.users SET deleted_at = now(), display_name = NULL, contact_email = NULL WHERE user_id = '` + users[A] + `'`},
		{"ownership transfer", `UPDATE scf.memberships SET role = 'admin' WHERE tenant_id = '` + A + `' AND user_id = '` + users[A] + `'`},
		{"owner removes tenant", `UPDATE scf.tenants SET status = 'removed' WHERE tenant_id = '` + A + `'`},
		{"erasure confirmation", `UPDATE scf.erasure_requests SET status = 'confirmed' WHERE tenant_id = '` + A + `'`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := func(reauth *time.Time) error {
				return inCtx(t, conn, Ctx{Tenant: A, Kind: "user", Actor: users[A], Reauth: reauth}, func(ctx context.Context, tx pgx.Tx) error {
					_, err := tx.Exec(ctx, c.sql)
					return err
				})
			}
			if err := run(&stale); code(err) != "42501" {
				t.Errorf("stale sign-in: want 42501, got %s", sqlState(err))
			}
			if err := run(nil); code(err) != "42501" {
				t.Errorf("no sign-in time: want 42501, got %s", sqlState(err))
			}
			if err := run(&fresh); err != nil {
				t.Errorf("fresh sign-in: %s", sqlState(err))
			}
		})
	}
	// a member that is not the owner cannot change the tenant status at all
	err := inCtx(t, conn, Ctx{Tenant: A, Kind: "user", Actor: users[B], Reauth: &fresh}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.tenants SET status = 'suspended' WHERE tenant_id = $1`, A)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("status change by a non-owner: want 42501, got %s", sqlState(err))
	}
	// is_canary is read-only for runtime roles
	err = inCtx(t, conn, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.tenants SET is_canary = true WHERE tenant_id = $1`, A)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("is_canary change: want 42501, got %s", sqlState(err))
	}
}
