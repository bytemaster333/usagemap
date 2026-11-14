// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Migrations 0067–0069 and gate G12: Umami website ids, INSERT column guards, trust signals, definer visibility,
// per-command job policies, the last active operator_admin, host claims (revenue pruning is in umami_test.go).

// tryAll runs each statement in its own savepoint of tx and reports any whose SQLSTATE is not want ("" = success).
type stmtCase struct {
	name, want, sql string
	args            []any
}

func tryAll(t *testing.T, ctx context.Context, tx pgx.Tx, cases []stmtCase) {
	t.Helper()
	for _, c := range cases {
		err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			_, err := sp.Exec(ctx, c.sql, c.args...)
			return err
		})
		if code(err) != c.want || (c.want == "" && err != nil) {
			t.Errorf("%s: want %q, got %q", c.name, c.want, sqlState(err))
		}
	}
}

// The column list of the control plane's createSite (services/control-plane/src/domain/sites.ts).
const appInsertSite = `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id,
    tracker_profile, visitor_id, visitor_id_off_countries, visitor_id_explicit, exclude_countries, path_folding,
    event_retention_days, opt_out_page_url, created_by, dev_origins)
  VALUES ($1, gen_random_uuid(), 'c1 site', substr(md5(gen_random_uuid()::text), 1, 22), $2, $3::uuid, 'standard',
          CASE WHEN $3::uuid IS NULL THEN 'on' ELSE 'off' END, '{}', false, '{}', 'full', NULL, NULL, $4, '{}')`

// Finding 1: an Umami website id is unique across main and twin columns and across tenants; ids never change.
func TestUmamiWebsiteIdsUnique(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	siteA, siteB := uid(A, 1), uid(B, 1)
	mainA, mainB := uid(A, 11), uid(B, 11)
	twin := "aaaaaaaa-7777-7000-8000-000000000001"
	err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		tryAll(t, ctx, tx, []stmtCase{
			{"A's twin := B's main id", "23505",
				`UPDATE scf.sites SET visitor_id = 'off', umami_twin_website_id = $2 WHERE site_id = $1`, []any{siteA, mainB}},
			{"new site of A with B's main id as its main id", "23505", appInsertSite, []any{A, mainB, nil, users[A]}},
			{"new site of A with B's main id as its twin id", "23505", appInsertSite, []any{A, "aaaaaaaa-7777-7000-8000-000000000002", mainB, users[A]}},
			{"new site of A reusing A's own main id", "23505", appInsertSite, []any{A, "aaaaaaaa-7777-7000-8000-000000000003", mainA, users[A]}},
			{"main id changed", "42501", `UPDATE scf.sites SET umami_website_id = gen_random_uuid() WHERE site_id = $1`, []any{siteA}},
			{"the registry is not readable by scf_app", "42501", `SELECT count(*) FROM scf.umami_websites`, nil},
			{"the registry is not writable by scf_app", "42501",
				`INSERT INTO scf.umami_websites VALUES (gen_random_uuid(), $1, $2, 'twin')`, []any{A, siteA}},
			{"a fresh new site", "", appInsertSite, []any{A, "aaaaaaaa-7777-7000-8000-000000000004", "aaaaaaaa-7777-7000-8000-000000000005", users[A]}},
		})
		// a fresh twin is assigned once (NULL → id) and never changes afterwards; rewriting the same value is fine
		if _, err := tx.Exec(ctx, `UPDATE scf.sites SET visitor_id = 'off', umami_twin_website_id = $2 WHERE site_id = $1`, siteA, twin); err != nil {
			return err
		}
		tryAll(t, ctx, tx, []stmtCase{
			{"twin changed once set", "42501", `UPDATE scf.sites SET umami_twin_website_id = gen_random_uuid() WHERE site_id = $1`, []any{siteA}},
			{"twin cleared once set", "42501", `UPDATE scf.sites SET visitor_id = 'on', umami_twin_website_id = NULL WHERE site_id = $1`, []any{siteA}},
			{"same values rewritten (updateSite)", "", `UPDATE scf.sites SET name = name, umami_twin_website_id = umami_twin_website_id WHERE site_id = $1`, []any{siteA}},
			{"A's new twin as a new site's main id", "23505", appInsertSite, []any{A, twin, nil, users[A]}},
		})
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	// every writer, the superuser included, is bound by the registry; it mirrors scf.sites exactly
	if err := tryIn(t, `UPDATE scf.sites SET visitor_id = 'off', umami_twin_website_id = '`+mainA+`' WHERE site_id = '`+siteB+`'`); code(err) != "23505" {
		t.Errorf("superuser: B's twin := A's main id: want 23505, got %q", sqlState(err))
	}
	var drift int
	if err := super(t).QueryRow(context.Background(), `
	  SELECT (SELECT count(*) FROM scf.sites s WHERE NOT EXISTS (SELECT 1 FROM scf.umami_websites w
	           WHERE w.website_id = s.umami_website_id AND w.tenant_id = s.tenant_id AND w.site_id = s.site_id AND w.variant = 'main'))
	       + (SELECT count(*) FROM scf.sites s WHERE s.umami_twin_website_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scf.umami_websites w
	           WHERE w.website_id = s.umami_twin_website_id AND w.tenant_id = s.tenant_id AND w.site_id = s.site_id AND w.variant = 'twin'))
	       + (SELECT count(*) FROM scf.umami_websites w WHERE NOT EXISTS (SELECT 1 FROM scf.sites s
	           WHERE s.tenant_id = w.tenant_id AND s.site_id = w.site_id
	             AND w.website_id = CASE w.variant WHEN 'main' THEN s.umami_website_id ELSE s.umami_twin_website_id END))`).Scan(&drift); err != nil {
		t.Fatal(sqlState(err))
	}
	if drift != 0 {
		t.Errorf("scf.umami_websites differs from scf.sites in %d rows", drift)
	}
	// a deleted site frees its ids (FK cascade)
	if err := tryIn(t, `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
	    VALUES ('`+A+`', 'aaaaaaaa-7777-7000-8000-000000000006', 'x', 'c1sitekeyc1sitekeyc1si', 'aaaaaaaa-7777-7000-8000-000000000007', 'on', '`+users[A]+`')`,
		`DELETE FROM scf.sites WHERE site_id = 'aaaaaaaa-7777-7000-8000-000000000006'`,
		`INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
	    VALUES ('`+B+`', 'bbbbbbbb-7777-7000-8000-000000000006', 'x', 'c1sitekeyc1sitekeyc1sj', 'aaaaaaaa-7777-7000-8000-000000000007', 'on', '`+users[B]+`')`); err != nil {
		t.Errorf("an id freed by a deleted site: %s", sqlState(err))
	}
}

// Finding 3: scf_app inserts sites only with the columns createSite writes; the operator-only and job-only columns
// keep their defaults. And no table anywhere has a column-level UPDATE guard with a table-level INSERT next to it.
func TestSitesInsertColumnGuard(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		base := `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by%s)
		    VALUES ($1, gen_random_uuid(), 'x', substr(md5(gen_random_uuid()::text), 1, 22), gen_random_uuid(), 'on', $2%s)`
		with := func(col, val string) string {
			return strings.Replace(strings.Replace(base, "%s", ", "+col, 1), "%s", ", "+val, 1)
		}
		tryAll(t, ctx, tx, []stmtCase{
			{"multiplicity_mode shadow (C-124: operator_admin only)", "42501", with("multiplicity_mode", "'shadow'"), []any{A, users[A]}},
			{"twin_provisioned_at (umami_reconcile only)", "42501",
				with("umami_twin_website_id, twin_provisioned_at", "gen_random_uuid(), now()"), []any{A, users[A]}},
			{"status purging", "42501", with("status", "'purging'"), []any{A, users[A]}},
			{"archived_at", "42501", with("archived_at", "now()"), []any{A, users[A]}},
			{"debug_until", "42501", with("debug_until", "now() + interval '1 day'"), []any{A, users[A]}},
			{"createSite's own column list", "", appInsertSite, []any{A, "aaaaaaaa-7777-7000-8000-000000000011", nil, users[A]}},
		})
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}
	rows, err := queryStrings(context.Background(), super(t), `
	  SELECT r.rolname || ' ' || c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	   CROSS JOIN pg_roles r
	   WHERE n.nspname = 'scf' AND c.relkind IN ('r', 'p') AND r.rolname IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro')
	     AND has_table_privilege(r.oid, c.oid, 'INSERT') AND NOT has_table_privilege(r.oid, c.oid, 'UPDATE')
	     AND has_any_column_privilege(r.oid, c.oid, 'UPDATE')`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	if len(rows) > 0 {
		t.Errorf("column-guarded UPDATE but table-level INSERT (the guard can be bypassed by INSERT): %v", rows)
	}
}

// Finding 2: trust signals are written by the verifying job or the operator path, never by scf_app for its own tenant.
func TestTrustSignalsWrittenByVerifiersOnly(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	g := "G" + strings.Repeat("B", 55)
	err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		ev := `INSERT INTO scf.verification_evidence (tenant_id, kind, subject, created_by) VALUES ($1, $2, $3, $4)`
		tryAll(t, ctx, tx, []stmtCase{
			// evidence
			{"evidence operator_approval (L4)", "42501", ev, []any{A, "operator_approval", "operator", users[A]}},
			{"evidence domain", "42501", ev, []any{A, "domain", "other.example.org", users[A]}},
			{"evidence registry_match", "42501", ev, []any{A, "registry_match", reg, users[A]}},
			{"evidence operator_approval via upsert", "42501", ev + ` ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET status = 'valid'`,
				[]any{A, "operator_approval", "operator", users[A]}},
			{"evidence stellar_account (the control plane checks the signature)", "", ev, []any{A, "stellar_account", g, users[A]}},
			{"domain evidence rewritten", "42501", `UPDATE scf.verification_evidence SET subject = 'x.example.org' WHERE evidence_id = $1`, []any{uid(A, 5)}},
			{"stellar evidence turned into domain evidence", "42501", `UPDATE scf.verification_evidence SET kind = 'domain' WHERE evidence_id = $1`, []any{uid(A, 12)}},
			// site_domains
			{"domain state := verified", "42501", `UPDATE scf.site_domains SET state = 'verified' WHERE domain_id = $1`, []any{uid(A, 2)}},
			{"domain verified_at", "42501", `UPDATE scf.site_domains SET verified_at = now() WHERE domain_id = $1`, []any{uid(A, 2)}},
			{"domain host changed", "42501", `UPDATE scf.site_domains SET host = 'other.example.org' WHERE domain_id = $1`, []any{uid(A, 2)}},
			{"domain inserted verified", "42501", `INSERT INTO scf.site_domains (tenant_id, site_id, host, state) VALUES ($1, $2, 'new.example.org', 'verified')`, []any{A, uid(A, 1)}},
			{"domain inserted with grace_until", "42501", `INSERT INTO scf.site_domains (tenant_id, site_id, host, grace_until) VALUES ($1, $2, 'new.example.org', now())`, []any{A, uid(A, 1)}},
			{"domain declared (addDomain)", "", `INSERT INTO scf.site_domains (tenant_id, site_id, host, include_subdomains) VALUES ($1, $2, 'new.example.org', false)`, []any{A, uid(A, 1)}},
			// declared_contracts
			{"contract := verified", "42501", `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer',
			    verified_by_evidence = $2, verified_at = now() WHERE contract_ref = $1`, []any{uid(A, 6), uid(A, 12)}},
			{"contract := rejected", "42501", `UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'not_found_on_ledger' WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"contract id changed", "42501", `UPDATE scf.declared_contracts SET contract_id = 'C' || repeat('B', 55) WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"contract inserted verified", "42501", `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, status, verified_role, verified_by_evidence, created_by)
			    VALUES ($1, 'C' || repeat('D', 55), 'public', 'verified', 'admin', $2, $3)`, []any{A, uid(A, 12), users[A]}},
			{"contract declared (declareContract)", "", `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, label, service_id, created_by)
			    VALUES ($1, 'C' || repeat('E', 55), 'public', 'x', NULL, $2)`, []any{A, users[A]}},
			{"contract re-check requested", "", `UPDATE scf.declared_contracts SET next_check_at = now() WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"contract removed", "", `UPDATE scf.declared_contracts SET removed_at = now() WHERE contract_ref = $1`, []any{uid(A, 6)}},
		})
		// a domain's evidence may be lapsed (removeDomain), never made valid again by the control plane
		if _, err := tx.Exec(ctx, `UPDATE scf.verification_evidence SET status = 'lapsed', lapsed_at = now() WHERE evidence_id = $1`, uid(A, 5)); err != nil {
			t.Errorf("domain evidence lapsed by scf_app: %s", sqlState(err))
		}
		tryAll(t, ctx, tx, []stmtCase{{"domain evidence made valid again", "42501",
			`UPDATE scf.verification_evidence SET status = 'valid', lapsed_at = NULL WHERE evidence_id = $1`, []any{uid(A, 5)}}})
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}

	// a contract verified by the job: the tenant may edit the label and reset (re-declare) it, never touch the proof
	setup := `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer', verified_by_evidence = '` + uid(A, 12) +
		`', verified_at = now(), verification_method = 'deployer_admin_match' WHERE contract_ref = '` + uid(A, 6) + `'`
	err = asRoleInTx(t, setup, "scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		tryAll(t, ctx, tx, []stmtCase{
			{"label of a verified contract", "", `UPDATE scf.declared_contracts SET label = 'x' WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"conflict flag", "42501", `UPDATE scf.declared_contracts SET conflict_since = now() WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"verified_role switched", "42501", `UPDATE scf.declared_contracts SET verified_role = 'admin' WHERE contract_ref = $1`, []any{uid(A, 6)}},
			{"re-declare reset (api/services.ts declareContractRow)", "", `UPDATE scf.declared_contracts
			    SET removed_at = NULL, label = 'y', service_id = NULL, status = 'declared', verified_role = NULL,
			        verified_by_evidence = NULL, verified_at = NULL, last_checked_at = NULL, created_by = $2,
			        created_at = now(), verification_method = NULL, rejected_reason = NULL, next_check_at = NULL,
			        conflict_since = NULL
			  WHERE tenant_id = $3 AND contract_ref = $1`, []any{uid(A, 6), users[A], A}},
		})
		return nil
	})
	if err != nil {
		t.Fatal(sqlState(err))
	}

	// the jobs write only their own kind of evidence
	jobsConn := runtimeConn(t, "scf_jobs")
	for _, c := range []struct {
		job  string
		kind string
		ok   bool
	}{
		{"domain_verification", "domain", true}, {"domain_verification", "registry_match", false},
		{"domain_verification", "operator_approval", false}, {"domain_verification", "stellar_account", false},
		{"registry_sync", "registry_match", true}, {"registry_sync", "domain", false}, {"registry_sync", "operator_approval", false},
		{"contract_verification", "domain", false},
	} {
		subject := map[string]string{"domain": "job.example.org", "registry_match": reg, "operator_approval": "operator", "stellar_account": g}[c.kind]
		err := inCtx(t, jobsConn, Ctx{Tenant: A, Kind: "job", Actor: c.job, Job: c.job}, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO scf.verification_evidence (tenant_id, kind, subject) VALUES ($1, $2, $3)
			    ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET status = 'valid'`, A, c.kind, subject)
			return err
		})
		if c.ok && err != nil || !c.ok && code(err) != "42501" {
			t.Errorf("job %s writes %s evidence: ok=%v, got %q", c.job, c.kind, c.ok, sqlState(err))
		}
	}
	// the operator path still approves (op_approve_tenant_evidence, operator_admin with step-up)
	if _, _, err := callOp(t, opCall{"scf_app", adminCtx()}, `SELECT scf.op_approve_tenant_evidence($1, 'c1')`, A); err != nil {
		t.Errorf("op_approve_tenant_evidence: %s", sqlState(err))
	}
}

// Finding 4 (C-87): ownership cannot move by deleting the owner row and inserting a new owner without a fresh
// sign-in; the owner row of a tenant being created needs none; job tenant_purge is unaffected.
func TestOwnershipDeleteInsertNeedsFreshSignIn(t *testing.T) {
	stale := time.Now().Add(-11 * time.Minute)
	fresh := time.Now()
	admin := func(reauth *time.Time) Ctx { return Ctx{Tenant: A, Kind: "user", Actor: users[B], Reauth: reauth} }
	addAdmin := `INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ('` + A + `', '` + users[B] + `', 'admin');`
	dropOwner := `DELETE FROM scf.memberships WHERE tenant_id = '` + A + `' AND role = 'owner';`
	for _, c := range []struct {
		name, setup, sql string
		reauth           *time.Time
		want             string
	}{
		{"delete the owner row, stale", addAdmin, `DELETE FROM scf.memberships WHERE tenant_id = '` + A + `' AND user_id = '` + users[A] + `'`, &stale, "42501"},
		{"delete the owner row, no sign-in time", addAdmin, `DELETE FROM scf.memberships WHERE tenant_id = '` + A + `' AND user_id = '` + users[A] + `'`, nil, "42501"},
		{"delete the owner row, fresh", addAdmin, `DELETE FROM scf.memberships WHERE tenant_id = '` + A + `' AND user_id = '` + users[A] + `'`, &fresh, ""},
		{"insert a new owner after the old one went, stale", addAdmin + dropOwner,
			`INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ('` + A + `', '` + users[C] + `', 'owner')`, &stale, "42501"},
		{"insert a new owner after the old one went, fresh", addAdmin + dropOwner,
			`INSERT INTO scf.memberships (tenant_id, user_id, role) VALUES ('` + A + `', '` + users[C] + `', 'owner')`, &fresh, ""},
		{"delete a non-owner, stale (no fresh sign-in needed)", addAdmin,
			`DELETE FROM scf.memberships WHERE tenant_id = '` + A + `' AND user_id = '` + users[B] + `'`, &stale, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := asRoleInTx(t, c.setup, "scf_app", admin(c.reauth), func(ctx context.Context, tx pgx.Tx) error {
				tag, err := tx.Exec(ctx, c.sql)
				if err == nil && tag.RowsAffected() != 1 {
					t.Errorf("%d rows affected", tag.RowsAffected())
				}
				return err
			})
			if code(err) != c.want || (c.want == "" && err != nil) {
				t.Errorf("want %q, got %q", c.want, sqlState(err))
			}
		})
	}
	// a tenant being created: its first member is the owner, without a fresh sign-in (createTenant)
	const n = "dddddddd-7777-7000-8000-000000000001"
	setup := `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ('` + n + `', 'tenant-new-c1', 'n',
	    (CASE WHEN (SELECT value FROM scf.settings WHERE key = 'enrollment_mode') = '"open"'::jsonb THEN 'active' ELSE 'pending' END)::scf.tenant_status,
	    '` + users[A] + `')`
	err := asRoleInTx(t, setup, "scf_app", Ctx{Tenant: n, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.memberships (tenant_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)`, n, users[A])
		return err
	})
	if err != nil {
		t.Errorf("owner of a tenant being created: %s", sqlState(err))
	}
	// job tenant_purge deletes owner rows without any sign-in
	err = inCtx(t, runtimeConn(t, "scf_jobs"), Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.memberships WHERE tenant_id = $1`, A)
		if err == nil && tag.RowsAffected() == 0 {
			t.Error("tenant_purge deleted no membership")
		}
		return err
	})
	if err != nil {
		t.Errorf("tenant_purge: %s", sqlState(err))
	}
}

// Findings 5 and 8b, public functions: they hide pending and removed tenants (status filters).
func TestPublicDefinersHideInactiveTenants(t *testing.T) {
	anon := Ctx{Kind: "anonymous"}
	q := func(t *testing.T, setup, sql string, args ...any) *string {
		t.Helper()
		var out *string
		err := asRoleInTx(t, setup, "scf_app", anon, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, sql, args...).Scan(&out)
		})
		if err != nil {
			t.Fatalf("%s: %s", sql, sqlState(err))
		}
		return out
	}
	pending := `SET LOCAL ROLE scf_op_definer; UPDATE scf.tenants SET status = 'pending' WHERE tenant_id = '` + B + `'; RESET ROLE;`
	snap := `SELECT scf.public_snapshot($1)::text`
	proof := `SELECT scf.public_seal_proof($1)::text`
	if q(t, "", snap, uid(B, 10)) == nil || q(t, "", proof, uid(B, 10)) == nil {
		t.Fatal("active tenant B: snapshot / seal proof not served")
	}
	if v := q(t, pending, snap, uid(B, 10)); v != nil {
		t.Errorf("pending tenant's snapshot served: %s", *v)
	}
	if v := q(t, pending, proof, uid(B, 10)); v != nil {
		t.Errorf("pending tenant's seal proof served: %s", *v)
	}
	private := `UPDATE scf.tenants SET public_stats_enabled = false WHERE tenant_id = '` + B + `';`
	doc := `SELECT scf.public_metrics_document($1, $2)::text`
	if v := q(t, private, doc, "tenant-b", A); v != nil {
		t.Errorf("B's private document served to A's pub key: %s", *v)
	}
	if q(t, private, doc, "tenant-b", B) == nil {
		t.Error("B's private document not served to B's own pub key")
	}
	if v := q(t, pending, doc, "tenant-b", B); v != nil {
		t.Errorf("pending tenant's document served: %s", *v)
	}
}

// Finding 6: on the global tables a job gets only the commands its role needs (per-command policies).
func TestGlobalTablesJobCommands(t *testing.T) {
	newProject := `INSERT INTO scf.registry_projects (source, source_id, name, fetched_at, content_sha256, raw)
	    VALUES ('stellarlight', 'c1-unlinked', 'x', now(), decode(repeat('cd', 32), 'hex'), '{}');`
	for _, c := range []struct {
		job, setup, sql string
		wantRows        bool
	}{
		{"trust_scoring", newProject, `DELETE FROM scf.registry_projects WHERE source_id = 'c1-unlinked'`, false},
		{"registry_sync", newProject, `DELETE FROM scf.registry_projects WHERE source_id = 'c1-unlinked'`, false},
		{"retention", newProject, `DELETE FROM scf.registry_projects WHERE source_id = 'c1-unlinked'`, true},
		{"registry_sync", "", `DELETE FROM scf.registry_sync_runs`, false},
		{"retention", "", `DELETE FROM scf.registry_sync_runs`, true},
		{"durability_reconcile", "", `DELETE FROM scf.edge_spool_accounting`, false},
		{"retention", "", `DELETE FROM scf.edge_spool_accounting`, true},
		{"durability_reconcile", "", `DELETE FROM scf.durability_reports`, false},
		{"retention", "", `DELETE FROM scf.durability_reports`, true},
		{"edge_snapshot", "", `DELETE FROM scf.edge_snapshots`, true}, // supersedes old snapshots itself
		{"retention", "", `DELETE FROM scf.edge_snapshots`, true},
		{"trust_scoring", "", `UPDATE scf.registry_projects SET name = name`, false},
		{"retention", "", `UPDATE scf.durability_reports SET status = status`, false},
	} {
		t.Run(c.job+": "+c.sql, func(t *testing.T) {
			err := asRoleInTx(t, c.setup, "scf_jobs", Ctx{Kind: "job", Actor: c.job, Job: c.job}, func(ctx context.Context, tx pgx.Tx) error {
				tag, err := tx.Exec(ctx, c.sql)
				if err != nil {
					return err
				}
				if (tag.RowsAffected() > 0) != c.wantRows {
					t.Errorf("%d rows affected, want rows: %v", tag.RowsAffected(), c.wantRows)
				}
				return nil
			})
			if err != nil && (c.wantRows || code(err) != "42501") {
				t.Errorf("%s", sqlState(err))
			}
		})
	}
}

// operator.global-view-credentials (C-20): never fewer than one active operator_admin, whatever the path.
func TestLastOperatorAdminKept(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct{ name, sql string }{
		{"revoke", `UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = '` + uAdm + `'`},
		{"demote", `UPDATE scf.platform_operators SET role = 'operator' WHERE user_id = '` + uAdm + `'`},
		{"demote through the grant upsert (operatorGrant)", `INSERT INTO scf.platform_operators (user_id, role) VALUES ('` + uAdm + `', 'operator')
		    ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL`},
		{"delete the grant", `DELETE FROM scf.platform_operators WHERE user_id = '` + uAdm + `'`},
		{"delete the user (C-57 tombstone)", `UPDATE scf.users SET deleted_at = now(), display_name = NULL, contact_email = NULL WHERE user_id = '` + uAdm + `'`},
		{"disable the user", `UPDATE scf.users SET disabled_at = now() WHERE user_id = '` + uAdm + `'`},
	} {
		t.Run(c.name, func(t *testing.T) {
			if err := tryIn(t, c.sql); code(err) != "23514" {
				t.Errorf("last admin: want 23514, got %q", sqlState(err))
			}
			// with a second admin it is allowed
			second := `INSERT INTO scf.users (user_id, display_name) VALUES ('0f000000-7777-7000-8000-000000000001', 'admin 2');
			  INSERT INTO scf.platform_operators (user_id, role) VALUES ('0f000000-7777-7000-8000-000000000001', 'operator_admin')`
			if err := tryIn(t, second, c.sql); err != nil {
				t.Errorf("with a second admin: %s", sqlState(err))
			}
		})
	}
	// a deleted or disabled second admin does not count
	if err := tryIn(t, `INSERT INTO scf.users (user_id, display_name, disabled_at) VALUES ('0f000000-7777-7000-8000-000000000002', 'x', now());
	    INSERT INTO scf.platform_operators (user_id, role) VALUES ('0f000000-7777-7000-8000-000000000002', 'operator_admin')`,
		`UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = '`+uAdm+`'`); code(err) != "23514" {
		t.Errorf("a disabled second admin counted: want 23514, got %q", sqlState(err))
	}
	// non-admins are unaffected (a plain operator revoked, an ordinary user deleted)
	if err := tryIn(t, `UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = '`+uOp+`'`,
		`UPDATE scf.users SET deleted_at = now(), display_name = NULL, contact_email = NULL WHERE user_id = '`+users[C]+`'`); err != nil {
		t.Errorf("non-admin changes: %s", sqlState(err))
	}

	// race: two admins revoke each other at the same time; exactly one revocation commits (committed state, restored)
	const adm2 = "0f000000-7777-7000-8000-000000000003"
	su := super(t)
	mustExec(t, su, `INSERT INTO scf.users (user_id, display_name) VALUES ($1, 'admin 3')`, adm2)
	mustExec(t, su, `INSERT INTO scf.platform_operators (user_id, role) VALUES ($1, 'operator_admin')`, adm2)
	t.Cleanup(func() {
		mustExec(t, su, `UPDATE scf.platform_operators SET revoked_at = NULL, revoked_by = NULL WHERE user_id = $1`, uAdm)
		mustExec(t, su, `DELETE FROM scf.platform_operators WHERE user_id = $1`, adm2)
		mustExec(t, su, `DELETE FROM scf.users WHERE user_id = $1`, adm2)
	})
	c1, c2 := connectTo(t, "postgres", "scf", false), connectTo(t, "postgres", "scf", false)
	var pid2 int
	if err := c2.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid2); err != nil {
		t.Fatal(err)
	}
	tx1, err := c1.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx1.Exec(ctx, `UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = $1`, adm2); err != nil {
		t.Fatalf("first revocation: %s", sqlState(err))
	}
	done := make(chan error, 1)
	go func() {
		tx2, err := c2.Begin(ctx)
		if err != nil {
			done <- err
			return
		}
		_, err = tx2.Exec(ctx, `UPDATE scf.platform_operators SET revoked_at = now() WHERE user_id = $1`, uAdm)
		if err == nil {
			err = tx2.Commit(ctx)
		} else {
			_ = tx2.Rollback(ctx)
		}
		done <- err
	}()
	waiting := false
	for i := 0; i < 200 && !waiting; i++ {
		if err := su.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted)`, pid2).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if !waiting {
			time.Sleep(25 * time.Millisecond)
		}
	}
	if !waiting {
		t.Error("the second revocation did not wait for the first")
	}
	if err := tx1.Commit(ctx); err != nil {
		t.Fatalf("commit first revocation: %s", sqlState(err))
	}
	if err := <-done; code(err) != "23514" {
		t.Errorf("concurrent second revocation: want 23514, got %q", sqlState(err))
	}
	var n int
	if err := su.QueryRow(ctx, `SELECT count(*) FROM scf.platform_operators WHERE role = 'operator_admin' AND revoked_at IS NULL`).Scan(&n); err != nil || n != 1 {
		t.Errorf("active admins after the race: %d %v", n, err)
	}
}

// Control-plane-portal findings 4–6 (C-19): removing a domain lapses its evidence, a lapsed domain releases its claim,
// a host never has two verified owners, and the operator's dispute resolution moves the host consistently.
func TestDomainClaimInvariants(t *testing.T) {
	hostA := slugOf(A) + ".example.org"
	domA := uid(A, 2)
	claimOf := func(ctx context.Context, tx pgx.Tx, host string) string {
		var c *string
		if err := tx.QueryRow(ctx, `SELECT tenant_id || '/' || domain_id FROM scf.host_claims WHERE host = $1`, host).Scan(&c); err != nil && err != pgx.ErrNoRows {
			t.Fatal(sqlState(err))
		}
		if c == nil {
			return ""
		}
		return *c
	}
	scalar := func(ctx context.Context, tx pgx.Tx, sql string, args ...any) string {
		var s *string
		if err := tx.QueryRow(ctx, sql, args...).Scan(&s); err != nil && err != pgx.ErrNoRows {
			t.Fatal(sqlState(err))
		}
		if s == nil {
			return ""
		}
		return *s
	}
	immediate := func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SET CONSTRAINTS ALL IMMEDIATE`)
		return err
	}
	// a second site of A that declares the same host, verified
	site2, dom2 := uid(A, 701), uid(A, 702)
	second := `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
	    VALUES ('` + A + `', '` + site2 + `', 'second', 'c1secondsitec1secondsi', gen_random_uuid(), 'on', '` + users[A] + `');
	  INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state, verified_at)
	    VALUES ('` + A + `', '` + dom2 + `', '` + site2 + `', '` + hostA + `', 'verified', now());`
	jobCtx := Ctx{Tenant: A, Kind: "job", Actor: "domain_verification", Job: "domain_verification"}
	lapse := `UPDATE scf.site_domains SET state = 'lapsed', lapsed_at = now() WHERE tenant_id = $1 AND domain_id = $2`

	t.Run("a lapsed domain releases its claim", func(t *testing.T) {
		err := asRoleInTx(t, "", "scf_jobs", jobCtx, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, lapse, A, domA); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if c := claimOf(ctx, tx, hostA); c != "" {
				t.Errorf("claim after lapse: %s", c)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("a lapsed domain hands the claim to the tenant's other verified declaration", func(t *testing.T) {
		err := asRoleInTx(t, second, "scf_jobs", jobCtx, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, lapse, A, domA); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if c := claimOf(ctx, tx, hostA); c != A+"/"+dom2 {
				t.Errorf("claim after lapse: %q, want %s/%s", c, A, dom2)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("removing a domain lapses its evidence", func(t *testing.T) {
		for _, c := range []struct {
			setup, want string
		}{{"", "lapsed"}, {second, "valid"}} {
			err := asRoleInTx(t, c.setup, "scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, `SELECT scf.release_domain_claim($1, $2)`, A, domA); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2`, A, domA); err != nil {
					return err
				}
				if s := scalar(ctx, tx, `SELECT status::text FROM scf.verification_evidence WHERE evidence_id = $1`, uid(A, 5)); s != c.want {
					t.Errorf("evidence after removal (second verified declaration: %v): %q, want %s", c.setup != "", s, c.want)
				}
				return immediate(ctx, tx)
			})
			if err != nil {
				t.Error(sqlState(err))
			}
		}
	})
	t.Run("a host never has two verified owners", func(t *testing.T) {
		bDom := uid(B, 703)
		bRow := func(state string) string {
			return `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state) VALUES ('` + B + `', '` + bDom + `', '` +
				uid(B, 1) + `', '` + hostA + `', '` + state + `');`
		}
		for _, c := range []struct{ name, stmts, want string }{
			{"B verifies A's claimed host", bRow("verified"), "23514"},
			{"B's row turned verified later", bRow("unverified") + `UPDATE scf.site_domains SET state = 'verified' WHERE domain_id = '` + bDom + `';`, "23514"},
			{"the claim moves to B while A is verified", bRow("unverified") +
				`UPDATE scf.host_claims SET tenant_id = '` + B + `', domain_id = '` + bDom + `' WHERE host = '` + hostA + `';`, "23514"},
			{"the claim moves to B with A unverified", bRow("unverified") +
				`UPDATE scf.site_domains SET state = 'unverified' WHERE domain_id = '` + domA + `';
				 UPDATE scf.host_claims SET tenant_id = '` + B + `', domain_id = '` + bDom + `' WHERE host = '` + hostA + `';`, ""},
			{"a verified domain on an unclaimed host is claimed for its tenant",
				`INSERT INTO scf.site_domains (tenant_id, site_id, host, state) VALUES ('` + A + `', '` + uid(A, 1) + `', 'free-c1.example.org', 'verified');`, ""},
			{"a claim deleted under a verified domain comes back", `DELETE FROM scf.host_claims WHERE host = '` + hostA + `';`, ""},
		} {
			t.Run(c.name, func(t *testing.T) {
				err := tryIn(t, c.stmts, `SET CONSTRAINTS ALL IMMEDIATE`)
				if code(err) != c.want || (c.want == "" && err != nil) {
					t.Errorf("want %q, got %q", c.want, sqlState(err))
				}
			})
		}
		// the auto-claims above, checked
		err := inCtxSuper(t, super(t), func(ctx context.Context, tx pgx.Tx) error {
			mustTx(t, tx, `INSERT INTO scf.site_domains (tenant_id, site_id, host, state) VALUES ($1, $2, 'free-c1.example.org', 'verified')`, A, uid(A, 1))
			mustTx(t, tx, `DELETE FROM scf.host_claims WHERE host = $1`, hostA)
			if err := immediate(ctx, tx); err != nil {
				return err
			}
			if c := claimOf(ctx, tx, "free-c1.example.org"); !strings.HasPrefix(c, A+"/") {
				t.Errorf("unclaimed verified host: claim %q", c)
			}
			if c := claimOf(ctx, tx, hostA); !strings.HasPrefix(c, A+"/") {
				t.Errorf("deleted claim under a verified domain: claim %q", c)
			}
			return nil
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("operator keeps the newcomer: the host moves", func(t *testing.T) {
		bDom := uid(B, 704)
		setup := `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state) VALUES ('` + B + `', '` + bDom + `', '` +
			uid(B, 1) + `', '` + hostA + `', 'disputed');`
		err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'keep')`, B, bDom); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if c := claimOf(ctx, tx, hostA); c != B+"/"+bDom {
				t.Errorf("claim after keep: %q", c)
			}
			for q, want := range map[string]string{
				`SELECT state FROM scf.site_domains WHERE domain_id = '` + bDom + `'`:                                                                "verified",
				`SELECT state FROM scf.site_domains WHERE domain_id = '` + domA + `'`:                                                                "unverified",
				`SELECT status::text FROM scf.verification_evidence WHERE evidence_id = '` + uid(A, 5) + `'`:                                         "lapsed",
				`SELECT status::text FROM scf.verification_evidence WHERE tenant_id = '` + B + `' AND kind = 'domain' AND subject = '` + hostA + `'`: "valid",
			} {
				if got := scalar(ctx, tx, q); got != want {
					t.Errorf("%s: %q, want %q", q, got, want)
				}
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("claim_host: a second tenant proving a held host puts both in dispute", func(t *testing.T) {
		bDom := uid(B, 705)
		setup := `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host) VALUES ('` + B + `', '` + bDom + `', '` +
			uid(B, 1) + `', '` + hostA + `');`
		bJob := Ctx{Tenant: B, Kind: "job", Actor: "domain_verification", Job: "domain_verification"}
		err := asRoleInTx(t, setup, "scf_jobs", bJob, func(ctx context.Context, tx pgx.Tx) error {
			if r := scalar(ctx, tx, `SELECT scf.claim_host($1, $2, $3)`, hostA, B, bDom); r != "disputed" {
				t.Errorf("claim_host for B: %q, want disputed", r)
			}
			mustTx(t, tx, `RESET ROLE`)
			if st := scalar(ctx, tx, `SELECT state FROM scf.site_domains WHERE domain_id = $1`, domA); st != "disputed" {
				t.Errorf("holder's declaration: %q, want disputed", st)
			}
			if c := claimOf(ctx, tx, hostA); c != A+"/"+domA {
				t.Errorf("claim: %q (the holder keeps it until an operator decides)", c)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("claim_host: a claim whose holder no longer has the host verified is taken over", func(t *testing.T) {
		bDom := uid(B, 706)
		// the state a release before 0069 could leave: A's declaration lapsed, A still holding the claim
		setup := `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host) VALUES ('` + B + `', '` + bDom + `', '` +
			uid(B, 1) + `', '` + hostA + `');
		  UPDATE scf.site_domains SET state = 'lapsed', lapsed_at = now() WHERE domain_id = '` + domA + `';
		  INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES ('` + hostA + `', '` + A + `', '` + domA + `');`
		bJob := Ctx{Tenant: B, Kind: "job", Actor: "domain_verification", Job: "domain_verification"}
		err := asRoleInTx(t, setup, "scf_jobs", bJob, func(ctx context.Context, tx pgx.Tx) error {
			if r := scalar(ctx, tx, `SELECT scf.claim_host($1, $2, $3)`, hostA, B, bDom); r != "claimed" {
				t.Errorf("claim_host for B: %q, want claimed", r)
			}
			if _, err := tx.Exec(ctx, `UPDATE scf.site_domains SET state = 'verified', verified_at = now() WHERE domain_id = $1`, bDom); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if c := claimOf(ctx, tx, hostA); c != B+"/"+bDom {
				t.Errorf("claim: %q, want %s/%s", c, B, bDom)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("operator releases the challenger: the holder is verified again", func(t *testing.T) {
		bDom := uid(B, 707)
		setup := `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state) VALUES ('` + B + `', '` + bDom + `', '` +
			uid(B, 1) + `', '` + hostA + `', 'disputed');
		  UPDATE scf.site_domains SET state = 'disputed' WHERE domain_id = '` + domA + `';`
		err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'release')`, B, bDom); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			for d, want := range map[string]string{domA: "verified", bDom: "unverified"} {
				if st := scalar(ctx, tx, `SELECT state FROM scf.site_domains WHERE domain_id = $1`, d); st != want {
					t.Errorf("%s: %q, want %q", d, st, want)
				}
			}
			if c := claimOf(ctx, tx, hostA); c != A+"/"+domA {
				t.Errorf("claim: %q", c)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("operator keeps the challenger: the holder's checks end, the kept domain is re-checked", func(t *testing.T) {
		bDom, bVer := uid(B, 708), uid(B, 709)
		setup := `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host, state) VALUES ('` + B + `', '` + bDom + `', '` +
			uid(B, 1) + `', '` + hostA + `', 'disputed');
		  INSERT INTO scf.domain_verifications (tenant_id, verification_id, domain_id, method, token, status, expires_at, last_result_code)
		    VALUES ('` + B + `', '` + bVer + `', '` + bDom + `', 'dns_txt', '` + alnum(B, 7, 22) + `', 'failed', now() + interval '7 days', 'HOST_CLAIMED_ELSEWHERE');
		  UPDATE scf.domain_verifications SET next_check_at = now() + interval '1 day' WHERE verification_id = '` + uid(A, 4) + `';`
		err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'keep')`, B, bDom); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if v := scalar(ctx, tx, `SELECT status || '/' || COALESCE(next_check_at::text, '-') FROM scf.domain_verifications WHERE verification_id = $1`, uid(A, 4)); v != "failed/-" {
				t.Errorf("holder's verification after keep: %q, want failed/-", v)
			}
			if v := scalar(ctx, tx, `SELECT status || '/' || (next_check_at IS NOT NULL)::text FROM scf.domain_verifications WHERE verification_id = $1`, bVer); v != "verified/true" {
				t.Errorf("kept domain's verification: %q, want verified/true", v)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
	t.Run("operator releases the holder: the claim goes", func(t *testing.T) {
		setup := `UPDATE scf.site_domains SET state = 'disputed' WHERE domain_id = '` + domA + `';`
		err := asRoleInTx(t, setup, "scf_app", operatorCtx(true), func(ctx context.Context, tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT scf.op_resolve_domain_dispute($1, $2, 'release')`, A, domA); err != nil {
				return err
			}
			mustTx(t, tx, `RESET ROLE`)
			if c := claimOf(ctx, tx, hostA); c != "" {
				t.Errorf("claim after release: %q", c)
			}
			if s := scalar(ctx, tx, `SELECT status::text FROM scf.verification_evidence WHERE evidence_id = $1`, uid(A, 5)); s != "lapsed" {
				t.Errorf("A's evidence after release: %q", s)
			}
			return immediate(ctx, tx)
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	})
}

// Finding 8a: every privilege, column privilege, function EXECUTE grant and policy of the platform roles in schemas
// scf and scf_admin, compared with a reviewed golden file. A migration that widens anything — a grant on a global
// table, a policy's role list or expression — is a visible diff. Regenerate after a REVIEWED change:
//
//	go test -count=1 -run TestPrivilegeSnapshot -update-privileges ./...
var updatePrivileges = flag.Bool("update-privileges", false, "rewrite testdata/privileges.golden from the migrated database")

const privilegeSnapshotSQL = `
WITH roles AS (SELECT oid, rolname::text AS rolname FROM pg_roles
                WHERE rolname IN ('scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro', 'scf_definer', 'scf_op_definer', 'scf_audit_definer')),
rels AS (SELECT c.oid, c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('scf', 'scf_admin') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND NOT c.relispartition)
SELECT 'schema ' || n.nspname || ' ' || r.rolname || ' ' || a.privilege_type
  FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN roles r ON r.oid = a.grantee
 WHERE n.nspname IN ('scf', 'scf_admin', 'scf_part')
UNION ALL
SELECT 'table ' || c.oid::regclass || ' ' || r.rolname || ' ' || a.privilege_type
  FROM rels c CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN roles r ON r.oid = a.grantee
UNION ALL
SELECT 'column ' || c.oid::regclass || '.' || t.attname || ' ' || r.rolname || ' ' || a.privilege_type
  FROM rels c JOIN pg_attribute t ON t.attrelid = c.oid AND t.attnum > 0 AND NOT t.attisdropped
 CROSS JOIN LATERAL aclexplode(t.attacl) a JOIN roles r ON r.oid = a.grantee
UNION ALL
SELECT 'function ' || p.oid::regprocedure || ' ' || COALESCE(r.rolname, 'PUBLIC') || ' EXECUTE'
         || CASE WHEN p.prosecdef THEN ' (definer, owner ' || pg_get_userbyid(p.proowner) || ')' ELSE '' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN roles r ON r.oid = a.grantee
 WHERE n.nspname IN ('scf', 'scf_admin') AND (r.oid IS NOT NULL OR a.grantee = 0)
UNION ALL
SELECT 'policy ' || c.oid::regclass || ' ' || p.polname || ' ' || CASE WHEN p.polpermissive THEN 'permissive' ELSE 'RESTRICTIVE' END
         || ' ' || p.polcmd::text || ' {' || (SELECT string_agg(x.r, ',' ORDER BY x.r) FROM (SELECT CASE WHEN o = 0 THEN 'PUBLIC'
                                          ELSE pg_get_userbyid(o)::text END AS r FROM unnest(p.polroles) o) x) || '}'
         || COALESCE(' USING ' || regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\s+', ' ', 'g'), '')
         || COALESCE(' CHECK ' || regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\s+', ' ', 'g'), '')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('scf', 'scf_admin') AND NOT c.relispartition
ORDER BY 1`

func TestPrivilegeSnapshot(t *testing.T) {
	rows, err := queryStrings(context.Background(), super(t), privilegeSnapshotSQL)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	got := strings.Join(rows, "\n") + "\n"
	path := filepath.Join(testDir, "testdata", "privileges.golden")
	if *updatePrivileges {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s (%d lines): review the diff before committing", path, len(rows))
		return
	}
	want := readFile(t, path)
	if got == want {
		return
	}
	wantSet := map[string]bool{}
	for _, l := range strings.Split(strings.TrimSpace(want), "\n") {
		wantSet[l] = true
	}
	gotSet := map[string]bool{}
	for _, l := range rows {
		gotSet[l] = true
		if !wantSet[l] {
			t.Errorf("privilege not in the reviewed snapshot (widened?): %s", l)
		}
	}
	for l := range wantSet {
		if !gotSet[l] {
			t.Errorf("privilege in the snapshot but not in the database: %s", l)
		}
	}
	t.Log("if the change is reviewed and intended: go test -count=1 -run TestPrivilegeSnapshot -update-privileges ./...")
}

// The snapshot catches the audit's example (a new grant on a global table) and a widened policy role list.
func TestPrivilegeSnapshotCatchesWidening(t *testing.T) {
	want := readFile(t, filepath.Join(testDir, "testdata", "privileges.golden"))
	for _, ddl := range []string{
		`GRANT UPDATE ON scf.seal_days TO scf_app`,
		`GRANT UPDATE (name) ON scf.registry_projects TO scf_app`,
		`ALTER POLICY jobs_delete ON scf.registry_projects TO scf_jobs, scf_app`,
		`GRANT EXECUTE ON FUNCTION scf.claim_host(text, uuid, uuid) TO scf_app`,
	} {
		err := inCtxSuper(t, super(t), func(ctx context.Context, tx pgx.Tx) error {
			mustTx(t, tx, ddl)
			rows, err := queryStrings(ctx, tx, privilegeSnapshotSQL)
			if err != nil {
				return err
			}
			if strings.Join(rows, "\n")+"\n" == want {
				t.Errorf("snapshot unchanged after %q", ddl)
			}
			return nil
		})
		if err != nil {
			t.Error(sqlState(err))
		}
	}
}
