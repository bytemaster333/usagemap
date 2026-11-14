// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Partition management (docs/data-model.md §10, C-109): scf.ensure_partitions() / scf.drop_expired_partitions(),
// run by job `partitions` (scf_jobs through PgBouncer), create partitions in scf_part with ENABLE + FORCE, every parent
// policy (incl. tenant_backstop_delete) and no grants; expired partitions are detached and dropped; api_metrics_1d is
// kept for ever; web_hourly_totals is monthly and kept 25 months.

func jobsCall(t *testing.T, sql string) (int, error) {
	t.Helper()
	conn := runtimeConn(t, "scf_jobs")
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := setCtx(ctx, tx, Ctx{Kind: "job", Actor: "partitions", Job: "partitions"}); err != nil {
		t.Fatal(sqlState(err))
	}
	var n int
	if err := tx.QueryRow(ctx, sql).Scan(&n); err != nil {
		_ = tx.Rollback(ctx)
		return 0, err
	}
	return n, tx.Commit(ctx)
}

func gatesClean(t *testing.T, ids ...string) {
	t.Helper()
	gates := loadGates(t)
	for _, id := range ids {
		rows, err := runGate(t, context.Background(), migrator(t), gates[id])
		if err != nil || len(rows) > 0 {
			t.Errorf("gate %s after partition maintenance: %v %v", id, rows, err)
		}
	}
}

func TestEnsurePartitions(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	// every spec has its current and future partitions: 1m today+7 days, 1h and web_hourly_totals month+2, 1d year+1
	want, err := queryStrings(ctx, su, `
	  SELECT s.tbl || '_' || to_char(date_trunc(s.unit, now() AT TIME ZONE 'UTC') + (i || ' ' || s.unit)::interval,
	                                 CASE s.unit WHEN 'day' THEN 'YYYYMMDD' WHEN 'month' THEN 'YYYYMM' ELSE 'YYYY' END)
	    FROM scf_admin.partition_specs() s, generate_series(0, s.ahead) i
	  EXCEPT SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'scf_part'::regnamespace`)
	if err != nil || len(want) > 0 {
		t.Fatalf("missing partitions: %v %v", want, err)
	}
	if n, err := jobsCall(t, `SELECT scf.ensure_partitions()`); err != nil || n != 0 {
		t.Errorf("ensure_partitions on a complete set: want 0, got %d %s", n, sqlState(err))
	}
	// drop the farthest-ahead 1m partition; job partitions recreates exactly that one, secured
	var far string
	if err := su.QueryRow(ctx, `SELECT 'api_metrics_1m_' || to_char((now() AT TIME ZONE 'UTC')::date + 7, 'YYYYMMDD')`).Scan(&far); err != nil {
		t.Fatal(err)
	}
	mustExec(t, su, fmt.Sprintf(`DROP TABLE scf_part.%s`, far))
	if n, err := jobsCall(t, `SELECT scf.ensure_partitions()`); err != nil || n != 1 {
		t.Fatalf("ensure_partitions after a drop: want 1, got %d %s", n, sqlState(err))
	}
	var rls, force bool
	var policies, grants int
	if err := su.QueryRow(ctx, `SELECT c.relrowsecurity, c.relforcerowsecurity,
	      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid),
	      COALESCE(cardinality(c.relacl), 0)
	    FROM pg_class c WHERE c.oid = ('scf_part.' || $1)::regclass`, far).Scan(&rls, &force, &policies, &grants); err != nil {
		t.Fatal(err)
	}
	var parentPolicies int
	_ = su.QueryRow(ctx, `SELECT count(*) FROM pg_policy WHERE polrelid = 'scf.api_metrics_1m'::regclass`).Scan(&parentPolicies)
	if !rls || !force || policies != parentPolicies || policies < 9 {
		t.Errorf("new partition: rls=%v force=%v policies=%d (parent %d)", rls, force, policies, parentPolicies)
	}
	var acl []string
	_ = su.QueryRow(ctx, `SELECT COALESCE(relacl::text[], '{}') FROM pg_class WHERE oid = ('scf_part.' || $1)::regclass`, far).Scan(&acl)
	for _, a := range acl {
		if len(a) > 0 && a[0] != '=' && !hasPrefix(a, "scf_migrator=") {
			t.Errorf("partition grant to a role other than its owner: %s", a)
		}
	}
	gatesClean(t, "G1", "G2", "G3", "G7")
	// only scf_jobs may run them
	for _, role := range []string{"scf_app", "scf_writer", "scf_metrics_ro"} {
		conn := runtimeConn(t, role)
		if _, err := conn.Exec(ctx, `SELECT scf.ensure_partitions()`); code(err) != "42501" {
			t.Errorf("%s ensure_partitions: want 42501, got %s", role, sqlState(err))
		}
	}
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }

func TestDropExpiredPartitions(t *testing.T) {
	su := super(t)
	old := []struct{ parent, name, from, to string }{
		{"api_metrics_1m", "api_metrics_1m_20240101", "2024-01-01", "2024-01-02"},
		{"api_metrics_1h", "api_metrics_1h_202301", "2023-01-01", "2023-02-01"},
		{"web_hourly_totals", "web_hourly_totals_202301", "2023-01-01", "2023-02-01"},
		{"api_metrics_1d", "api_metrics_1d_2020", "2020-01-01", "2021-01-01"}, // kept indefinitely
	}
	for _, p := range old {
		mustExec(t, su, fmt.Sprintf(`CREATE TABLE scf_part.%s PARTITION OF scf.%s FOR VALUES FROM ('%s 00:00+00') TO ('%s 00:00+00')
		  WITH (fillfactor = 80)`, p.name, p.parent, p.from, p.to))
		mustExec(t, su, fmt.Sprintf(`SELECT scf_admin.secure_partition('scf_part.%s'::regclass, 'scf.%s'::regclass)`, p.name, p.parent))
	}
	t.Cleanup(func() { mustExec(t, su, `DROP TABLE IF EXISTS scf_part.api_metrics_1d_2020`) })
	gatesClean(t, "G1", "G3", "G7")
	n, err := jobsCall(t, `SELECT scf.drop_expired_partitions()`)
	if err != nil || n != 3 {
		t.Fatalf("drop_expired_partitions: want 3, got %d %s", n, sqlState(err))
	}
	for _, p := range old {
		var exists bool
		_ = su.QueryRow(context.Background(), `SELECT to_regclass('scf_part.' || $1) IS NOT NULL`, p.name).Scan(&exists)
		if exists != (p.parent == "api_metrics_1d") {
			t.Errorf("%s exists=%v after drop_expired_partitions", p.name, exists)
		}
	}
	// retention.aggregates-24m / retention.raw-metrics: inside their windows partitions stay — 1h and web_hourly_totals at 24 months, 1m at 30 days
	ctx := context.Background()
	var m24, m24from, m24to, d30, d30from, d30to string
	if err := su.QueryRow(ctx, `SELECT to_char(m, 'YYYYMM'), to_char(m, 'YYYY-MM-DD'), to_char(m + interval '1 month', 'YYYY-MM-DD'),
	      to_char(d, 'YYYYMMDD'), to_char(d, 'YYYY-MM-DD'), to_char(d + 1, 'YYYY-MM-DD')
	    FROM (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') - interval '24 months' AS m,
	                 (now() AT TIME ZONE 'UTC')::date - 30 AS d) x`).Scan(&m24, &m24from, &m24to, &d30, &d30from, &d30to); err != nil {
		t.Fatal(err)
	}
	keep := []struct{ parent, name, from, to string }{
		{"api_metrics_1h", "api_metrics_1h_" + m24, m24from, m24to},
		{"web_hourly_totals", "web_hourly_totals_" + m24, m24from, m24to},
		{"api_metrics_1m", "api_metrics_1m_" + d30, d30from, d30to},
	}
	for _, p := range keep {
		mustExec(t, su, fmt.Sprintf(`CREATE TABLE scf_part.%s PARTITION OF scf.%s FOR VALUES FROM ('%s 00:00+00') TO ('%s 00:00+00')`,
			p.name, p.parent, p.from, p.to))
		mustExec(t, su, fmt.Sprintf(`SELECT scf_admin.secure_partition('scf_part.%s'::regclass, 'scf.%s'::regclass)`, p.name, p.parent))
		name := p.name
		t.Cleanup(func() { mustExec(t, su, `DROP TABLE IF EXISTS scf_part.`+name) })
	}
	if n, err := jobsCall(t, `SELECT scf.drop_expired_partitions()`); err != nil || n != 0 {
		t.Errorf("partitions inside their retention window were dropped: %d (%s)", n, sqlState(err))
	}
	// current partitions untouched
	if n, err := jobsCall(t, `SELECT scf.ensure_partitions()`); err != nil || n != 0 {
		t.Errorf("current partitions were dropped: ensure_partitions recreated %d (%s)", n, sqlState(err))
	}
}

// Writes into a partitioned table land in the partition and stay under the parent's RLS (no route around it).
func TestPartitionedWritesUnderRLS(t *testing.T) {
	conn := runtimeConn(t, "scf_jobs")
	err := inCtx(t, conn, Ctx{Tenant: A, Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.web_hourly_totals (tenant_id, site_id, hour_start, pageviews_verified, pageviews_raw,
		    pageviews_unidentified_verified, pageviews_unidentified_raw, visitors_verified, visitors_raw, events_raw)
		  VALUES ($1, $2, date_trunc('hour', now(), 'UTC') - interval '1 hour', 1, 1, 0, 0, 1, 1, 1)`, B, uid(B, 1))
		return err
	})
	if code(err) != "42501" {
		t.Errorf("web_rollup under A inserting B's hourly row: want 42501, got %s", sqlState(err))
	}
}
