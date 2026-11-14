// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0084: self-attested app events (wire-formats §a.9). The internal counter endpoint (scf_app, actor system) adds rows
// under the tenant's context; the tenant reads its own only; no other role (writer, jobs, metrics_ro) has access; the
// cell rule refuses identifiers, free text and anything but `self_attested`; a deleted site takes its rows with it
// (the tenant purge path); edge_counter_features accepts "app" and nothing unknown.
func TestAppEvents0084(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	siteA, siteB := uid(A, 1), uid(B, 1)
	app := runtimeConn(t, "scf_app")
	sys := Ctx{Tenant: A, Kind: "system", Actor: "edge"}
	ins := func(tx pgx.Tx, tenant, site, event, key, value, attestation string) error {
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key,
			  prop_value, attestation, count) VALUES ($1, $2, current_date, 'ios', $3, $4, $5, $6, 1)
			  ON CONFLICT (tenant_id, site_id, day, platform, event_name, prop_key, prop_value) DO UPDATE SET count = scf.app_event_daily.count + 1`,
				tenant, site, event, key, value, attestation)
			return err
		})
	}
	if err := inCtx(t, app, sys, func(ctx context.Context, tx pgx.Tx) error {
		for _, ok := range [][3]string{{"swap_started", "_total", "all"}, {"swap_started", "tier", "pro"},
			{"_session", "_total", "all"}, {"_session", "app_version", "1.4.2"}, {"_session", "sdk_version", "mobile-rn/0.1.0"},
			{"_session", "tma_platform", "desktop"}, {"_dropped", "reason", "stale"}} {
			if err := ins(tx, A, siteA, ok[0], ok[1], ok[2], "self_attested"); err != nil {
				t.Errorf("%v: %s", ok, sqlState(err))
			}
		}
		if err := ins(tx, B, siteB, "x", "_total", "all", "self_attested"); code(err) != "42501" {
			t.Errorf("insert of B under A: want 42501, got %q", sqlState(err))
		}
		for _, bad := range [][4]string{
			{"swap_started", "memo", "Hello world", "self_attested"},
			{"swap_started", "to", "GABC", "self_attested"},
			{"swap_started", "_total", "1", "self_attested"},
			{"_session", "device_id", "abc", "self_attested"},
			{"_session", "app_version", "1.4.2-beta", "self_attested"},
			{"_session", "tma_platform", "tdesktop", "self_attested"},
			{"_dropped", "reason", "other", "self_attested"},
			{"a b", "_total", "all", "self_attested"},
			{"swap_started", "_total", "all", "verified"},
		} {
			if err := ins(tx, A, siteA, bad[0], bad[1], bad[2], bad[3]); code(err) != "23514" {
				t.Errorf("%v: want 23514, got %q", bad, sqlState(err))
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Committed rows for the read checks (inCtx always rolls back).
	mustExec(t, su, `INSERT INTO scf.app_event_daily (tenant_id, site_id, day, platform, event_name, prop_key, prop_value, count)
	    VALUES ($1, $2, current_date, 'ios', 'a', '_total', 'all', 3), ($3, $4, current_date, 'android', 'b', '_total', 'all', 1)`,
		A, siteA, B, siteB)
	defer mustExec(t, su, `DELETE FROM scf.app_event_daily WHERE event_name IN ('a', 'b') AND tenant_id IN ($1, $2)`, A, B)
	var own, other int
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE tenant_id = $1), count(*) FILTER (WHERE tenant_id <> $1)
		  FROM scf.app_event_daily`, A).Scan(&own, &other)
	}); err != nil || own < 2 || other != 0 {
		t.Fatalf("tenant read: own=%d other=%d err=%v", own, other, err)
	}
	for _, role := range []struct {
		name string
		c    Ctx
	}{{"scf_writer", Ctx{Tenant: A, Kind: "writer", Actor: "writer"}}, {"scf_jobs", Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}},
		{"scf_metrics_ro", Ctx{Kind: "op_key", Actor: "k"}}} {
		conn := runtimeConn(t, role.name)
		if err := inCtx(t, conn, role.c, func(ctx context.Context, tx pgx.Tx) error {
			var n int
			return tx.QueryRow(ctx, `SELECT count(*) FROM scf.app_event_daily`).Scan(&n)
		}); code(err) != "42501" {
			t.Errorf("%s read: want 42501, got %q", role.name, sqlState(err))
		}
	}
	// Settings: "app" is accepted, unknown parts are not.
	if _, err := su.Exec(ctx, `UPDATE scf.settings SET value = '["props","dev","app"]' WHERE key = 'edge_counter_features'`); err != nil {
		t.Errorf("app feature: %s", sqlState(err))
	}
	if _, err := su.Exec(ctx, `UPDATE scf.settings SET value = '["bogus"]' WHERE key = 'edge_counter_features'`); code(err) != "23514" {
		t.Errorf("unknown feature: want 23514, got %q", sqlState(err))
	}
	if _, err := su.Exec(ctx, `UPDATE scf.settings SET value = '[]' WHERE key = 'edge_counter_features'`); err != nil {
		t.Fatal(err)
	}
	// A deleted site takes its rows with it (the tenant purge deletes sites): the foreign key cascades.
	var n int
	if err := su.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'scf.app_event_daily'::regclass
	    AND contype = 'f' AND confrelid = 'scf.sites'::regclass AND confdeltype = 'c'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("cascade FK to sites: %d %v", n, err)
	}
}
