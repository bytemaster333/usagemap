// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0072: the secret-seed warning acknowledgement. scf_app sets it for its own tenant only (RLS), the baseline is a JSON
// object and never set without an acknowledgement time, and the other runtime roles cannot write it.
func TestSeedWarningAck0072(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	ack := func(c *pgx.Conn, tenant string, baseline string) (int64, error) {
		var rows int64
		err := inCtx(t, c, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `UPDATE scf.tenants SET seed_warning_ack_at = now(), seed_warning_ack_baseline = $2::jsonb
			  WHERE tenant_id = $1`, tenant, baseline)
			rows = tag.RowsAffected()
			return err
		})
		return rows, err
	}
	if n, err := ack(app, A, `{"00000000-0000-0000-0000-000000000000": 3}`); err != nil || n != 1 {
		t.Fatalf("scf_app acknowledging its own tenant: rows=%d %s", n, sqlState(err))
	}
	if n, err := ack(app, B, `{}`); err != nil || n != 0 {
		t.Errorf("scf_app acknowledging another tenant: rows=%d %s (want 0 rows)", n, sqlState(err))
	}
	if _, err := ack(app, A, `[3]`); code(err) != "23514" {
		t.Errorf("baseline not an object: %q", sqlState(err))
	}
	if err := tryIn(t, `UPDATE scf.tenants SET seed_warning_ack_at = NULL, seed_warning_ack_baseline = '{"x": 2}'`); code(err) != "23514" {
		t.Errorf("baseline without an acknowledgement: %q", sqlState(err))
	}
	for _, role := range []string{"scf_writer", "scf_jobs", "scf_metrics_ro"} {
		var ok bool
		if err := super(t).QueryRow(context.Background(),
			`SELECT has_column_privilege($1, 'scf.tenants', 'seed_warning_ack_at', 'UPDATE')`, role).Scan(&ok); err != nil {
			t.Fatal(sqlState(err))
		}
		if ok {
			t.Errorf("%s may update seed_warning_ack_at", role)
		}
	}
}

// 0072 (2): job public_metrics reads the web verdict and reason counters of its own tenant only (the public card's
// filtered-traffic figures); other jobs keep their access, and another job name still reads nothing.
func TestPublicMetricsReadsEdgeCounters0072(t *testing.T) {
	for _, tn := range []string{A, B} {
		mustExec(t, super(t), fmt.Sprintf(`INSERT INTO scf.web_edge_counters (tenant_id, site_id, day, counter, label, count)
		  VALUES ('%s', '%s', '2026-11-01', 'reason', 'ua_bot', 7) ON CONFLICT DO NOTHING`, tn, uid(tn, 1)))
	}
	read := func(job string) (int64, error) {
		var n int64
		err := inCtx(t, runtimeConn(t, "scf_jobs"), Ctx{Tenant: A, Kind: "job", Actor: job, Job: job}, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(DISTINCT tenant_id) FROM scf.web_edge_counters WHERE day = '2026-11-01' AND label = 'ua_bot'`).Scan(&n)
		})
		return n, err
	}
	for _, job := range []string{"public_metrics", "trust_scoring"} {
		if n, err := read(job); err != nil || n != 1 {
			t.Errorf("%s reads %d tenants' counters (%s), want its own only", job, n, sqlState(err))
		}
	}
	if n, err := read("web_rollup"); err != nil || n != 0 {
		t.Errorf("web_rollup reads %d tenants' counters (%s), want none", n, sqlState(err))
	}
}

// 0072 (3): the per-service availability objective defaults to 99.5 % and stays within 90–99.999 %.
func TestServiceSLOTarget0072(t *testing.T) {
	var def string
	if err := super(t).QueryRow(context.Background(),
		`SELECT slo_target_pct::text FROM scf.api_services WHERE tenant_id = $1 LIMIT 1`, A).Scan(&def); err != nil {
		t.Fatal(sqlState(err))
	}
	if def != "99.500" {
		t.Errorf("default slo_target_pct = %s", def)
	}
	for _, c := range []struct {
		v  string
		ok bool
	}{{"99.9", true}, {"90", true}, {"99.999", true}, {"89.9", false}, {"100", false}} {
		err := tryIn(t, `UPDATE scf.api_services SET slo_target_pct = `+c.v)
		if c.ok && err != nil || !c.ok && code(err) != "23514" {
			t.Errorf("slo_target_pct = %s: ok=%v, got %q", c.v, c.ok, sqlState(err))
		}
	}
}
