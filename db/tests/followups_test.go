// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Day-2 database follow-ups for the control plane (migrations 0053–0056, docs/data-model.md §11, §12):
// labels in op_* rows, today's verified events in op_tenant_detail, revocation of an operator key seen in a URL,
// and the erasure queue's spool sweeps and stale-run re-claims.

func sha256Bytes(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

// asRoleInTx runs fn in a superuser transaction that first applies setup (as the superuser), then switches to role
// and sets c through scf.set_tenant_ctx(). Everything is rolled back. Used where a test needs fixture rows that a
// runtime role could not write in the same transaction.
func asRoleInTx(t *testing.T, setup, role string, c Ctx, fn func(ctx context.Context, tx pgx.Tx) error) error {
	t.Helper()
	ctx := context.Background()
	tx, err := super(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if setup != "" {
		if _, err := tx.Exec(ctx, setup); err != nil {
			t.Fatalf("setup: %s", sqlState(err))
		}
	}
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+role); err != nil {
		t.Fatal(err)
	}
	if err := setCtx(ctx, tx, c); err != nil {
		return err
	}
	return fn(ctx, tx)
}

// (a) Rows of op_web_metrics, op_web_breakdown, op_trust and op_api_metrics carry the tenant's slug (and, for API
// rows grouped by service or route, the service name), so callers need no second, separately audited read; a key
// without registry:read gets them too. Grouping 'all' leaves the labels NULL. Still exactly one audit row per call.
func TestOpRowLabels(t *testing.T) {
	d0, today, d2 := days(t)
	app := opCall{"scf_app", operatorCtx(true)}
	webKey := opCall{"scf_metrics_ro", keyCtx("web:read")}
	apiKey := opCall{"scf_metrics_ro", keyCtx("api:read")}
	wantSlug := map[string]string{A: "tenant-a", B: "tenant-b"}

	checkSlugs := func(t *testing.T, rows [][]any) {
		t.Helper()
		if len(rows) == 0 {
			t.Fatal("no rows")
		}
		for _, r := range rows {
			if got := str(r[1]); got != wantSlug[str(r[0])] {
				t.Errorf("tenant %s: slug %q, want %q", str(r[0]), got, wantSlug[str(r[0])])
			}
		}
	}
	for _, c := range []struct {
		name, action, sql string
		oc                opCall
		args              []any
	}{
		{"op_web_metrics site", "op_web_metrics", `SELECT tenant_id, slug FROM scf.op_web_metrics($1, $2, 'day', 'site')`, webKey, []any{d0, today}},
		{"op_web_metrics tenant", "op_web_metrics", `SELECT tenant_id, slug FROM scf.op_web_metrics($1, $2)`, app, []any{d0, today}},
		{"op_web_breakdown", "op_web_breakdown", `SELECT tenant_id, slug FROM scf.op_web_breakdown($1, $2, 'country')`, webKey, []any{d0, today}},
		{"op_trust", "op_trust", `SELECT tenant_id, slug FROM scf.op_trust($1, $2)`, webKey, []any{d0, today}},
		{"op_api_metrics tenant", "op_api_metrics", `SELECT tenant_id, slug FROM scf.op_api_metrics($1, $2, 'range', 'tenant')`, apiKey, []any{today, d2}},
	} {
		t.Run(c.name, func(t *testing.T) {
			rows, au, err := callOp(t, c.oc, c.sql, c.args...)
			if err != nil {
				t.Fatal(sqlState(err))
			}
			checkSlugs(t, rows)
			oneAudit(t, au, "operator.read."+c.action)
		})
	}
	t.Run("op_api_metrics service and route carry service_name", func(t *testing.T) {
		for _, g := range []string{"service", "route"} {
			rows, au, err := callOp(t, apiKey, `SELECT tenant_id, slug, service_name FROM scf.op_api_metrics($1, $2, 'range', $3)`, today, d2, g)
			if err != nil {
				t.Fatal(sqlState(err))
			}
			checkSlugs(t, rows)
			for _, r := range rows {
				if want := "svc-" + wantSlug[str(r[0])]; str(r[2]) != want {
					t.Errorf("group %s: service_name %q, want %q", g, str(r[2]), want)
				}
			}
			oneAudit(t, au, "operator.read.op_api_metrics")
		}
		rows, _, err := callOp(t, apiKey, `SELECT service_name FROM scf.op_api_metrics($1, $2, 'range', 'tenant')`, today, d2)
		if err != nil || len(rows) == 0 || rows[0][0] != nil {
			t.Errorf("group tenant: service_name must be NULL, got %v %s", rows, sqlState(err))
		}
	})
	t.Run("group all has no labels", func(t *testing.T) {
		for _, sql := range []string{
			`SELECT slug, NULL FROM scf.op_web_metrics($1, $2, 'day', 'all')`,
			`SELECT slug, NULL FROM scf.op_web_breakdown($1, $2, 'country', p_group => 'all')`,
		} {
			rows, _, err := callOp(t, app, sql, d0, today)
			if err != nil || len(rows) == 0 || rows[0][0] != nil {
				t.Errorf("%s: want NULL slug, got %v %s", sql, rows, sqlState(err))
			}
		}
		rows, _, err := callOp(t, app, `SELECT slug, service_name FROM scf.op_api_metrics($1, $2, 'range', 'all')`, today, d2)
		if err != nil || len(rows) != 1 || rows[0][0] != nil || rows[0][1] != nil {
			t.Errorf("op_api_metrics all: want NULL labels, got %v %s", rows, sqlState(err))
		}
	})
	t.Run("key tenant restriction still applies", func(t *testing.T) {
		rows, _, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("web:read", A)}, `SELECT tenant_id, slug FROM scf.op_web_metrics($1, $2)`, d0, today)
		if err != nil || len(rows) != 1 || str(rows[0][1]) != "tenant-a" {
			t.Errorf("want only tenant-a, got %v %s", rows, sqlState(err))
		}
	})
	t.Run("unchanged columns keep their order", func(t *testing.T) {
		// The new columns are appended: existing positional readers keep working.
		cols, err := queryStrings(context.Background(), super(t), `
		  SELECT p.proname || ':' || array_to_string(p.proargnames[pronargs + 1:], ',') FROM pg_proc p
		   WHERE p.pronamespace = 'scf'::regnamespace AND p.proname IN ('op_web_metrics', 'op_web_breakdown', 'op_trust', 'op_api_metrics')
		   ORDER BY 1`)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{
			"op_api_metrics:tenant_id,service_id,route,rpc_method,bucket_start,verification_level,requests,status_2xx,status_3xx,status_4xx,status_5xx,status_unknown,error_rate_5xx,mean_s,p50_s,p95_s,p99_s,accuracy_class,suppressed,slug,service_name",
			"op_trust:tenant_id,site_id,day,window_days,score,components,reason_codes,decision_rate,algorithm_version,slug",
			"op_web_breakdown:tenant_id,value,visitors_sum,pageviews,events,suppressed,slug,hidden_rows",
			"op_web_metrics:tenant_id,site_id,day,verification_level,pageviews,pageviews_unidentified,visitors_sum,visits,bounces,bounce_rate_pct,avg_visit_duration_s,suspect_pageview_share,all_final,suppressed,slug",
		}
		if !slices.Equal(cols, want) {
			t.Errorf("result columns:\n got %v\nwant %v", cols, want)
		}
	})
}

// (b) op_tenant_detail reports today's verified-event count per site — the quota counter of §8.9
// (web_edge_counters, counter 'verdict', label 'verified', current UTC day) — and nothing else.
func TestOpTenantDetailVerifiedEventsToday(t *testing.T) {
	site := uid(A, 1)
	// Yesterday's verified events and today's suspect events must not count.
	setup := fmt.Sprintf(`
	  INSERT INTO scf.web_edge_counters VALUES ('%[1]s', '%[2]s', (now() AT TIME ZONE 'UTC')::date - 1, 'verdict', 'verified', 100);
	  INSERT INTO scf.web_edge_counters VALUES ('%[1]s', '%[2]s', (now() AT TIME ZONE 'UTC')::date, 'verdict', 'suspect', 50);
	  INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
	    SELECT tenant_id, '%[3]s', 'quiet site', 'quietsitekey000000000k', gen_random_uuid(), 'on', created_by
	      FROM scf.sites WHERE tenant_id = '%[1]s' AND site_id = '%[2]s';`, A, site, uid(A, 42))
	var doc string
	err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT scf.op_tenant_detail($1)::text`, A).Scan(&doc)
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	var d struct {
		Sites []map[string]json.RawMessage `json:"sites"`
	}
	if err := json.Unmarshal([]byte(doc), &d); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, s := range d.Sites {
		var id string
		_ = json.Unmarshal(s["site_id"], &id)
		got[id] = string(s["verified_events_today"])
	}
	if got[site] != "3" || got[uid(A, 42)] != "0" || len(got) != 2 {
		t.Errorf("verified_events_today per site: want %s=3 and %s=0, got %v", site, uid(A, 42), got)
	}
}

// (c) An operator key seen in a URL (wire-formats §k) is revoked through scf.op_key_url_exposed(key_id, secret_hash),
// callable by the operator metrics pool only, effective only with the stored hash (proof of possession), audited
// api_key.compromised_url in the platform chain; scf_metrics_ro still cannot revoke a key directly.
func TestOpKeyUrlExposed(t *testing.T) {
	hop := sha256Bytes("op")
	anon := Ctx{Kind: "anonymous", RequestID: "req-url"}
	type res struct {
		out     string
		revoked bool
		reason  string
		flagged bool
		audit   []auditRow
	}
	call := func(t *testing.T, role string, c Ctx, setup, id string, h []byte) (res, error) {
		t.Helper()
		var r res
		err := asRoleInTx(t, setup, role, c, func(ctx context.Context, tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, `SELECT scf.op_key_url_exposed($1, $2)`, id, h).Scan(&r.out); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "RESET ROLE"); err != nil {
				return err
			}
			var reason *string
			if err := tx.QueryRow(ctx, `SELECT revoked_at IS NOT NULL, revoke_reason, flagged_for_review_at IS NOT NULL
			                              FROM scf.operator_api_keys WHERE key_id = 'opkey0000001'`).Scan(&r.revoked, &reason, &r.flagged); err != nil {
				return err
			}
			if reason != nil {
				r.reason = *reason
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
				r.audit = append(r.audit, a)
			}
			return ar.Err()
		})
		return r, err
	}

	t.Run("matching hash revokes and audits", func(t *testing.T) {
		r, err := call(t, "scf_metrics_ro", anon, "", "opkey0000001", hop)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		if r.out != "revoked" || !r.revoked || !r.flagged || !strings.Contains(r.reason, "URL") {
			t.Errorf("want revoked + flagged with a URL reason, got %+v", r)
		}
		a := oneAudit(t, r.audit, "api_key.compromised_url")
		if a.tenant != nil || a.outcome != "success" || a.actorKind != "anonymous" {
			t.Errorf("audit row: want platform chain, success, anonymous; got %+v", a)
		}
	})
	t.Run("audit details name the key, never the secret", func(t *testing.T) {
		var details string
		err := asRoleInTx(t, "", "scf_metrics_ro", anon, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT scf.op_key_url_exposed('opkey0000001', $1)`, hop); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "RESET ROLE"); err != nil {
				return err
			}
			return tx.QueryRow(ctx, `SELECT target_type || ' ' || target_id || ' ' || details::text FROM scf.audit_log
			                          WHERE tx_id = pg_current_xact_id()`).Scan(&details)
		})
		if err != nil {
			t.Fatal(sqlState(err))
		}
		if !strings.HasPrefix(details, "operator_api_key opkey0000001 ") || strings.Contains(details, "\\x") {
			t.Errorf("details: %s", details)
		}
	})
	t.Run("wrong hash or unknown key does nothing", func(t *testing.T) {
		for _, c := range []struct {
			id string
			h  []byte
		}{{"opkey0000001", sha256Bytes("not-the-secret")}, {"opkey9999999", hop}, {"opkey0000001", []byte{1, 2, 3}}} {
			r, err := call(t, "scf_metrics_ro", anon, "", c.id, c.h)
			if err != nil {
				t.Fatal(sqlState(err))
			}
			if r.out != "no_match" || r.revoked || r.flagged || len(r.audit) != 0 {
				t.Errorf("%s: want no_match and no effect, got %+v", c.id, r)
			}
		}
	})
	t.Run("already revoked key keeps its first revocation", func(t *testing.T) {
		setup := `UPDATE scf.operator_api_keys SET revoked_at = now() - interval '1 day', revoke_reason = 'rotated'
		           WHERE key_id = 'opkey0000001'`
		r, err := call(t, "scf_metrics_ro", anon, setup, "opkey0000001", hop)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		if r.out != "already_revoked" || r.reason != "rotated" || len(r.audit) != 0 {
			t.Errorf("want already_revoked, reason kept, no audit; got %+v", r)
		}
	})
	t.Run("only the metrics pool may call it", func(t *testing.T) {
		for _, role := range []string{"scf_app", "scf_jobs", "scf_writer"} {
			if _, err := call(t, role, operatorCtx(true), "", "opkey0000001", hop); code(err) != "42501" {
				t.Errorf("%s: want 42501, got %s", role, sqlState(err))
			}
		}
	})
	t.Run("no direct revocation by scf_metrics_ro", func(t *testing.T) {
		err := asRoleInTx(t, "", "scf_metrics_ro", anon, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE scf.operator_api_keys SET revoked_at = now() WHERE key_id = 'opkey0000001'`)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("want 42501, got %s", sqlState(err))
		}
	})
}

// (d), (e) scf.job_queue('erasure') returns previewing and confirmed requests, running requests whose run started
// more than an hour ago (re-claim after a crash), and completed requests whose edge-spool sweep is due — and nothing
// else. A malformed due_at never breaks the queue.
func TestJobQueueErasure(t *testing.T) {
	site := uid(A, 1)
	req := func(n int) string { return fmt.Sprintf("e0000000-0000-7000-8000-%012d", n) }
	const crit = `'{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","path_pattern":"/y/*"}'`
	const redacted = `'{"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z","selector":{"type":"path_pattern","length":4}}'`
	row := func(n int, status, criteria, started, finished, redactedAt, result string) string {
		return fmt.Sprintf(`INSERT INTO scf.erasure_requests (tenant_id, request_id, site_id, criteria, status, requested_by,
		    created_at, started_at, finished_at, selector_redacted_at, result)
		  SELECT '%s', '%s', '%s', %s, '%s', requested_by, now() - interval '%d minutes', %s, %s, %s, %s
		    FROM scf.erasure_requests WHERE tenant_id = '%s' LIMIT 1;`,
			A, req(n), site, criteria, status, 100-n, started, finished, redactedAt, result, A)
	}
	due := `'{"spool_sweep":{"due_at":"` + "2020-01-01T00:00:00Z" + `"}}'`
	later := `jsonb_build_object('spool_sweep', jsonb_build_object('due_at', now() + interval '1 hour'))`
	setup := strings.Join([]string{
		row(1, "confirmed", crit, "NULL", "NULL", "NULL", "NULL"),                        // in
		row(2, "running", crit, "now() - interval '2 hours'", "NULL", "NULL", "NULL"),    // in: stale
		row(3, "running", crit, "now() - interval '10 minutes'", "NULL", "NULL", "NULL"), // out: fresh
		row(4, "completed", crit, "now() - interval '3 hours'", "now()", "NULL", due),    // in: sweep due
		row(5, "completed", crit, "now() - interval '3 hours'", "now()", "NULL", later),  // out: not yet due
		row(6, "completed", crit, "now() - interval '3 hours'", "now()", "NULL", // out: swept
			`'{"spool_sweep":{"due_at":"2020-01-01T00:00:00Z","done_at":"2020-01-01T01:00:00Z"}}'`),
		row(7, "completed", crit, "now() - interval '3 hours'", "now()", "NULL", "'{}'"),   // out: no sweep
		row(8, "completed", redacted, "now() - interval '3 hours'", "now()", "now()", due), // out: redacted
		row(9, "completed", crit, "now() - interval '3 hours'", "now()", "NULL", // out: malformed
			`'{"spool_sweep":{"due_at":"not a time"}}'`),
		row(10, "failed", crit, "now() - interval '3 hours'", "now()", "NULL", due), // out
		row(11, "cancelled", crit, "NULL", "now()", "NULL", "NULL"),                 // out
		row(12, "previewed", crit, "NULL", "NULL", "NULL", "NULL"),                  // out: waits for the user
		row(13, "running", crit, "NULL", "NULL", "NULL", "NULL"),                    // out: no start time
	}, "\n")
	var got []string
	err := asRoleInTx(t, setup, "scf_jobs", Ctx{Kind: "job", Actor: "erasure", Job: "erasure"}, func(ctx context.Context, tx pgx.Tx) error {
		r, err := tx.Query(ctx, `SELECT tenant_id::text, item_id::text FROM scf.job_queue('erasure')`)
		if err != nil {
			return err
		}
		defer r.Close()
		for r.Next() {
			var tn, item string
			if err := r.Scan(&tn, &item); err != nil {
				return err
			}
			if tn == A {
				got = append(got, item)
			}
		}
		return r.Err()
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	want := []string{req(1), req(2), req(4), uid(A, 7)} // uid(A, 7): the seeded previewing request
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("queue for A:\n got %v\nwant %v", got, want)
	}
	// still only for job erasure, without a tenant context
	err = asRoleInTx(t, "", "scf_jobs", Ctx{Tenant: A, Kind: "job", Actor: "erasure", Job: "erasure"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT * FROM scf.job_queue('erasure')`)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("with a tenant context: want 42501, got %s", sqlState(err))
	}
}
