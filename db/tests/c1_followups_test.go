// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migrations 0070 and 0071: the control plane's database needs after its fixes and the metrics
// writer's tenant check.

// 0070 (1), control-plane-portal finding 4: removeDomain lapses the evidence and audits it itself (scf_app).
func TestEvidenceLapsedAuditedByControlPlane(t *testing.T) {
	err := inCtx(t, runtimeConn(t, "scf_app"), Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action, details)
		    VALUES ($1, 'user', $2, 'verification.evidence_lapsed', '{"kind":"domain"}')`, A, users[A])
		return err
	})
	if err != nil {
		t.Errorf("scf_app appends verification.evidence_lapsed: %s", sqlState(err))
	}
}

// 0070 (2)–(4), ops.end-of-window-read-only: read_only_mode's shape, integer settings, the privacy floor.
func TestSettingsValueChecks0070(t *testing.T) {
	ctx := context.Background()
	var ro, caps string
	if err := super(t).QueryRow(ctx, `SELECT (SELECT value::text FROM scf.settings WHERE key = 'read_only_mode'),
	    (SELECT string_agg(key || '=' || value::text, ',' ORDER BY key) FROM scf.settings
	      WHERE key IN ('stream_state_cap_per_tenant', 'l0_stream_state_cap'))`).Scan(&ro, &caps); err != nil {
		t.Fatal(sqlState(err))
	}
	if ro != `{"ingest": "accept", "enabled": false}` {
		t.Errorf("read_only_mode default: %s", ro)
	}
	if caps != "l0_stream_state_cap=10000,stream_state_cap_per_tenant=250000" {
		t.Errorf("writer caps: %s", caps)
	}
	set := func(key, value string) string {
		return fmt.Sprintf(`UPDATE scf.settings SET value = '%s' WHERE key = '%s'`, value, key)
	}
	for _, c := range []struct {
		key, value string
		ok         bool
	}{
		{"read_only_mode", `{"enabled":true,"ingest":"pause"}`, true},
		{"read_only_mode", `{"enabled":true,"ingest":"accept"}`, true},
		{"read_only_mode", `{"enabled":"yes","ingest":"accept"}`, false},
		{"read_only_mode", `{"enabled":true,"ingest":"drop"}`, false},
		{"read_only_mode", `{"enabled":true}`, false},
		{"read_only_mode", `{"enabled":true,"ingest":"pause","extra":1}`, false},
		{"read_only_mode", `true`, false},
		{"op_min_count", `5`, true}, {"op_min_count", `1000`, true}, {"op_min_count", `4`, false},
		{"op_min_count", `0`, false}, {"op_min_count", `1001`, false}, {"op_min_count", `10.5`, false},
		{"op_min_count", `"10"`, false}, {"op_min_count", `-10`, false}, {"op_min_count", `null`, false},
		{"op_round_to", `1`, true}, {"op_round_to", `100`, true}, {"op_round_to", `0`, false}, {"op_round_to", `101`, false},
		{"tenant_min_count", `5`, true}, {"tenant_min_count", `3`, false},
		{"tenant_round_to", `10`, true}, {"tenant_round_to", `0`, false}, {"tenant_round_to", `2.5`, false},
		{"l0_max_sites", `3`, true}, {"l0_max_sites", `2.5`, false}, {"l0_max_sites", `"2"`, false},
		{"stream_state_cap_per_tenant", `500000`, true}, {"stream_state_cap_per_tenant", `1e6`, true}, {"stream_state_cap_per_tenant", `0.5`, false},
		{"read_only_mode", `{"ingest":"pause"}`, false},
		{"pow_max", `[1024]`, false}, {"pow_max", `9999999999`, false},
	} {
		err := tryIn(t, set(c.key, c.value))
		if c.ok && err != nil || !c.ok && code(err) != "23514" {
			t.Errorf("%s = %s: ok=%v, got %q", c.key, c.value, c.ok, sqlState(err))
		}
	}
}

// 0070 (5), control-plane-portal findings 8 and 14: the operator breakdown floor applies per UTC day. One visitor
// seen on every day of a 30-day window never passes k; a value with k visitors on one day does.
func TestOpWebBreakdownDailyFloor(t *testing.T) {
	d0, today, _ := days(t)
	setup := fmt.Sprintf(`
	  INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews)
	    SELECT '%[1]s', '%[2]s', d::date, 'verified', 'country', 'ZZ', 9, 1, 1
	      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 30, (now() AT TIME ZONE 'UTC')::date - 1, interval '1 day') d;
	  INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews)
	    VALUES ('%[1]s', '%[2]s', (now() AT TIME ZONE 'UTC')::date - 2, 'verified', 'country', 'YY', 8, 12, 15);`, A, uid(A, 1))
	start := d0.AddDate(0, 0, -30)
	var rows []string
	err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
		var err error
		rows, err = queryStrings(ctx, tx, `SELECT value || '=' || COALESCE(visitors_sum::text, 'null')
		    FROM scf.op_web_breakdown($1, $2, 'country', 'verified', ARRAY[$3::uuid]) WHERE value IS NOT NULL ORDER BY 1`,
		    start, today, A)
		return err
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	got := map[string]string{}
	for _, r := range rows {
		var v, n string
		if _, err := fmt.Sscanf(r, "%2s=%s", &v, &n); err == nil {
			got[v] = n
		}
	}
	if _, ok := got["ZZ"]; ok {
		t.Errorf("one visitor on 30 days passed the floor: %v", rows)
	}
	if got["YY"] != "10" {
		t.Errorf("12 visitors on one day: want YY=10 (rounded), got %v", rows)
	}
	// the seed's DE (24 visitors yesterday) still shows; XX (3) does not
	if got["DE"] != "20" || got["XX"] != "" {
		t.Errorf("seed rows: %v", rows)
	}
}

// 0070 (6), control-plane-portal finding 17: job erasure reads and deletes the tenant's dev events; still only its own.
func TestErasureDeletesDevEvents(t *testing.T) {
	err := inCtx(t, runtimeConn(t, "scf_jobs"), Ctx{Tenant: A, Kind: "job", Actor: "erasure", Job: "erasure"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.web_dev_events WHERE event_name = 'wallet_connect'`)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			t.Errorf("erasure deleted %d dev events, want A's 1", tag.RowsAffected())
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
}

// 0071 (api-pipeline finding 7): the writer learns whether its own tenant is removed, purged or unknown; nothing else.
func TestWriterTenantGone(t *testing.T) {
	writer := runtimeConn(t, "scf_writer")
	gone := func(c Ctx) (bool, error) {
		var g bool
		err := inCtx(t, writer, c, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT scf.writer_tenant_gone()`).Scan(&g)
		})
		return g, err
	}
	w := func(tenant string) Ctx { return Ctx{Tenant: tenant, Kind: "writer", Actor: "writer"} }
	if g, err := gone(w(A)); err != nil || g {
		t.Errorf("active tenant A: gone=%v %s", g, sqlState(err))
	}
	if g, err := gone(w("eeeeeeee-0000-7000-8000-00000000000e")); err != nil || !g {
		t.Errorf("unknown tenant: gone=%v %s", g, sqlState(err))
	}
	for name, c := range map[string]Ctx{"no tenant": {Kind: "writer", Actor: "writer"},
		"system actor": {Tenant: A, Kind: "system", Actor: "edge"}, "anonymous": {Tenant: A}} {
		if _, err := gone(c); code(err) != "42501" {
			t.Errorf("%s: want 42501, got %q", name, sqlState(err))
		}
	}
	// a removed tenant (the transition runs as scf_op_definer, as op_tenant_transition does)
	removed := `SET LOCAL ROLE scf_op_definer; UPDATE scf.tenants SET status = 'removed' WHERE tenant_id = '` + A + `'; RESET ROLE;`
	err := asRoleInTx(t, removed, "scf_writer", w(A), func(ctx context.Context, tx pgx.Tx) error {
		var g bool
		if err := tx.QueryRow(ctx, `SELECT scf.writer_tenant_gone()`).Scan(&g); err != nil {
			return err
		}
		if !g {
			t.Error("removed tenant: gone=false")
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
	// EXECUTE for scf_writer only
	for _, role := range []string{"scf_app", "scf_jobs", "scf_metrics_ro"} {
		err := inCtx(t, runtimeConn(t, role), w(A), func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.writer_tenant_gone()`)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("%s calls writer_tenant_gone: want 42501, got %q", role, sqlState(err))
		}
	}
}
