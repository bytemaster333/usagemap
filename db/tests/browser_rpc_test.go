// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0086 (tracker 1.2.0): the browser Stellar RPC / Horizon aggregate (wire-formats §a.3.2) and the Stellar event
// schema v1 additions (§a.3.1). The internal counter endpoint (scf_app, actor system) adds rows under the tenant's
// context; the tenant reads its own only; writer and metrics_ro have no access; the retention job deletes days older
// than 25 months under the tenant only; the cell checks refuse anything outside the closed lists; a deleted site takes
// its rows with it; edge_counter_features accepts "rpc"; the property rollup accepts the new events, keys and values.
func TestBrowserRPC0086(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	siteA, siteB := uid(A, 1), uid(B, 1)
	app := runtimeConn(t, "scf_app")
	sys := Ctx{Tenant: A, Kind: "system", Actor: "edge"}
	ins := func(tx pgx.Tx, tenant, site string, cell [6]string) error {
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `INSERT INTO scf.web_rpc_client_daily (tenant_id, site_id, day, api, operation, network,
			  outcome, latency, verdict, count) VALUES ($1, $2, current_date, $3, $4, $5, $6, $7, $8, 2)
			  ON CONFLICT (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict)
			  DO UPDATE SET count = scf.web_rpc_client_daily.count + EXCLUDED.count`,
				tenant, site, cell[0], cell[1], cell[2], cell[3], cell[4], cell[5])
			return err
		})
	}
	if err := inCtx(t, app, sys, func(ctx context.Context, tx pgx.Tx) error {
		for _, ok := range [][6]string{
			{"rpc", "simulate_transaction", "mainnet", "ok", "lt100ms", "verified"},
			{"rpc", "other", "testnet", "rpc_error", "gt2000ms", "suspect"},
			{"horizon", "accounts_id_data_key", "unknown", "http_429", "100_500ms", "verified"},
			{"horizon", "other", "local", "network_error", "500_2000ms", "verified"},
		} {
			if err := ins(tx, A, siteA, ok); err != nil {
				t.Errorf("%v: %s", ok, sqlState(err))
			}
		}
		// the upsert adds (savepoints roll back, so both inserts and the read share one)
		if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			for range 2 {
				if _, err := sp.Exec(ctx, `INSERT INTO scf.web_rpc_client_daily (tenant_id, site_id, day, api, operation, network,
				  outcome, latency, verdict, count) VALUES ($1, $2, current_date, 'rpc', 'get_fee_stats', 'mainnet', 'ok', 'lt100ms',
				  'verified', 2) ON CONFLICT (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict)
				  DO UPDATE SET count = scf.web_rpc_client_daily.count + EXCLUDED.count`, A, siteA); err != nil {
					return err
				}
			}
			var n int64
			if err := sp.QueryRow(ctx, `SELECT count FROM scf.web_rpc_client_daily WHERE tenant_id = $1
			    AND operation = 'get_fee_stats'`, A).Scan(&n); err != nil || n != 4 {
				t.Errorf("upsert: count %d %v (want 4)", n, err)
			}
			return nil
		}); err != nil {
			t.Errorf("upsert: %s", sqlState(err))
		}
		if err := ins(tx, B, siteB, [6]string{"rpc", "get_health", "mainnet", "ok", "lt100ms", "verified"}); code(err) != "42501" {
			t.Errorf("insert of B under A: want 42501, got %q", sqlState(err))
		}
		for _, bad := range [][6]string{
			{"rpc", "accounts_id", "mainnet", "ok", "lt100ms", "verified"},          // a Horizon route under rpc
			{"horizon", "send_transaction", "mainnet", "ok", "lt100ms", "verified"}, // an RPC method under horizon
			{"rpc", "getHealth", "mainnet", "ok", "lt100ms", "verified"},            // not snake case
			{"rpc", "get_health", "pubnet", "ok", "lt100ms", "verified"},
			{"rpc", "get_health", "mainnet", "200", "lt100ms", "verified"},
			{"rpc", "get_health", "mainnet", "ok", "17ms", "verified"},
			{"rpc", "get_health", "mainnet", "ok", "lt100ms", "rejected"},
			{"graphql", "get_health", "mainnet", "ok", "lt100ms", "verified"},
		} {
			if err := ins(tx, A, siteA, bad); code(err) != "23514" {
				t.Errorf("%v: want 23514, got %q", bad, sqlState(err))
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Committed rows for the read and retention checks (inCtx always rolls back).
	mustExec(t, su, `INSERT INTO scf.web_rpc_client_daily (tenant_id, site_id, day, api, operation, network, outcome, latency, verdict, count)
	    VALUES ($1, $2, current_date, 'rpc', 'get_events', 'mainnet', 'ok', 'lt100ms', 'verified', 3),
	           ($1, $2, current_date - interval '26 months', 'rpc', 'get_events', 'mainnet', 'ok', 'lt100ms', 'verified', 1),
	           ($1, $2, current_date - interval '24 months', 'rpc', 'get_ledgers', 'mainnet', 'ok', 'lt100ms', 'verified', 1),
	           ($3, $4, current_date - interval '26 months', 'rpc', 'get_events', 'mainnet', 'ok', 'lt100ms', 'verified', 1)`,
		A, siteA, B, siteB)
	t.Cleanup(func() {
		mustExec(t, super(t), `DELETE FROM scf.web_rpc_client_daily WHERE operation IN ('get_events', 'get_ledgers')`)
	})
	var own, other int
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE tenant_id = $1), count(*) FILTER (WHERE tenant_id <> $1)
		  FROM scf.web_rpc_client_daily`, A).Scan(&own, &other)
	}); err != nil || own < 3 || other != 0 {
		t.Fatalf("tenant read: own=%d other=%d err=%v", own, other, err)
	}
	for _, role := range []struct {
		name string
		c    Ctx
	}{{"scf_writer", Ctx{Tenant: A, Kind: "writer", Actor: "writer"}}, {"scf_metrics_ro", Ctx{Kind: "op_key", Actor: "k"}}} {
		conn := runtimeConn(t, role.name)
		if err := inCtx(t, conn, role.c, func(ctx context.Context, tx pgx.Tx) error {
			var n int
			return tx.QueryRow(ctx, `SELECT count(*) FROM scf.web_rpc_client_daily`).Scan(&n)
		}); code(err) != "42501" {
			t.Errorf("%s read: want 42501, got %q", role.name, sqlState(err))
		}
	}
	// scf_app cannot delete (only the retention job and the site cascade remove rows).
	if err := inCtx(t, app, sys, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM scf.web_rpc_client_daily WHERE tenant_id = $1`, A)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app delete: want 42501, got %q", sqlState(err))
	}

	// Retention: 25 months (aggregates ≥ 24 months), job retention under the tenant only.
	var keep string
	if err := su.QueryRow(ctx, `SELECT keep::text FROM scf.retention_rules() WHERE relname = 'web_rpc_client_daily'
	    AND mechanism = 'delete' AND job = 'retention' AND tenant_scoped`).Scan(&keep); err != nil || keep != "2 years 1 mon" {
		t.Fatalf("retention rule: %q %v", keep, err)
	}
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int64
		if err := tx.QueryRow(ctx, `SELECT scf.retention_apply('web_rpc_client_daily')`).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			t.Errorf("retention under A deleted %d (want 1: A's 26-month-old row only)", n)
		}
		return nil
	}); err != nil {
		t.Fatalf("retention: %s", sqlState(err))
	}
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.web_rpc_client_daily`)
		if err == nil && tag.RowsAffected() != 0 {
			t.Errorf("job web_rollup deleted %d rows (want none)", tag.RowsAffected())
		}
		return nil
	}); err != nil && code(err) != "42501" {
		t.Errorf("other job delete: %s", sqlState(err))
	}

	// Settings: "rpc" is accepted next to the others, unknown parts are not.
	if _, err := su.Exec(ctx, `UPDATE scf.settings SET value = '["props","dev","app","rpc"]' WHERE key = 'edge_counter_features'`); err != nil {
		t.Errorf("rpc feature: %s", sqlState(err))
	}
	if err := savepointErr(t, su, `UPDATE scf.settings SET value = '["rpc","bogus"]' WHERE key = 'edge_counter_features'`); code(err) != "23514" {
		t.Errorf("unknown feature: want 23514, got %q", sqlState(err))
	}
	if _, err := su.Exec(ctx, `UPDATE scf.settings SET value = '[]' WHERE key = 'edge_counter_features'`); err != nil {
		t.Fatal(err)
	}

	// Stellar event schema v1 additions (§a.3.1) in the property rollup.
	if err := inCtx(t, app, sys, func(ctx context.Context, tx pgx.Tx) error {
		prop := func(event, key, value string) error {
			return savepoint(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, `INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network,
				  prop_key, prop_value, verdict, count) VALUES ($1, $2, current_date, $3, 'mainnet', $4, $5, 'verified', 1)`,
					A, siteA, event, key, value)
				return err
			})
		}
		for _, ok := range [][3]string{
			{"wallet_connect_failed", "failure_reason", "wallet_not_installed"},
			{"wallet_connect_failed", "wallet_context", "varial_inapp"},
			{"walletconnect_session", "wc_state", "proposed"},
			{"walletconnect_request", "wc_method", "sign_submit_xdr"},
			{"wallet_connect", "wallet", "privy"},
		} {
			if err := prop(ok[0], ok[1], ok[2]); err != nil {
				t.Errorf("%v: %s", ok, sqlState(err))
			}
		}
		for _, bad := range [][3]string{
			{"wallet_connect_failed", "failure_reason", "cancelled"},
			{"walletconnect_request", "wc_method", "eth_sign"},
			{"wallet_connected_failed", "_total", "all"},
		} {
			if err := prop(bad[0], bad[1], bad[2]); code(err) != "23514" {
				t.Errorf("%v: want 23514, got %q", bad, sqlState(err))
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// A deleted site takes its rows with it (the tenant purge deletes sites): the foreign key cascades.
	var n int
	if err := su.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE conrelid = 'scf.web_rpc_client_daily'::regclass
	    AND contype = 'f' AND confrelid = 'scf.sites'::regclass AND confdeltype = 'c'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("cascade FK to sites: %d %v", n, err)
	}
	// Privacy: counts per day and closed cells only.
	cols, err := queryStrings(ctx, su, `SELECT column_name FROM information_schema.columns
	    WHERE table_schema = 'scf' AND table_name = 'web_rpc_client_daily' ORDER BY column_name`)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(cols); got != 10 {
		t.Errorf("columns: %v", cols)
	}
}
