// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0080: Stellar SDK client metrics (C-153). The writer adds rows under the tenant's context; the tenant (scf_app)
// reads its own; scf_jobs deletes only through retention (aggregates) and stream_gc (state); scf_metrics_ro and the
// op definer have nothing; the closed-set backstops refuse what the Collector would never send; a deleted service
// takes its rows with it (the tenant purge path); retention keeps 1h/1d for 25 months.
func TestStellarClient0080(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	svcA, svcB := uid(A, 3), uid(B, 3)
	writer := runtimeConn(t, "scf_writer")
	app := runtimeConn(t, "scf_app")
	wctx := Ctx{Tenant: A, Kind: "writer", Actor: "writer"}

	ins := func(tx pgx.Tx, table, tenant, svc, metric, op, variant, outcome string, hist string) error {
		h := "NULL"
		if hist != "" {
			h = "'" + hist + "'::int4[]"
		}
		trunc := map[string]string{"1m": "date_trunc('minute', now())", "1h": "date_trunc('hour', now(), 'UTC')",
			"1d": "date_trunc('day', now(), 'UTC')"}[table[len(table)-2:]]
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, fmt.Sprintf(`INSERT INTO scf.%s (tenant_id, service_id, bucket_start, metric, network,
			  operation, variant, outcome, count, hist) VALUES ($1, $2, %s - interval '2 days', $3, 'mainnet', $4, $5, $6, 1, %s)`,
				table, trunc, h), tenant, svc, metric, op, variant, outcome)
			return err
		})
	}
	const h15 = "{0,0,0,0,0,0,0,1,0,0,0,0,0,0,0}"

	// Writer: own tenant yes; another tenant's row or service no; the backstops.
	if err := inCtx(t, writer, wctx, func(ctx context.Context, tx pgx.Tx) error {
		for _, tb := range []string{"stellar_client_1m", "stellar_client_1h", "stellar_client_1d"} {
			if err := ins(tx, tb, A, svcA, "rpc.client.call.duration", "sendTransaction", "", "-32602", h15); err != nil {
				t.Errorf("%s: writer insert under A: %s", tb, sqlState(err))
			}
			if err := ins(tx, tb, B, svcB, "rpc.client.call.duration", "sendTransaction", "", "", h15); code(err) != "42501" {
				t.Errorf("%s: writer insert of B under A: want 42501, got %q", tb, sqlState(err))
			}
		}
		bad := []struct {
			name, metric, op, variant, outcome, hist string
		}{
			{"duration without histogram", "rpc.client.call.duration", "getHealth", "", "", ""},
			{"counter with histogram", "stellar.tx.submissions", "rpc", "PENDING", "", h15},
			{"short histogram", "http.client.request.duration", "/accounts/{id}", "GET", "200", "{1,2}"},
			{"unknown metric", "http.server.request.duration", "/x", "GET", "200", h15},
			{"url in operation", "http.client.request.duration", "https://rpc.example/key", "GET", "200", h15},
			{"address in operation", "http.client.request.duration", "/accounts/G" + fmt.Sprintf("%065d", 0), "GET", "", h15},
			{"text in outcome", "rpc.client.call.duration", "getHealth", "", "error: bad thing", h15},
		}
		for _, b := range bad {
			if err := ins(tx, "stellar_client_1m", A, svcA, b.metric, b.op, b.variant, b.outcome, b.hist); code(err) != "23514" {
				t.Errorf("%s: want 23514, got %q", b.name, sqlState(err))
			}
		}
		return savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `INSERT INTO scf.stellar_client_1m (tenant_id, service_id, bucket_start, metric, network,
			  operation, variant, outcome, count) VALUES ($1, $2, date_trunc('minute', now()), 'stellar.tx.polls', 'pubnet', 'rpc', 'SUCCESS', '', 1)`,
				A, svcA)
			if code(err) != "23514" {
				t.Errorf("unknown network: want 23514, got %q", sqlState(err))
			}
			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}

	// Reads: the tenant sees its own rows only; the writer may read (upserts); scf_metrics_ro nothing at all.
	for _, tb := range []string{"stellar_client_1m", "stellar_client_1h", "stellar_client_1d"} {
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
	ro := runtimeConn(t, "scf_metrics_ro")
	if err := inCtx(t, ro, Ctx{Kind: "op_key", Actor: "k"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.stellar_client_1d`).Scan(&n)
	}); code(err) != "42501" {
		t.Errorf("scf_metrics_ro read: want 42501, got %q", sqlState(err))
	}
	// scf_app never writes.
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.stellar_client_1d SET count = count + 1 WHERE tenant_id = $1`, A)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app update: want 42501, got %q", sqlState(err))
	}

	// Retention: 1h/1d kept 25 months, 1m 35 days; job retention under the tenant only.
	var keep1d, keep1m string
	if err := su.QueryRow(ctx, `SELECT (SELECT keep::text FROM scf.retention_rules() WHERE relname = 'stellar_client_1d'),
	    (SELECT keep::text FROM scf.retention_rules() WHERE relname = 'stellar_client_1m')`).Scan(&keep1d, &keep1m); err != nil {
		t.Fatal(err)
	}
	if keep1d != "2 years 1 mon" || keep1m != "35 days" {
		t.Errorf("retention: 1d %q 1m %q", keep1d, keep1m)
	}
	mustExec(t, su, `INSERT INTO scf.stellar_client_1m (tenant_id, service_id, bucket_start, metric, network, operation, variant, outcome, count)
	  VALUES ($1, $2, date_trunc('minute', now()) - interval '40 days', 'stellar.tx.polls', 'testnet', 'rpc', 'SUCCESS', '', 1),
	         ($3, $4, date_trunc('minute', now()) - interval '40 days', 'stellar.tx.polls', 'testnet', 'rpc', 'SUCCESS', '', 1)`,
		A, svcA, B, svcB)
	t.Cleanup(func() {
		mustExec(t, super(t), `DELETE FROM scf.stellar_client_1m WHERE bucket_start < now() - interval '36 days'`)
	})
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int64
		if err := tx.QueryRow(ctx, `SELECT scf.retention_apply('stellar_client_1m')`).Scan(&n); err != nil {
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
		tag, err := tx.Exec(ctx, `DELETE FROM scf.stellar_client_1d`)
		if err == nil && tag.RowsAffected() != 0 {
			t.Errorf("job web_rollup deleted %d rows (want none: its policy does not cover the table)", tag.RowsAffected())
		}
		return nil
	}); err != nil && code(err) != "42501" {
		t.Errorf("other job delete: %s", sqlState(err))
	}

	// Settings backstop: an integer only.
	if err := savepointErr(t, su, `UPDATE scf.settings SET value = '"many"' WHERE key = 'stellar_client_series_cap_per_tenant_day'`); code(err) != "23514" {
		t.Errorf("non-integer cap: want 23514, got %q", sqlState(err))
	}

	// Purge path: job tenant_purge deletes api_services under the tenant's context (children first, as
	// services/jobs PURGE_TABLES); the rows of the four tables go with the service through the cascade, RLS forced.
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}, func(ctx context.Context, tx pgx.Tx) error {
		for _, rel := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d", "api_service_day_groups",
			"api_route_day", "api_routes", "api_stream_groups", "api_stream_state", "api_ingest_counters",
			"api_service_assurance", "onchain_daily", "declared_contracts", "api_services"} {
			if _, err := tx.Exec(ctx, "DELETE FROM scf."+rel+" WHERE tenant_id = $1", A); err != nil {
				return fmt.Errorf("%s: %w", rel, err)
			}
		}
		return nil // the cascade ran as scf_jobs without a permission or row-security error
	}); err != nil {
		t.Fatalf("purge path: %s", sqlState(err))
	}
	// what the cascade leaves (scf_jobs cannot read these tables): the same deletes as the superuser, rolled back
	if err := inCtx(t, su, Ctx{}, func(ctx context.Context, tx pgx.Tx) error {
		for _, rel := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d", "api_service_day_groups",
			"api_route_day", "api_routes", "api_stream_groups", "api_stream_state", "api_ingest_counters",
			"api_service_assurance", "onchain_daily", "declared_contracts", "api_services"} {
			if _, err := tx.Exec(ctx, "DELETE FROM scf."+rel+" WHERE tenant_id = $1", A); err != nil {
				return fmt.Errorf("%s: %w", rel, err)
			}
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM scf.stellar_client_1m WHERE tenant_id = $1)
		    + (SELECT count(*) FROM scf.stellar_client_1h WHERE tenant_id = $1) + (SELECT count(*) FROM scf.stellar_client_1d WHERE tenant_id = $1)
		    + (SELECT count(*) FROM scf.stellar_client_stream_state WHERE tenant_id = $1)`, A).Scan(&n); err != nil {
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

// savepointErr runs one statement in a transaction that is rolled back and returns its error.
func savepointErr(t *testing.T, c *pgx.Conn, sql string, args ...any) error {
	t.Helper()
	ctx := context.Background()
	tx, err := c.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, sql, args...)
	return err
}
