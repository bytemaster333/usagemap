// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// op_* functions (port of spikes/s03-rls-real-postgres/tests/t_ops.py, docs/data-model.md §11): every call writes
// exactly one audit row in the calling transaction; C-95 thresholds only web breakdown rows; canary tenants only when
// named; key scopes and tenant restrictions hold; no runtime role reaches tenant data another way. All calls go
// through PgBouncer and are rolled back.

type auditRow struct {
	action, outcome, actorKind string
	tenant                     *string
	subjects                   []string
}

type opCall struct {
	role string
	c    Ctx
}

func operatorCtx(stepUp bool) Ctx {
	c := Ctx{Kind: "operator", Actor: uOp, PlatformRole: "operator", RequestID: "req-wse"}
	if stepUp {
		now := time.Now()
		c.StepUp = &now
	}
	return c
}

func adminCtx() Ctx {
	c := operatorCtx(true)
	c.Actor, c.PlatformRole = uAdm, "operator_admin"
	return c
}

func keyCtx(scopes string, tenants ...string) Ctx {
	c := Ctx{Kind: "op_key", Actor: "opkey0000001", KeyScopes: scopes}
	if len(tenants) > 0 {
		c.KeyTenants = tenants
	}
	return c
}

// callOp runs sql in one rolled-back transaction and returns the rows (as strings) and this transaction's audit rows.
func callOp(t *testing.T, oc opCall, sql string, args ...any) ([][]any, []auditRow, error) {
	t.Helper()
	conn := runtimeConn(t, oc.role)
	var rows [][]any
	var audit []auditRow
	err := inCtx(t, conn, oc.c, func(ctx context.Context, tx pgx.Tx) error {
		r, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return err
		}
		for r.Next() {
			v, err := r.Values()
			if err != nil {
				r.Close()
				return err
			}
			rows = append(rows, v)
		}
		r.Close()
		if err := r.Err(); err != nil {
			return err
		}
		ar, err := tx.Query(ctx, `SELECT action, outcome, actor_kind, tenant_id::text, COALESCE(subject_tenant_ids::text[], '{}')
		                            FROM scf.audit_log WHERE tx_id = pg_current_xact_id() ORDER BY seq`)
		if err != nil {
			return err
		}
		defer ar.Close()
		for ar.Next() {
			var a auditRow
			if err := ar.Scan(&a.action, &a.outcome, &a.actorKind, &a.tenant, &a.subjects); err != nil {
				return err
			}
			audit = append(audit, a)
		}
		return ar.Err()
	})
	return rows, audit, err
}

func oneAudit(t *testing.T, audit []auditRow, action string) auditRow {
	t.Helper()
	if len(audit) != 1 || audit[0].action != action {
		t.Fatalf("want exactly one audit row %q, got %+v", action, audit)
	}
	return audit[0]
}

func str(v any) string {
	if v == nil {
		return "<nil>"
	}
	if b, ok := v.([16]byte); ok {
		return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	}
	return fmt.Sprint(v)
}

func days(t *testing.T) (d0, today, d2 time.Time) {
	t.Helper()
	if err := super(t).QueryRow(context.Background(), `SELECT date_trunc('day', now(), 'UTC') - interval '1 day',
	    date_trunc('day', now(), 'UTC'), date_trunc('day', now(), 'UTC') + interval '1 day'`).Scan(&d0, &today, &d2); err != nil {
		t.Fatal(err)
	}
	return
}

func TestOpReadFunctions(t *testing.T) {
	d0, today, d2 := days(t)
	app := opCall{"scf_app", operatorCtx(true)}

	t.Run("op_projects", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT tenant_id, verification_level, site_count, service_count FROM scf.op_projects()`)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		var got []string
		for _, r := range rows {
			got = append(got, str(r[0]))
		}
		slices.Sort(got)
		if !slices.Equal(got, []string{A, B}) {
			t.Errorf("want A and B (canary C excluded), got %v", got)
		}
		oneAudit(t, au, "operator.read.op_projects")
	})
	t.Run("op_web_metrics exact (C-95)", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT tenant_id, pageviews, visitors_sum, suppressed FROM scf.op_web_metrics($1, $2)`, d0, today)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		if len(rows) != 2 {
			t.Fatalf("want 2 rows, got %v", rows)
		}
		for _, r := range rows {
			if r[1].(int64) != 7 || r[2].(int64) != 3 || r[3].(bool) {
				t.Errorf("want pageviews 7, visitors 3, suppressed false; got %v", r)
			}
		}
		oneAudit(t, au, "operator.read.op_web_metrics")
	})
	t.Run("op_web_metrics group all", func(t *testing.T) {
		rows, _, err := callOp(t, app, `SELECT tenant_id, pageviews FROM scf.op_web_metrics($1, $2, 'day', 'all')`, d0, today)
		if err != nil || len(rows) != 1 || rows[0][0] != nil || rows[0][1].(int64) != 14 {
			t.Errorf("want one row (NULL, 14), got %v %s", rows, sqlState(err))
		}
	})
	t.Run("canary only when named", func(t *testing.T) {
		rows, _, err := callOp(t, app, `SELECT tenant_id, pageviews FROM scf.op_web_metrics($1, $2, p_tenants => $3::uuid[])`, d0, today, []string{C})
		if err != nil || len(rows) != 1 || str(rows[0][0]) != C {
			t.Errorf("want C only, got %v %s", rows, sqlState(err))
		}
	})
	t.Run("op_web_breakdown thresholded (C-95)", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT tenant_id, value, visitors_sum, pageviews, suppressed
		    FROM scf.op_web_breakdown($1, $2, 'country') ORDER BY 1, 2`, d0, today)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		var got []string
		for _, r := range rows {
			got = append(got, fmt.Sprintf("%s %v %v %v %v", str(r[0]), r[1], r[2], r[3], r[4]))
		}
		want := []string{A + " DE 20 30 false", A + " FR 10 10 false", B + " DE 20 30 false", B + " FR 10 10 false"}
		if !slices.Equal(got, want) {
			t.Errorf("XX omitted, DE 24→20 / 26→30, FR 10→10 / 14→10: want %v, got %v", want, got)
		}
		oneAudit(t, au, "operator.read.op_web_breakdown")
	})
	t.Run("op_web_verdicts exact", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT tenant_id, count FROM scf.op_web_verdicts($1, $2)`, today, d2)
		if err != nil || len(rows) != 2 || rows[0][1].(int64) != 3 {
			t.Errorf("want 2 rows with count 3, got %v %s", rows, sqlState(err))
		}
		oneAudit(t, au, "operator.read.op_web_verdicts")
	})
	t.Run("op_api_metrics exact, merged percentiles", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT tenant_id, requests, p50_s, accuracy_class, suppressed
		    FROM scf.op_api_metrics($1, $2, 'range', 'service')`, today, d2)
		if err != nil || len(rows) != 2 {
			t.Fatalf("want 2 rows, got %v %s", rows, sqlState(err))
		}
		for _, r := range rows {
			if r[1].(int64) != 3 || r[2] == nil || r[3].(string) != "explicit15" || r[4].(bool) {
				t.Errorf("want requests 3, p50 set, explicit15, not suppressed; got %v", r)
			}
		}
		oneAudit(t, au, "operator.read.op_api_metrics")
	})
	for _, f := range []struct{ name, sql string }{
		{"op_trust", `SELECT tenant_id FROM scf.op_trust($1, $2)`},
		{"op_api_assurance", `SELECT tenant_id FROM scf.op_api_assurance($1, $2)`},
		{"op_onchain", `SELECT tenant_id FROM scf.op_onchain($1, $2)`},
	} {
		t.Run(f.name, func(t *testing.T) {
			rows, au, err := callOp(t, app, f.sql, d0, today)
			if err != nil || len(rows) != 2 {
				t.Errorf("want 2 rows, got %v %s", rows, sqlState(err))
			}
			oneAudit(t, au, "operator.read."+f.name)
		})
	}
	t.Run("op_onchain counts exact", func(t *testing.T) {
		rows, _, err := callOp(t, app, `SELECT invocations, distinct_invokers FROM scf.op_onchain($1, $2)`, d0, today)
		if err != nil || len(rows) != 2 || rows[0][0].(int64) != 3 || rows[0][1].(int64) != 1 {
			t.Errorf("want 3 / 1, got %v %s", rows, sqlState(err))
		}
	})
	t.Run("op_tenant_detail", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT scf.op_tenant_detail($1)::text`, A)
		if err != nil || len(rows) != 1 {
			t.Fatalf("%v %s", rows, sqlState(err))
		}
		var doc map[string]json.RawMessage
		if err := json.Unmarshal([]byte(rows[0][0].(string)), &doc); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(doc["ingest_tokens"]), "secret_hash") || strings.Contains(string(doc["sites"]), "umami_website_id") {
			t.Errorf("secrets or engine ids leaked: %s %s", doc["ingest_tokens"], doc["sites"])
		}
		if strings.Contains(string(doc["erasure_requests"]), "/x/*") {
			t.Errorf("erasure selector leaked to the operator: %s", doc["erasure_requests"])
		}
		a := oneAudit(t, au, "operator.read.op_tenant_detail")
		if a.tenant == nil || *a.tenant != A {
			t.Errorf("audit row must land in A's chain, got %v", a.tenant)
		}
	})
	t.Run("op_audit_list", func(t *testing.T) {
		rows, au, err := callOp(t, app, `SELECT action FROM scf.op_audit_list($1, $2)`, d0, d2)
		if err != nil || len(rows) < 4 {
			t.Errorf("want ≥ 4 rows, got %d %s", len(rows), sqlState(err))
		}
		oneAudit(t, au, "operator.read.op_audit_list")
		_, _, err = callOp(t, app, `SELECT action FROM scf.op_audit_list($1, $2, p_after_time => $1)`, d0, d2)
		if code(err) != "22023" {
			t.Errorf("half cursor (CR-23): want 22023, got %s", sqlState(err))
		}
	})
}

func TestOpMachineKeys(t *testing.T) {
	d0, today, d2 := days(t)
	metrics := func(c Ctx) opCall { return opCall{"scf_metrics_ro", c} }

	rows, au, err := callOp(t, metrics(keyCtx("web:read,api:read")), `SELECT scf.op_metrics_document('tenant-a')::text`)
	if err != nil || len(rows) != 1 || rows[0][0] != `{"tenant": "tenant-a"}` {
		t.Errorf("op_metrics_document with both scopes: %v %s", rows, sqlState(err))
	}
	if a := oneAudit(t, au, "operator.read.op_metrics_document"); a.outcome != "success" {
		t.Errorf("outcome %s", a.outcome)
	}
	rows, au, err = callOp(t, metrics(keyCtx("web:read,api:read", B)), `SELECT scf.op_metrics_document('tenant-a')`)
	if err != nil || len(rows) != 1 || rows[0][0] != nil {
		t.Errorf("key restricted to B asking for A: want NULL, got %v %s", rows, sqlState(err))
	}
	if a := oneAudit(t, au, "operator.read.op_metrics_document"); a.outcome != "denied" {
		t.Errorf("CR-22: want outcome denied, got %s", a.outcome)
	}
	if _, _, err = callOp(t, metrics(keyCtx("web:read")), `SELECT scf.op_metrics_document('tenant-a')`); code(err) != "42501" {
		t.Errorf("CR-21 both scopes needed: want 42501, got %s", sqlState(err))
	}
	rows, au, err = callOp(t, metrics(keyCtx("web:read", A)), `SELECT tenant_id FROM scf.op_web_metrics($1, $2, p_tenants => $3::uuid[])`, d0, today, []string{B})
	if err != nil || len(rows) != 0 || len(au) != 1 {
		t.Errorf("key restricted to A asking for B: want 0 rows and 1 audit row, got %v %v %s", rows, au, sqlState(err))
	}
	rows, _, err = callOp(t, metrics(keyCtx("web:read", A)), `SELECT tenant_id FROM scf.op_web_metrics($1, $2)`, d0, today)
	if err != nil || len(rows) != 1 || str(rows[0][0]) != A {
		t.Errorf("key restricted to A: want only A, got %v %s", rows, sqlState(err))
	}
	if _, _, err = callOp(t, metrics(keyCtx("web:read")), `SELECT * FROM scf.op_api_metrics($1, $2, 'range')`, today, d2); code(err) != "42501" {
		t.Errorf("web:read key calling op_api_metrics: want 42501, got %s", sqlState(err))
	}
	if _, _, err = callOp(t, metrics(keyCtx("registry:read")), `SELECT * FROM scf.op_projects(1, '{active}')`); code(err) != "42883" {
		t.Errorf("§11: integer literal for p_min_level smallint fails with 42883, got %s", sqlState(err))
	}
	if _, _, err = callOp(t, metrics(keyCtx("registry:read")), `SELECT * FROM scf.op_projects(1::smallint, '{active,removed}')`); code(err) != "42501" {
		t.Errorf("machine key listing removed tenants: want 42501, got %s", sqlState(err))
	}
	if _, _, err = callOp(t, metrics(keyCtx("web:read,api:read")), `SELECT scf.op_tenant_detail($1)`, A); code(err) != "42501" {
		t.Errorf("scf_metrics_ro calling console-only op_tenant_detail: want 42501, got %s", sqlState(err))
	}
}

func TestOpWriteFunctions(t *testing.T) {
	d0, today, _ := days(t)
	app := opCall{"scf_app", operatorCtx(true)}
	admin := opCall{"scf_app", adminCtx()}

	rows, au, err := callOp(t, app, `SELECT scf.op_add_annotation($1, $2, NULL, $3, $4, 'operator note')`, A, uid(A, 1), d0, today)
	if err != nil || len(rows) != 1 {
		t.Errorf("op_add_annotation: %v %s", rows, sqlState(err))
	} else if a := oneAudit(t, au, "trust.annotation.created"); a.tenant == nil || *a.tenant != A {
		t.Errorf("annotation audit must be in A's chain: %v", a.tenant)
	}
	if _, _, err = callOp(t, app, `SELECT scf.op_add_annotation($1, $2, NULL, $3, $4, 'x')`, A, uid(B, 1), d0, today); code(err) != "P0002" {
		t.Errorf("C-87: annotation on B's site under A: want P0002, got %s", sqlState(err))
	}
	if _, _, err = callOp(t, opCall{"scf_app", operatorCtx(false)}, `SELECT scf.op_add_annotation($1, $2, NULL, $3, $4, 'x')`,
		A, uid(A, 1), d0, today); !strings.Contains(sqlState(err), "step-up required") {
		t.Errorf("C-09: write without step-up: got %s", sqlState(err))
	}
	old := time.Now().Add(-11 * time.Minute)
	stale := operatorCtx(false)
	stale.StepUp = &old
	if _, _, err = callOp(t, opCall{"scf_app", stale}, `SELECT scf.op_approve_tenant_evidence($1, 'ok')`, A); !strings.Contains(sqlState(err), "step-up required") {
		t.Errorf("C-09: step-up older than 10 min: got %s", sqlState(err))
	}
	for _, w := range []struct{ sql, action string }{
		{`SELECT scf.op_registry_link_decide($1, '` + reg + `', 'confirm')`, "registry.link_confirmed"},
		{`SELECT scf.op_registry_link_decide($1, '` + reg + `', 'reject')`, "registry.link_rejected"},
		{`SELECT scf.op_approve_tenant_evidence($1, 'ok')`, "verification.operator_approved"},
	} {
		if _, au, err := callOp(t, app, w.sql, A); err != nil {
			t.Errorf("%s: %s", w.action, sqlState(err))
		} else {
			oneAudit(t, au, w.action)
		}
	}
	// 0059: a domain that is not disputed (A's seed domain is verified) is 'not found'; the success path is in
	// jobs_followups_test.go (TestOpResolveDomainDispute0059).
	if _, _, err := callOp(t, app, `SELECT scf.op_resolve_domain_dispute($1, '`+uid(A, 2)+`', 'keep')`, A); code(err) != "P0002" {
		t.Errorf("dispute on a verified domain: want P0002, got %s", sqlState(err))
	}
	rows, au, err = callOp(t, app, `SELECT scf.op_tenant_transition($1, 'suspend', 'test')::text`, B)
	if err != nil || len(rows) != 1 || rows[0][0] != "suspended" {
		t.Errorf("suspend B: %v %s", rows, sqlState(err))
	} else if a := oneAudit(t, au, "tenant.suspended"); a.tenant == nil || *a.tenant != B {
		t.Errorf("suspend audit must be in B's chain")
	}
	if _, _, err = callOp(t, app, `SELECT scf.op_tenant_transition($1, 'remove', 'test')`, B); !strings.Contains(sqlState(err), "operator_admin required") {
		t.Errorf("remove by plain operator: got %s", sqlState(err))
	}
	rows, au, err = callOp(t, admin, `SELECT scf.op_tenant_transition($1, 'remove', 'test')::text`, B)
	if err != nil || rows[0][0] != "removed" {
		t.Errorf("remove by operator_admin: %v %s", rows, sqlState(err))
	} else {
		oneAudit(t, au, "tenant.removed")
	}
	rows, au, err = callOp(t, admin, `SELECT scf.op_tenant_transition($1, 'require_reapproval', 'bulk')::text`, A)
	if err != nil || rows[0][0] != "pending" {
		t.Errorf("C-91/C-94 require_reapproval: %v %s", rows, sqlState(err))
	} else {
		oneAudit(t, au, "tenant.reapproval_required")
	}
	if _, _, err = callOp(t, admin, `SELECT scf.op_tenant_transition($1, 'restore', 'x')`, A); code(err) != "22023" {
		t.Errorf("restore of an active tenant: want 22023, got %s", sqlState(err))
	}
	var tomb string
	if err := super(t).QueryRow(context.Background(), `SELECT tombstone_id::text FROM scf.enrollment_tombstones LIMIT 1`).Scan(&tomb); err != nil {
		t.Fatal(err)
	}
	if _, au, err = callOp(t, admin, `SELECT scf.op_lift_tombstone($1)`, tomb); err != nil {
		t.Errorf("lift tombstone: %s", sqlState(err))
	} else if a := oneAudit(t, au, "operator.tombstone_lifted"); a.tenant != nil {
		t.Errorf("tombstone lift belongs to the platform chain, got %v", *a.tenant)
	}
	if _, _, err = callOp(t, app, `SELECT scf.op_lift_tombstone($1)`, tomb); !strings.Contains(sqlState(err), "operator_admin required") {
		t.Errorf("lift by plain operator: got %s", sqlState(err))
	}
}

// Restore returns a removed tenant to suspended (C-94); remove leaves tombstones (C-64).
func TestOpRemoveRestore(t *testing.T) {
	conn := runtimeConn(t, "scf_app")
	err := inCtx(t, conn, adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		var s string
		if err := tx.QueryRow(ctx, `SELECT scf.op_tenant_transition($1, 'remove', 'r')::text`, A).Scan(&s); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `SELECT scf.op_tenant_transition($1, 'restore', 'r')::text`, A).Scan(&s); err != nil {
			return err
		}
		if s != "suspended" {
			return fmt.Errorf("restore returned %s, want suspended", s)
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.audit_log WHERE tx_id = pg_current_xact_id()`).Scan(&n); err != nil {
			return err
		}
		if n != 2 {
			return fmt.Errorf("want 2 audit rows, got %d", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
}

func TestOpNoOtherWayIn(t *testing.T) {
	d0, today, _ := days(t)
	_, au, err := callOp(t, opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}}, `SELECT * FROM scf.op_web_metrics($1, $2)`, d0, today)
	if code(err) != "42501" || len(au) != 0 {
		t.Errorf("tenant user calling op_web_metrics: want 42501 and no audit row, got %s %v", sqlState(err), au)
	}
	for _, role := range []string{"scf_writer", "scf_jobs"} {
		if _, _, err := callOp(t, opCall{role, operatorCtx(true)}, `SELECT * FROM scf.op_web_metrics($1, $2)`, d0, today); code(err) != "42501" {
			t.Errorf("%s calling op_web_metrics: want 42501, got %s", role, sqlState(err))
		}
	}
	for _, role := range []string{"scf_app", "scf_metrics_ro", "scf_writer", "scf_jobs"} {
		if _, _, err := callOp(t, opCall{role, operatorCtx(true)}, `SELECT scf.op_begin('operator.read.op_projects', NULL, NULL, '{}'::jsonb)`); code(err) != "42501" {
			t.Errorf("%s calling op_begin: want 42501, got %s", role, sqlState(err))
		}
		if _, _, err := callOp(t, opCall{role, operatorCtx(true)}, `SELECT scf.op_authorize(NULL, true, true)`); code(err) != "42501" {
			t.Errorf("%s calling op_authorize: want 42501, got %s", role, sqlState(err))
		}
		if _, _, err := callOp(t, opCall{role, operatorCtx(true)}, `SELECT * FROM scf.op_eligible_tenants(0::smallint)`); code(err) != "42501" {
			t.Errorf("%s calling op_eligible_tenants: want 42501, got %s", role, sqlState(err))
		}
	}
	rows, _, err := callOp(t, opCall{"scf_app", operatorCtx(true)}, `SELECT count(*) FROM scf.web_daily_totals`)
	if err != nil || rows[0][0].(int64) != 0 {
		t.Errorf("operator context reading a base table: want 0 rows, got %v %s", rows, sqlState(err))
	}
	// catalog: every op_* is owned by scf_op_definer with no PUBLIC EXECUTE; all but the three helpers are definer
	bad, err := queryStrings(context.Background(), super(t), `SELECT p.proname FROM pg_proc p
	   WHERE p.pronamespace = 'scf'::regnamespace AND p.proname LIKE 'op\_%' AND p.proname <> 'op_count'
	     AND (pg_get_userbyid(p.proowner) <> 'scf_op_definer' OR has_function_privilege('public', p.oid, 'EXECUTE')
	          OR (NOT p.prosecdef AND p.proname NOT IN ('op_authorize', 'op_begin', 'op_eligible_tenants')))`)
	if err != nil || len(bad) > 0 {
		t.Errorf("op_* catalog exceptions: %v %v", bad, err)
	}
}
