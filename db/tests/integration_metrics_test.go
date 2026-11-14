// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0085: integration client metrics (partner calls, payments, anchors; wire-formats §f.5 4b–4d, §g.8). The writer adds
// rows under the tenant's context; the tenant (scf_app) reads its own; scf_jobs deletes only through retention
// (aggregates) and stream_gc (state); scf_metrics_ro has nothing; the backstops refuse what the Collector would never
// send (free text, URLs, unknown metrics, the wrong network set, shapes); a deleted service takes its rows with it;
// retention keeps 1h 35 days and 1d 25 months.
func TestIntegrationMetrics0085(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	svcA, svcB := uid(A, 3), uid(B, 3)
	writer := runtimeConn(t, "scf_writer")
	app := runtimeConn(t, "scf_app")
	wctx := Ctx{Tenant: A, Kind: "writer", Actor: "writer"}

	type row struct {
		name, metric, network string
		d                     [7]string
		sum                   float64
		hist                  string
	}
	ins := func(tx pgx.Tx, table, tenant, svc string, r row) error {
		h := "NULL"
		if r.hist != "" {
			h = "'" + r.hist + "'::int4[]"
		}
		trunc := map[string]string{"1h": "date_trunc('hour', now(), 'UTC')", "1d": "date_trunc('day', now(), 'UTC')"}[table[len(table)-2:]]
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, fmt.Sprintf(`INSERT INTO scf.%s (tenant_id, service_id, bucket_start, metric, network,
			  d1, d2, d3, d4, d5, d6, d7, count, duration_sum, hist) VALUES ($1, $2, %s - interval '2 days', $3, $4,
			  $5, $6, $7, $8, $9, $10, $11, 1, $12, %s)`, table, trunc, h),
				tenant, svc, r.metric, r.network, r.d[0], r.d[1], r.d[2], r.d[3], r.d[4], r.d[5], r.d[6], r.sum)
			return err
		})
	}
	const h15 = "{0,0,0,0,0,0,0,1,0,0,0,0,0,0,0}"
	good := []row{
		{"partner", "stellar.partner.call.duration", "mainnet", [7]string{"soroswap", "/pools/{id}/{id}", "success"}, 0.4, h15},
		{"payment settled", "payment.server.events", "stellar:pubnet", [7]string{"x402", "settled", "exact", "", "USDC", "0.01_0.1"}, 0, ""},
		{"payment failed", "payment.server.events", "stellar:testnet", [7]string{"mpp", "failed", "stellar", "session", "USDC", "wrong_amount", "session/amount-exceeds-deposit"}, 0, ""},
		{"anchor request", "stellar.anchor.request.duration", "testnet", [7]string{"24", "deposit_interactive", "ok", "testanchor.stellar.org"}, 0.2, h15},
		{"anchor event", "stellar.anchor.events", "testnet", [7]string{"deposit_completed", "24", "testanchor.stellar.org"}, 0, ""},
		{"transfer duration", "stellar.anchor.transfer.duration", "mainnet", [7]string{"24", "deposit", "", "completed"}, 5400, ""},
		{"quotes", "stellar.anchor.quotes.created", "mainnet", [7]string{"", "", "", "", "wallet.example.org"}, 0, ""},
	}
	bad := []row{
		{"duration without histogram", "stellar.partner.call.duration", "mainnet", [7]string{"soroswap", "/quote", "success"}, 0.1, ""},
		{"counter with histogram", "payment.server.events", "stellar:pubnet", [7]string{"x402", "paid"}, 0, h15},
		{"counter with a sum", "stellar.anchor.events", "testnet", [7]string{"deposit_started"}, 1, ""},
		{"long duration with histogram", "stellar.anchor.transfer.duration", "mainnet", [7]string{"24", "deposit", "", "completed"}, 1, h15},
		{"short histogram", "stellar.anchor.request.duration", "testnet", [7]string{"24", "info", "ok"}, 0.1, "{1,2}"},
		{"unknown metric", "http.client.request.duration", "mainnet", [7]string{"/x"}, 0.1, h15},
		{"payment on a Stellar network name", "payment.server.events", "mainnet", [7]string{"x402", "paid"}, 0, ""},
		{"partner on a CAIP-2 network", "stellar.partner.call.duration", "stellar:pubnet", [7]string{"soroswap", "/quote", "success"}, 0.1, h15},
		{"url in a dimension", "stellar.partner.call.duration", "mainnet", [7]string{"soroswap", "https://api.soroswap.finance/quote?k=1", "success"}, 0.1, h15},
		{"address in a dimension", "stellar.anchor.events", "testnet", [7]string{"deposit_started", "24", "g" + strings.Repeat("a", 55) + ".example.org"}, 0, ""},
		{"text in a dimension", "payment.server.events", "stellar:pubnet", [7]string{"x402", "failed", "exact", "", "", "other", "error: bad thing"}, 0, ""},
		{"e-mail in a dimension", "stellar.anchor.quotes.created", "mainnet", [7]string{"", "", "", "", "someone@example.org"}, 0, ""},
		{"overlong short dimension", "payment.server.events", "stellar:pubnet", [7]string{strings.Repeat("a", 65), "paid"}, 0, ""},
	}

	// Writer: own tenant yes; another tenant's row or service no; the backstops.
	if err := inCtx(t, writer, wctx, func(ctx context.Context, tx pgx.Tx) error {
		for _, tb := range []string{"integration_metrics_1h", "integration_metrics_1d"} {
			for _, g := range good {
				if err := ins(tx, tb, A, svcA, g); err != nil {
					t.Errorf("%s %s: writer insert under A: %s", tb, g.name, sqlState(err))
				}
			}
			if err := ins(tx, tb, B, svcB, good[0]); code(err) != "42501" {
				t.Errorf("%s: writer insert of B under A: want 42501, got %q", tb, sqlState(err))
			}
		}
		for _, b := range bad {
			if err := ins(tx, "integration_metrics_1h", A, svcA, b); code(err) != "23514" {
				t.Errorf("%s: want 23514, got %q", b.name, sqlState(err))
			}
		}
		// the grids: an hour row at minute 5, a day row at 01:00
		for tb, ts := range map[string]string{"integration_metrics_1h": "date_trunc('hour', now(), 'UTC') + interval '5 minutes'",
			"integration_metrics_1d": "date_trunc('day', now(), 'UTC') + interval '1 hour'"} {
			if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
				_, err := sp.Exec(ctx, fmt.Sprintf(`INSERT INTO scf.%s (tenant_id, service_id, bucket_start, metric, network, d1, count)
				  VALUES ($1, $2, %s, 'stellar.anchor.events', 'testnet', 'deposit_started', 1)`, tb, ts), A, svcA)
				return err
			}); code(err) != "23514" {
				t.Errorf("%s off-grid bucket: want 23514, got %q", tb, sqlState(err))
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Reads: the tenant sees its own rows only (seeded for A and B); scf_metrics_ro nothing at all; scf_app never writes.
	for _, tb := range []string{"integration_metrics_1h", "integration_metrics_1d"} {
		var own, other int
		if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FILTER (WHERE tenant_id = $1), count(*) FILTER (WHERE tenant_id <> $1) FROM scf.%s`, tb), A).
				Scan(&own, &other)
		}); err != nil {
			t.Fatalf("%s app read: %s", tb, sqlState(err))
		}
		if own == 0 || other != 0 {
			t.Errorf("%s: app under A sees own=%d other=%d (want >0, 0)", tb, own, other)
		}
	}
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.integration_stream_state`).Scan(&n)
	}); code(err) != "42501" {
		t.Errorf("scf_app read of the stream state: want 42501, got %q", sqlState(err))
	}
	ro := runtimeConn(t, "scf_metrics_ro")
	if err := inCtx(t, ro, Ctx{Kind: "op_key", Actor: "k"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.integration_metrics_1d`).Scan(&n)
	}); code(err) != "42501" {
		t.Errorf("scf_metrics_ro read: want 42501, got %q", sqlState(err))
	}
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.integration_metrics_1d SET count = count + 1 WHERE tenant_id = $1`, A)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app update: want 42501, got %q", sqlState(err))
	}

	// Retention: 1h 35 days, 1d 25 months, state 7 days (stream_gc); job retention under the tenant only.
	var keep1h, keep1d, keepState, stateJob string
	if err := su.QueryRow(ctx, `SELECT (SELECT keep::text FROM scf.retention_rules() WHERE relname = 'integration_metrics_1h'),
	    (SELECT keep::text FROM scf.retention_rules() WHERE relname = 'integration_metrics_1d'),
	    (SELECT keep::text FROM scf.retention_rules() WHERE relname = 'integration_stream_state'),
	    (SELECT job FROM scf.retention_rules() WHERE relname = 'integration_stream_state')`).
		Scan(&keep1h, &keep1d, &keepState, &stateJob); err != nil {
		t.Fatal(err)
	}
	if keep1h != "35 days" || keep1d != "2 years 1 mon" || keepState != "7 days" || stateJob != "stream_gc" {
		t.Errorf("retention: 1h %q 1d %q state %q (%s)", keep1h, keep1d, keepState, stateJob)
	}
	// 0080's rules are all still there
	var stellarRules int
	if err := su.QueryRow(ctx, `SELECT count(*) FROM scf.retention_rules() WHERE relname LIKE 'stellar_client_%'`).Scan(&stellarRules); err != nil {
		t.Fatal(err)
	}
	if stellarRules != 4 {
		t.Errorf("0080 retention rules kept: %d (want 4)", stellarRules)
	}
	mustExec(t, su, `INSERT INTO scf.integration_metrics_1h (tenant_id, service_id, bucket_start, metric, network, d1, count)
	  VALUES ($1, $2, date_trunc('hour', now(), 'UTC') - interval '40 days', 'stellar.anchor.events', 'testnet', 'deposit_started', 1),
	         ($3, $4, date_trunc('hour', now(), 'UTC') - interval '40 days', 'stellar.anchor.events', 'testnet', 'deposit_started', 1)`,
		A, svcA, B, svcB)
	t.Cleanup(func() {
		mustExec(t, super(t), `DELETE FROM scf.integration_metrics_1h WHERE bucket_start < now() - interval '36 days'`)
	})
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int64
		if err := tx.QueryRow(ctx, `SELECT scf.retention_apply('integration_metrics_1h')`).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			t.Errorf("retention under A deleted %d (want 1: A's expired row only)", n)
		}
		return nil
	}); err != nil {
		t.Fatalf("retention: %s", sqlState(err))
	}
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.integration_metrics_1d`)
		if err == nil && tag.RowsAffected() != 0 {
			t.Errorf("job web_rollup deleted %d rows (want none: its policy does not cover the table)", tag.RowsAffected())
		}
		return nil
	}); err != nil && code(err) != "42501" {
		t.Errorf("other job delete: %s", sqlState(err))
	}

	// Settings backstop: integers only; the defaults are present.
	for _, k := range []string{"integration_series_cap_per_tenant_day", "integration_series_cap_per_service_day", "integration_stream_cap_per_tenant"} {
		if err := savepointErr(t, su, `UPDATE scf.settings SET value = '"many"' WHERE key = $1`, k); code(err) != "23514" {
			t.Errorf("%s non-integer: want 23514, got %q", k, sqlState(err))
		}
	}
	var caps int
	if err := su.QueryRow(ctx, `SELECT count(*) FROM scf.settings WHERE key LIKE 'integration_%' AND public`).Scan(&caps); err != nil || caps != 3 {
		t.Errorf("cap settings: %d %v (want 3)", caps, err)
	}

	// Purge path: the rows of the three tables go with the service through the cascade (rolled back).
	if err := inCtx(t, su, Ctx{}, func(ctx context.Context, tx pgx.Tx) error {
		for _, rel := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d", "api_service_day_groups",
			"api_route_day", "api_routes", "api_stream_groups", "api_stream_state", "api_ingest_counters",
			"api_service_assurance", "onchain_daily", "declared_contracts", "api_services"} {
			if _, err := tx.Exec(ctx, "DELETE FROM scf."+rel+" WHERE tenant_id = $1", A); err != nil {
				return fmt.Errorf("%s: %w", rel, err)
			}
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM scf.integration_metrics_1h WHERE tenant_id = $1)
		    + (SELECT count(*) FROM scf.integration_metrics_1d WHERE tenant_id = $1)
		    + (SELECT count(*) FROM scf.integration_stream_state WHERE tenant_id = $1)`, A).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Errorf("rows left after the service was deleted: %d", n)
		}
		return nil
	}); err != nil {
		t.Fatalf("cascade: %s", sqlState(err))
	}
}
