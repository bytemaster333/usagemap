// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 0087 (operator console redesign): the removal reason code, the hidden-value summary rows of
// op_web_breakdown and the audited enrolment summary.

// The reason code is set only by op_tenant_transition('remove'), audited in tenant.removed, cleared on restoration,
// refused with any other action or an unknown code, and not writable by a runtime role.
func TestRemovalReasonCode0087(t *testing.T) {
	var code0, auditCode string
	err := asRoleInTx(t, "", "scf_app", adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, 'remove', 'listed twice', 'duplicate')`, A); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT details ->> 'reason_code' FROM scf.audit_log
		    WHERE tx_id = pg_current_xact_id() AND action = 'tenant.removed'`).Scan(&auditCode); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT removal_reason_code FROM scf.tenants WHERE tenant_id = $1`, A).Scan(&code0); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SET LOCAL ROLE scf_app`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, 'restore', 'appeal upheld')`, A); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `RESET ROLE`); err != nil {
			return err
		}
		var after *string
		if err := tx.QueryRow(ctx, `SELECT removal_reason_code FROM scf.tenants WHERE tenant_id = $1`, A).Scan(&after); err != nil {
			return err
		}
		if after != nil {
			return fmt.Errorf("restore kept removal_reason_code %q", *after)
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	if code0 != "duplicate" || auditCode != "duplicate" {
		t.Errorf("stored %q, audited %q, want duplicate", code0, auditCode)
	}
	// Three-argument removals still work and leave the code NULL.
	err = asRoleInTx(t, "", "scf_app", adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, 'remove', 'r')`, B)
		return err
	})
	if err != nil {
		t.Errorf("three-argument remove: %s", sqlState(err))
	}
	for _, c := range []struct{ action, code string }{{"suspend", "spam"}, {"remove", "abuse"}} {
		err := asRoleInTx(t, "", "scf_app", adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, $2, 'r', $3)`, B, c.action, c.code)
			return err
		})
		if code(err) != "22023" {
			t.Errorf("%s with code %s: want 22023, got %s", c.action, c.code, sqlState(err))
		}
	}
	// No runtime role writes the column; the CHECK keeps it NULL unless the tenant is removed.
	err = asRoleInTx(t, "", "scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.tenants SET removal_reason_code = 'spam' WHERE tenant_id = $1`, A)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("scf_app writes removal_reason_code: want 42501, got %s", sqlState(err))
	}
	err = asRoleInTx(t, "", "postgres", Ctx{Kind: "system", Actor: "test"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.tenants SET removal_reason_code = 'spam' WHERE tenant_id = $1`, A)
		return err
	})
	if code(err) != "23514" {
		t.Errorf("reason code on an active tenant: want 23514, got %s", sqlState(err))
	}
}

// op_web_breakdown reports how many values the per-day floor withheld, per group, only when at least
// cohort_min_tenants were withheld; never the values or their sum.
func TestBreakdownHiddenRows0087(t *testing.T) {
	d0, today, _ := days(t)
	// Tenant A: five more values below the floor (k = 10) besides the seeded XX: six withheld. Tenant B: XX only.
	setup := fmt.Sprintf(`
	  INSERT INTO scf.web_daily_breakdowns (tenant_id, site_id, day, variant, dimension, value, rank, visitors, pageviews)
	    SELECT '%[1]s', '%[2]s', (now() AT TIME ZONE 'UTC')::date - 1, 'verified', 'country', 'H' || i, 10 + i, i, i
	      FROM generate_series(1, 5) i;`, A, uid(A, 1))
	type row struct {
		tenant, value string
		vis, pv       *int64
		sup           bool
		hidden        *int32
	}
	read := func(setup, sql string, oc opCall, args ...any) ([]row, []auditRow) {
		t.Helper()
		var out []row
		var audit []auditRow
		err := asRoleInTx(t, setup, oc.role, oc.c, func(ctx context.Context, tx pgx.Tx) error {
			rs, err := tx.Query(ctx, sql, args...)
			if err != nil {
				return err
			}
			for rs.Next() {
				var r row
				var tn, v *string
				if err := rs.Scan(&tn, &v, &r.vis, &r.pv, &r.sup, &r.hidden); err != nil {
					rs.Close()
					return err
				}
				if tn != nil {
					r.tenant = *tn
				}
				if v != nil {
					r.value = *v
				}
				out = append(out, r)
			}
			rs.Close()
			if err := rs.Err(); err != nil {
				return err
			}
			ar, err := tx.Query(ctx, `SELECT action FROM scf.audit_log WHERE tx_id = pg_current_xact_id()`)
			if err != nil {
				return err
			}
			defer ar.Close()
			for ar.Next() {
				var a auditRow
				if err := ar.Scan(&a.action); err != nil {
					return err
				}
				audit = append(audit, a)
			}
			return ar.Err()
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
		return out, audit
	}
	const q = `SELECT tenant_id::text, value, visitors_sum, pageviews, suppressed, hidden_rows
	    FROM scf.op_web_breakdown($1, $2, 'country', p_group => $3)`
	app := opCall{"scf_app", operatorCtx(true)}
	rows, au := read(setup, q, app, d0, today, "tenant")
	oneAudit(t, au, "operator.read.op_web_breakdown")
	var summaries []string
	var shown []string
	for _, r := range rows {
		if r.value == "" {
			if !r.sup || r.vis != nil || r.pv != nil || r.hidden == nil {
				t.Errorf("summary row must carry only the count: %+v", r)
				continue
			}
			summaries = append(summaries, fmt.Sprintf("%s=%d", r.tenant, *r.hidden))
		} else {
			if r.sup || r.hidden != nil {
				t.Errorf("value row %+v marked as summary", r)
			}
			shown = append(shown, r.tenant+" "+r.value)
		}
	}
	if want := []string{A + "=6"}; !slices.Equal(summaries, want) {
		t.Errorf("summaries: want %v (B's single withheld value never reported), got %v", want, summaries)
	}
	slices.Sort(shown)
	if want := []string{A + " DE", A + " FR", B + " DE", B + " FR"}; !slices.Equal(shown, want) {
		t.Errorf("shown rows unchanged: want %v, got %v", want, shown)
	}
	// Grouped over all tenants: XX and H1…H5 withheld = 6 distinct values.
	rows, _ = read(setup, q, app, d0, today, "all")
	var all []string
	for _, r := range rows {
		if r.value == "" && r.hidden != nil {
			all = append(all, fmt.Sprintf("%q=%d", r.tenant, *r.hidden))
		}
	}
	if want := []string{`""=6`}; !slices.Equal(all, want) {
		t.Errorf("group all: want %v, got %v", want, all)
	}
	// The threshold is cohort_min_tenants: above the withheld count, no summary row at all.
	rows, _ = read(setup+`UPDATE scf.settings SET value = '7' WHERE key = 'cohort_min_tenants';`, q, app, d0, today, "tenant")
	for _, r := range rows {
		if r.value == "" {
			t.Errorf("cohort_min_tenants 7 > 6 withheld: unexpected summary row %+v", r)
		}
	}
	// The machine API's role reads the same summary rows (it skips them when listing values).
	rows, _ = read(setup, q, opCall{"scf_metrics_ro", keyCtx("web:read")}, d0, today, "tenant")
	n := 0
	for _, r := range rows {
		if r.value == "" {
			n++
		}
	}
	if n != 1 {
		t.Errorf("operator key: want 1 summary row, got %d", n)
	}
}

// op_enrolment_summary: console only, audited; removing a tenant moves the current counts and the month's removals but
// not the start-of-month counts (reconstructed from the audit row's `from`); canary tenants never count.
func TestEnrolmentSummary0087(t *testing.T) {
	setup := fmt.Sprintf(`UPDATE scf.tenants SET created_at = date_trunc('month', now(), 'UTC') - interval '10 days',
	    status_changed_at = date_trunc('month', now(), 'UTC') - interval '10 days'
	  WHERE tenant_id IN ('%s', '%s', '%s');`, A, B, C)
	const q = `SELECT enrolled, enrolled_at_month_start, pending_approval, pending_at_month_start, new_this_month,
	    new_previous_month, removed_this_month, removed_previous_month FROM scf.op_enrolment_summary()`
	type sum [8]int32
	get := func(ctx context.Context, tx pgx.Tx) (sum, error) {
		var s sum
		err := tx.QueryRow(ctx, q).Scan(&s[0], &s[1], &s[2], &s[3], &s[4], &s[5], &s[6], &s[7])
		return s, err
	}
	var before, afterB, afterC sum
	var audits int
	err := asRoleInTx(t, setup, "scf_app", adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		var err error
		if before, err = get(ctx, tx); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.audit_log WHERE tx_id = pg_current_xact_id()
		    AND action = 'operator.read.op_enrolment_summary'`).Scan(&audits); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, 'remove', 'spam', 'spam')`, B); err != nil {
			return err
		}
		if afterB, err = get(ctx, tx); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT scf.op_tenant_transition($1, 'remove', 'canary', 'other')`, C); err != nil {
			return err
		}
		afterC, err = get(ctx, tx)
		return err
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	if audits != 1 {
		t.Errorf("want one audit row per call, got %d", audits)
	}
	if before[0] < 2 || before[1] < 2 {
		t.Errorf("A and B enrolled now and at the month start: %v", before)
	}
	want := before
	want[0]--    // B no longer enrolled
	want[6]++    // one removal this month
	if afterB != want {
		t.Errorf("after removing B: want %v, got %v", want, afterB)
	}
	if afterC != afterB {
		t.Errorf("a canary removal changed the counts: %v → %v", afterB, afterC)
	}
	// Console only: no operator key, no tenant user, not the machine role.
	for _, oc := range []opCall{
		{"scf_app", keyCtx("web:read,api:read,registry:read")},
		{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}},
		{"scf_metrics_ro", keyCtx("web:read,api:read,registry:read")},
	} {
		if _, _, err := callOp(t, oc, q); code(err) != "42501" {
			t.Errorf("%s as %s: want 42501, got %s", oc.role, oc.c.Kind, sqlState(err))
		}
	}
}
