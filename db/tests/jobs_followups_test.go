// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Migrations 0057–0059 (docs/data-model.md §11, §12). 0057: trust_scoring reads web_hourly_totals (parent and every
// partition), owner self-removal writes C-64 tombstones through scf.write_removal_tombstones(), and the audit actions
// verification.contract_unverified and tenant.purge_failed are written by scf_jobs only.

func TestTrustScoringReadsHourlyTotals(t *testing.T) {
	jobs := runtimeConn(t, "scf_jobs")
	count := func(job string) int {
		var n int
		err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: job, Job: job}, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM scf.web_hourly_totals`).Scan(&n)
		})
		if err != nil {
			t.Fatalf("%s: %s", job, sqlState(err))
		}
		return n
	}
	if n := count("trust_scoring"); n < 1 {
		t.Errorf("trust_scoring sees %d hourly rows of tenant A, want ≥ 1", n)
	}
	for _, job := range []string{"web_rollup", "tenant_purge"} {
		if n := count(job); n < 1 {
			t.Errorf("%s sees %d hourly rows, want ≥ 1 (unchanged)", job, n)
		}
	}
	for _, job := range []string{"retention", "registry_sync"} {
		if n := count(job); n != 0 {
			t.Errorf("%s sees %d hourly rows, want 0", job, n)
		}
	}
	// still SELECT only for trust_scoring
	err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "trust_scoring", Job: "trust_scoring"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE scf.web_hourly_totals SET events_raw = events_raw + 1`)
		if err == nil && tag.RowsAffected() > 0 {
			t.Errorf("trust_scoring updated %d hourly rows", tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}

	ctx := context.Background()
	parts, err := queryStrings(ctx, super(t), `
	  SELECT h.inhrelid::regclass::text || ' ' || COALESCE(pg_get_expr(q.polqual, q.polrelid), '<none>')
	    FROM pg_inherits h LEFT JOIN pg_policy q ON q.polrelid = h.inhrelid AND q.polname = 'jobs_select'
	   WHERE h.inhparent = 'scf.web_hourly_totals'::regclass`)
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) == 0 {
		t.Fatal("no web_hourly_totals partitions")
	}
	for _, p := range parts {
		if !strings.Contains(p, "'trust_scoring'") {
			t.Errorf("partition policy without trust_scoring: %s", p)
		}
	}
}

// The migration's own partition loop (section (1) of 0057, read from the file) repairs a partition that still carries
// the pre-0057 policy, so gate G7 is clean afterwards.
func TestMigration0057FixesExistingPartitions(t *testing.T) {
	body := readFile(t, filepath.Join(dbDir, "migrations", "0057_trust_hourly_removal_tombstones.sql"))
	start := strings.Index(body, "DROP POLICY jobs_select ON scf.web_hourly_totals;")
	end := strings.Index(body, "-- (2)")
	if start < 0 || end < start {
		t.Fatal("section (1) not found in 0057")
	}
	section := body[start:end]
	ctx := context.Background()
	tx, err := super(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var part string
	if err := tx.QueryRow(ctx, `SELECT inhrelid::regclass::text FROM pg_inherits
	   WHERE inhparent = 'scf.web_hourly_totals'::regclass ORDER BY 1 LIMIT 1`).Scan(&part); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `DROP POLICY jobs_select ON `+part+`;
	  CREATE POLICY jobs_select ON `+part+` FOR SELECT TO scf_jobs
	    USING ((SELECT scf.current_job()) = ANY (ARRAY['web_rollup','tenant_purge']::text[]))`); err != nil {
		t.Fatal(sqlState(err))
	}
	g7 := loadGates(t)["G7"]
	if rows, err := runGate(t, ctx, tx, g7); err != nil || len(rows) == 0 {
		t.Fatalf("stale partition policy not detected by G7: %v %s", rows, sqlState(err))
	}
	if _, err := tx.Exec(ctx, section); err != nil {
		t.Fatalf("0057 section (1): %s", sqlState(err))
	}
	if rows, err := runGate(t, ctx, tx, g7); err != nil || len(rows) != 0 {
		t.Errorf("G7 after 0057 section (1): %v %s", rows, sqlState(err))
	}
}

func TestWriteRemovalTombstones(t *testing.T) {
	now := time.Now()
	owner := Ctx{Tenant: A, Kind: "user", Actor: users[A], Reauth: &now}
	app := runtimeConn(t, "scf_app")

	t.Run("owner self-removal writes host, GitHub id and Stellar account once", func(t *testing.T) {
		err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE scf.tenants SET status = 'removed', status_reason = 'bye' WHERE tenant_id = $1`, A); err != nil {
				return err
			}
			var n int
			if err := tx.QueryRow(ctx, `SELECT scf.write_removal_tombstones($1)`, A).Scan(&n); err != nil {
				return err
			}
			if n != 3 {
				t.Errorf("first call wrote %d tombstones, want 3", n)
			}
			if err := tx.QueryRow(ctx, `SELECT scf.write_removal_tombstones($1)`, A).Scan(&n); err != nil {
				return err
			}
			if n != 0 {
				t.Errorf("second call wrote %d tombstones, want 0 (idempotent)", n)
			}
			for _, k := range [][2]string{{"host", "tenant-a.example.org"}, {"github_user", "1000"}} {
				var ok bool
				if err := tx.QueryRow(ctx, `SELECT scf.is_tombstoned($1, $2)`, k[0], k[1]).Scan(&ok); err != nil {
					return err
				}
				if !ok {
					t.Errorf("%s %s not tombstoned", k[0], k[1])
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
	})

	t.Run("refused for an active tenant and for another tenant", func(t *testing.T) {
		err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.write_removal_tombstones($1)`, A)
			if code(err) != "55000" {
				t.Errorf("active tenant: want 55000, got %s", sqlState(err))
			}
			return nil
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
		err = inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.write_removal_tombstones($1)`, B)
			if code(err) != "42501" {
				t.Errorf("other tenant: want 42501, got %s", sqlState(err))
			}
			return nil
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
	})

	t.Run("a lifted tombstone of this tenant stays lifted", func(t *testing.T) {
		setup := `INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id, reason, lifted_at)
		          VALUES ('host', 'tenant-a.example.org', '` + A + `', 'earlier', now())`
		err := asRoleInTx(t, setup, "scf_app", owner, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `UPDATE scf.tenants SET status = 'removed' WHERE tenant_id = $1`, A); err != nil {
				return err
			}
			var n int
			if err := tx.QueryRow(ctx, `SELECT scf.write_removal_tombstones($1)`, A).Scan(&n); err != nil {
				return err
			}
			if n != 2 {
				t.Errorf("wrote %d, want 2 (no new host tombstone)", n)
			}
			return nil
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
	})

	t.Run("tenant_purge may call it for a removed tenant", func(t *testing.T) {
		setup := `SET LOCAL session_replication_role = replica;
		          UPDATE scf.tenants SET status = 'removed', removed_at = now(), purge_after = now() WHERE tenant_id = '` + B + `';
		          SET LOCAL session_replication_role = origin;`
		err := asRoleInTx(t, setup, "scf_jobs", Ctx{Tenant: B, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"},
			func(ctx context.Context, tx pgx.Tx) error {
				var n int
				if err := tx.QueryRow(ctx, `SELECT scf.write_removal_tombstones($1)`, B).Scan(&n); err != nil {
					return err
				}
				if n != 3 {
					t.Errorf("wrote %d, want 3", n)
				}
				return nil
			})
		if err != nil {
			t.Fatal(sqlState(err))
		}
	})

	t.Run("only scf_app and scf_jobs may execute it", func(t *testing.T) {
		got, err := queryStrings(context.Background(), super(t), `
		  SELECT r FROM unnest(ARRAY['scf_app','scf_jobs','scf_writer','scf_metrics_ro','scf_op_definer']) r
		   WHERE has_function_privilege(r, 'scf.write_removal_tombstones(uuid)', 'EXECUTE') ORDER BY 1`)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(got, ",") != "scf_app,scf_jobs" {
			t.Errorf("EXECUTE held by %v", got)
		}
	})
}

func TestJobAuditActions0057(t *testing.T) {
	for _, action := range []string{"verification.contract_unverified", "tenant.purge_failed"} {
		job := map[string]string{"verification.contract_unverified": "contract_verification", "tenant.purge_failed": "tenant_purge"}[action]
		jobs := runtimeConn(t, "scf_jobs")
		err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: job, Job: job}, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, outcome)
			  VALUES ($1::uuid, 'job', $2, $3, 'failure')`, A, job, action)
			return err
		})
		if err != nil {
			t.Errorf("scf_jobs writing %s: %s", action, sqlState(err))
		}
		app := runtimeConn(t, "scf_app")
		err = inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action)
			  VALUES ($1::uuid, 'user', $2, $3)`, A, users[A], action)
			return err
		})
		if err == nil {
			t.Errorf("scf_app may write %s", action)
		}
	}
}

// 0058: the operator list of erasure requests — selector type, never the selector; one audit row; console only.
func TestOpErasureRequests0058(t *testing.T) {
	start := time.Now().Add(-24 * time.Hour)
	end := time.Now().Add(time.Hour)
	app := opCall{"scf_app", operatorCtx(false)}
	rows, au, err := callOp(t, app, `SELECT tenant_id, selector_type, status::text, row_to_json(r)::text
	  FROM scf.op_erasure_requests($1, $2) r`, start, end)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_erasure_requests")
	if len(rows) < 3 {
		t.Fatalf("want the seeded requests of A, B and C, got %d rows", len(rows))
	}
	for _, r := range rows {
		if str(r[1]) != "path_pattern" {
			t.Errorf("selector_type %q, want path_pattern", str(r[1]))
		}
		if strings.Contains(str(r[3]), "/x/*") {
			t.Errorf("literal selector leaked: %s", str(r[3]))
		}
	}
	rows, _, err = callOp(t, app, `SELECT tenant_id FROM scf.op_erasure_requests($1, $2, $3)`, start, end, A)
	if err != nil || len(rows) != 1 || str(rows[0][0]) != A {
		t.Errorf("tenant filter: %v %s", rows, sqlState(err))
	}
	rows, _, err = callOp(t, app, `SELECT tenant_id FROM scf.op_erasure_requests($1, $2, NULL, ARRAY['completed']::scf.erasure_status[])`, start, end)
	if err != nil || len(rows) != 0 {
		t.Errorf("status filter: %v %s", rows, sqlState(err))
	}
	if _, _, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("web:read,api:read")}, `SELECT * FROM scf.op_erasure_requests($1, $2)`, start, end); code(err) != "42501" {
		t.Errorf("machine key: want 42501, got %s", sqlState(err))
	}
	if _, _, err := callOp(t, opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}}, `SELECT * FROM scf.op_erasure_requests($1, $2)`, start, end); code(err) != "42501" {
		t.Errorf("tenant user: want 42501, got %s", sqlState(err))
	}
	if _, _, err := callOp(t, app, `SELECT * FROM scf.op_erasure_requests($1, $2)`, end, start); code(err) != "22023" {
		t.Errorf("reversed range: want 22023, got %s", sqlState(err))
	}
}

// 0059 (1): resolving a disputed domain works and is audited; a foreign tenant's disputed domain is 'not found'.
func TestOpResolveDomainDispute0059(t *testing.T) {
	setup := `UPDATE scf.site_domains SET state = 'disputed' WHERE tenant_id IN ('` + A + `', '` + B + `')`
	err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'keep')`, A, uid(A, 2)); err != nil {
			return err
		}
		var state string
		if err := tx.QueryRow(ctx, `SELECT count(*)::text FROM scf.audit_log WHERE action = 'domain.dispute_resolved'`).Scan(&state); err != nil {
			return err
		}
		if state != "1" {
			t.Errorf("audit rows in this transaction: %s, want 1", state)
		}
		err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'keep')`, A, uid(B, 2))
			return err
		})
		if code(err) != "P0002" {
			t.Errorf("B's domain under A: want P0002, got %s", sqlState(err))
		}
		err = savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'release')`, A, uid(A, 2))
			return err
		})
		if code(err) != "P0002" {
			t.Errorf("already resolved: want P0002, got %s", sqlState(err))
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
}

// 0059 (2): job public_metrics reads the preferred-group views and the stream-group tables, only its own tenant's rows
// under a tenant context.
func TestPublicMetricsReadsApiPref0059(t *testing.T) {
	jobs := runtimeConn(t, "scf_jobs")
	err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "public_metrics", Job: "public_metrics"}, func(ctx context.Context, tx pgx.Tx) error {
		for _, q := range []string{
			`SELECT count(*) FROM scf.api_stream_groups`,
			`SELECT count(*) FROM scf.api_service_day_groups`,
			`SELECT count(*) FROM scf.api_metrics_1d_pref`,
		} {
			var n int
			if err := tx.QueryRow(ctx, q).Scan(&n); err != nil {
				return err
			}
			if n < 1 {
				t.Errorf("%s: %d rows, want ≥ 1", q, n)
			}
		}
		var foreign int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.api_metrics_1d_pref WHERE tenant_id <> $1`, A).Scan(&foreign); err != nil {
			return err
		}
		if foreign != 0 {
			t.Errorf("%d foreign rows through the view", foreign)
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	err = inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.api_stream_groups`).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			t.Errorf("retention sees %d stream groups", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
}
