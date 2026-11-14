// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0061 (C-124): the platform setting, its value check and the `unknown` threshold defaults.
func TestMultiplicityModeSetting0061(t *testing.T) {
	ctx := context.Background()
	m := migrator(t)
	var mode, mult, events string
	if err := m.QueryRow(ctx, `SELECT value #>> '{}' FROM scf.settings WHERE key = 'multiplicity_mode'`).Scan(&mode); err != nil {
		t.Fatal(sqlState(err))
	}
	if mode != "enforce" {
		t.Errorf("multiplicity_mode default %q, want enforce", mode)
	}
	if err := m.QueryRow(ctx, `SELECT (value #>> '{exact_ip,unknown}') || '/' || (value #>> '{subnet,unknown}')
	                             FROM scf.settings WHERE key = 'multiplicity_thresholds'`).Scan(&mult); err != nil {
		t.Fatal(sqlState(err))
	}
	if err := m.QueryRow(ctx, `SELECT (value #>> '{exact_ip,unknown}') || '/' || (value #>> '{subnet,unknown}')
	                             FROM scf.settings WHERE key = 'multiplicity_event_thresholds'`).Scan(&events); err != nil {
		t.Fatal(sqlState(err))
	}
	if mult != "40/160" || events != "400/1600" {
		t.Errorf("unknown thresholds %s and %s, want 40/160 and 400/1600 (= eyeball_mobile)", mult, events)
	}
	// the value check holds for every writer (the operator's path is scf_app + audit, settings_write policy)
	tx, err := m.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE scf.settings SET value = '"shadow"' WHERE key = 'multiplicity_mode'`); err != nil {
		t.Errorf("shadow refused: %s", sqlState(err))
	}
	err = savepoint(ctx, tx, func(sp pgx.Tx) error {
		_, err := sp.Exec(ctx, `UPDATE scf.settings SET value = '"off"' WHERE key = 'multiplicity_mode'`)
		return err
	})
	if code(err) != "23514" {
		t.Errorf(`multiplicity_mode = "off": want 23514, got %s`, sqlState(err))
	}
}

// 0061 (C-124): only an operator_admin with step-up sets a site's override, through the audited definer function;
// the tenant (scf_app under its own context) cannot write the column, but still updates every other site column.
func TestOpSetSiteMultiplicityMode0061(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	siteA, siteB := uid(A, 1), uid(B, 1)

	// tenant member: column not writable; another column still is
	err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `UPDATE scf.sites SET multiplicity_mode = 'shadow' WHERE site_id = $1`, siteA)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("tenant writes multiplicity_mode: want 42501, got %s", sqlState(err))
		}
		tag, err := tx.Exec(ctx, `UPDATE scf.sites SET name = name, path_folding = path_folding WHERE site_id = $1`, siteA)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			t.Errorf("tenant update of other columns: %d rows", tag.RowsAffected())
		}
		return tx.Rollback(ctx)
	})
	if err != nil && err != pgx.ErrTxClosed {
		t.Fatal(sqlState(err))
	}

	// a plain operator, and an admin without step-up, are refused before anything is read
	for name, c := range map[string]Ctx{"operator": operatorCtx(true), "admin without step-up": func() Ctx {
		c := adminCtx()
		c.StepUp = nil
		return c
	}()} {
		err := inCtx(t, app, c, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.op_set_site_multiplicity_mode($1, $2, 'shadow')`, A, siteA)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("%s: want 42501, got %s", name, sqlState(err))
		}
	}

	err = inCtx(t, app, adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		var eff string
		if err := tx.QueryRow(ctx, `SELECT scf.op_set_site_multiplicity_mode($1, $2, 'shadow')`, A, siteA).Scan(&eff); err != nil {
			return err
		}
		if eff != "shadow" {
			t.Errorf("effective mode after shadow: %q", eff)
		}
		var col *string
		var audits int
		if err := tx.QueryRow(ctx, `SELECT (scf.op_tenant_detail($1) -> 'sites' -> 0 ->> 'multiplicity_mode')`, A).Scan(&col); err != nil {
			return err
		}
		if col == nil || *col != "shadow" {
			t.Errorf("op_tenant_detail site multiplicity_mode = %v, want shadow", col)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.audit_log WHERE action = 'site.multiplicity_mode_set'
		                              AND details ->> 'to' = 'shadow' AND details ->> 'site_id' = $1`, siteA).Scan(&audits); err != nil {
			return err
		}
		if audits != 1 {
			t.Errorf("audit rows site.multiplicity_mode_set: %d, want 1", audits)
		}
		// NULL = inherit: the effective mode is the platform setting
		if err := tx.QueryRow(ctx, `SELECT scf.op_set_site_multiplicity_mode($1, $2, NULL)`, A, siteA).Scan(&eff); err != nil {
			return err
		}
		if eff != "enforce" {
			t.Errorf("effective mode after inherit: %q, want the platform setting enforce", eff)
		}
		for name, q := range map[string]struct {
			sql, want string
			args      []any
		}{
			"bad mode":     {`SELECT scf.op_set_site_multiplicity_mode($1, $2, 'off')`, "22023", []any{A, siteA}},
			"foreign site": {`SELECT scf.op_set_site_multiplicity_mode($1, $2, 'shadow')`, "P0002", []any{A, siteB}},
			"unknown site": {`SELECT scf.op_set_site_multiplicity_mode($1, $2, 'shadow')`, "P0002", []any{A, uid(A, 99)}},
		} {
			err := savepoint(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, q.sql, q.args...)
				return err
			})
			if code(err) != q.want {
				t.Errorf("%s: want %s, got %s", name, q.want, sqlState(err))
			}
		}
		return tx.Rollback(ctx)
	})
	if err != nil && err != pgx.ErrTxClosed {
		t.Fatal(sqlState(err))
	}
}
