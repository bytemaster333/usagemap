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

// Migrations 0063–0066 (C-136; docs/data-model.md §8.4, §8.5, §8.6, §8.9, §8.13, §11, §12):
// dev origins and debug mode, the dev-event buffer, the Stellar event property rollup, registry categories and
// op_cohorts, snapshot v2 columns and the append-only guard, the daily seal tables and public proof functions, the
// Registered Footprint and op_footprint. The cross-tenant matrix covers the new tenant tables from the catalog.

// tryIn runs stmt in a savepoint of a rolled-back superuser transaction and returns its error.
func tryIn(t *testing.T, stmts ...string) error {
	t.Helper()
	ctx := context.Background()
	tx, err := super(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, s := range stmts {
		if _, err := tx.Exec(ctx, s); err != nil {
			return err
		}
	}
	return nil
}

func TestDevOrigins0063(t *testing.T) {
	site := uid(A, 1)
	set := func(origins string) error {
		return tryIn(t, fmt.Sprintf(`UPDATE scf.sites SET dev_origins = '%s' WHERE tenant_id = '%s' AND site_id = '%s'`,
			origins, A, site))
	}
	for _, ok := range []string{`{}`, `{localhost}`, `{localhost,127.0.0.1}`, `{myapp-*.vercel.app,*-team.example.org}`,
		`{preview.example.org,*.preview.example.org}`} {
		if err := set(ok); err != nil {
			t.Errorf("dev_origins %s refused: %s", ok, sqlState(err))
		}
	}
	for _, bad := range []string{`{http://localhost:3000}`, `{localhost:3000}`, `{Example.org}`, `{*}`, `{a.*.example.org}`,
		`{"bad host.org"}`, `{a.org,b.org,c.org,d.org,e.org,f.org,g.org,h.org,i.org,j.org,k.org}`,
		// C-137: an element with a space, a NULL element and an empty element are refused (each would defeat the limit)
		`{"a.org b.org"}`, `{a.org,NULL}`, `{a.org,""}`} {
		if err := set(bad); code(err) != "23514" {
			t.Errorf("dev_origins %s: want 23514, got %q", bad, sqlState(err))
		}
	}
	// C-137: the counter-record capability setting accepts only a subset of ["props","dev"]
	for _, ok := range []string{`'["props", "dev"]'`, `'["props"]'`, `'[]'`} {
		if err := tryIn(t, `UPDATE scf.settings SET value = `+ok+` WHERE key = 'edge_counter_features'`); err != nil {
			t.Errorf("edge_counter_features %s refused: %s", ok, sqlState(err))
		}
	}
	for _, bad := range []string{`'["props", "x"]'`, `'"props"'`, `'{"props": true}'`} {
		if err := tryIn(t, `UPDATE scf.settings SET value = `+bad+` WHERE key = 'edge_counter_features'`); code(err) != "23514" {
			t.Errorf("edge_counter_features %s: want 23514, got %q", bad, sqlState(err))
		}
	}
	// the tenant (scf_app) may write both columns; multiplicity_mode stays operator-only (0061)
	app := runtimeConn(t, "scf_app")
	owner := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE scf.sites SET dev_origins = '{localhost}', debug_until = now() + interval '1 hour'
		    WHERE site_id = $1`, site)
		if err == nil && tag.RowsAffected() != 1 {
			return fmt.Errorf("%d rows", tag.RowsAffected())
		}
		return err
	}); err != nil {
		t.Errorf("scf_app updating dev_origins/debug_until: %s", sqlState(err))
	}
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.sites SET multiplicity_mode = 'shadow' WHERE site_id = $1`, site)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app updating multiplicity_mode: want 42501, got %q", sqlState(err))
	}
}

func TestDevEventBuffer0063(t *testing.T) {
	site := uid(A, 1)
	app := runtimeConn(t, "scf_app")
	system := Ctx{Tenant: A, Kind: "system", Actor: "edge"}
	// the counter endpoint inserts and trims under the tenant's context
	if err := inCtx(t, app, system, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class,
		    would_be_verdict) VALUES ($1, $2, now(), 'pageview', 'pageview', '/{id}', 'verified')`, A, site); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM scf.web_dev_events WHERE tenant_id = $1 AND site_id = $2 AND event_id NOT IN
		    (SELECT event_id FROM scf.web_dev_events WHERE tenant_id = $1 AND site_id = $2 ORDER BY received_at DESC
		      LIMIT scf.setting_int('dev_event_buffer_size'))`, A, site)
		return err
	}); err != nil {
		t.Errorf("insert + trim as the counter endpoint: %s", sqlState(err))
	}
	for _, bad := range []string{
		`INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
		   VALUES ('` + A + `', '` + site + `', now(), 'pageview', 'pageview', '/a?q=1', 'verified')`,
		`INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
		   VALUES ('` + A + `', '` + site + `', now(), 'pageview', 'pageview', '/a', 'dev')`,
		`INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
		   VALUES ('` + A + `', '` + site + `', now(), 'wallet', 'pageview', '/a', 'verified')`,
	} {
		if err := tryIn(t, bad); code(err) != "23514" {
			t.Errorf("want 23514 for %s, got %q", firstLine(bad), sqlState(err))
		}
	}
	// retention: rows older than 24 hours go, per tenant, for job retention only
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE scf.web_dev_events SET received_at = received_at`); err == nil {
			return fmt.Errorf("retention may not update dev events")
		}
		return nil
	}); err != nil {
		t.Error(err)
	}
	ctx := context.Background()
	su := super(t)
	mustExec(t, su, `INSERT INTO scf.web_dev_events (tenant_id, site_id, received_at, kind, event_name, path_class, would_be_verdict)
	    VALUES ($1, $2, now() - interval '25 hours', 'custom', 'signup', '/', 'suspect')`, A, site)
	var n int64
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT scf.retention_apply('web_dev_events')`).Scan(&n)
	}); err != nil || n != 1 {
		t.Errorf("retention_apply(web_dev_events): n=%d err=%s", n, sqlState(err))
	}
	t.Cleanup(func() {
		_, _ = su.Exec(ctx, `DELETE FROM scf.web_dev_events WHERE received_at < now() - interval '24 hours'`)
	})
}

func TestEventPropertyRollup0063(t *testing.T) {
	site := uid(A, 1)
	ins := func(event, network, key, value, verdict string) error {
		return tryIn(t, fmt.Sprintf(`INSERT INTO scf.web_event_property_daily VALUES ('%s', '%s', (now() AT TIME ZONE 'UTC')::date,
		  '%s', '%s', '%s', '%s', '%s', 1)`, A, site, event, network, key, value, verdict))
	}
	for _, ok := range [][5]string{
		{"sign_rejected", "testnet", "error_class", "user_rejected", "suspect"},
		{"tx_submitted", "mainnet", "result_class", "try_again_later", "verified"},
		{"passkey_used", "unknown", "passkey_op", "sign", "verified"},
		{"wallet_connect", "local", "connect_kind", "restored", "verified"},
	} {
		if err := ins(ok[0], ok[1], ok[2], ok[3], ok[4]); err != nil {
			t.Errorf("%v refused: %s", ok, sqlState(err))
		}
	}
	for _, bad := range [][5]string{
		{"wallet_connect", "mainnet", "wallet", "varial", "verified"}, // kit id must be mapped to freighter
		{"wallet_connect", "public", "_total", "all", "verified"},     // legacy network name
		{"wallet_connect", "mainnet", "address", "G", "verified"},     // no free property keys
		{"wallet_connect", "mainnet", "_total", "all", "rejected"},    // rejected never counted
		{"wallet_connect", "mainnet", "_total", "all", "dev"},         // dev never counted
		{"wallet_connected", "mainnet", "_total", "all", "verified"},  // legacy event name
	} {
		if err := ins(bad[0], bad[1], bad[2], bad[3], bad[4]); code(err) != "23514" {
			t.Errorf("%v: want 23514, got %q", bad, sqlState(err))
		}
	}
	// the counter endpoint upserts under the tenant's context
	app := runtimeConn(t, "scf_app")
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "system", Actor: "edge"}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.web_event_property_daily VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date,
		    'wallet_connect', 'mainnet', '_total', 'all', 'verified', 2)
		    ON CONFLICT (tenant_id, site_id, day, event_name, network, prop_key, prop_value, verdict)
		    DO UPDATE SET count = scf.web_event_property_daily.count + EXCLUDED.count`, A, site)
		return err
	}); err != nil {
		t.Errorf("upsert as the counter endpoint: %s", sqlState(err))
	}
}

func TestCohorts0064(t *testing.T) {
	ctx := context.Background()
	su := super(t)
	d0, today, _ := days(t)
	if err := tryIn(t, `UPDATE scf.registry_projects SET scf_categories = '{financial_protocols,games}'`); code(err) != "23514" {
		t.Errorf("unknown category: want 23514, got %q", sqlState(err))
	}
	if err := tryIn(t, `UPDATE scf.registry_projects SET award_stage = 'mainnet'`); code(err) != "23514" {
		t.Errorf("unknown award stage: want 23514, got %q", sqlState(err))
	}
	mustExec(t, su, `UPDATE scf.registry_projects SET scf_categories = '{financial_protocols,developer_tooling}',
	    award_round = 35, award_stage = 't2_testnet' WHERE registry_project_id = $1`, reg)
	mustExec(t, su, `UPDATE scf.tenant_registry_links SET status = 'confirmed' WHERE registry_project_id = $1`, reg)
	t.Cleanup(func() {
		_, _ = su.Exec(ctx, `UPDATE scf.tenant_registry_links SET status = 'candidate' WHERE registry_project_id = $1`, reg)
		_, _ = su.Exec(ctx, `UPDATE scf.registry_projects SET scf_categories = '{}', award_round = NULL, award_stage = NULL
		    WHERE registry_project_id = $1`, reg)
		_, _ = su.Exec(ctx, `UPDATE scf.settings SET value = '5' WHERE key = 'cohort_min_tenants'`)
	})
	app := opCall{"scf_app", operatorCtx(true)}
	q := `SELECT cohort, tenant_count, pageviews_verified, suppressed FROM scf.op_cohorts($1, $2, $3)`

	// A and B (canary C never) are two tenants: below the default floor of 5, so suppressed with no figures
	rows, au, err := callOp(t, app, q, d0, today, "category")
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_cohorts")
	got := map[string]string{}
	for _, r := range rows {
		got[str(r[0])] = fmt.Sprintf("%s/%s/%v", str(r[1]), str(r[2]), r[3])
	}
	want := map[string]string{"developer_tooling": "<nil>/<nil>/true", "financial_protocols": "<nil>/<nil>/true"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("suppressed cohorts: got %v, want %v", got, want)
	}
	// floor 2: the cohort is shown, figures are exact sums over A and B (7 verified page views each, seed)
	mustExec(t, su, `UPDATE scf.settings SET value = '2' WHERE key = 'cohort_min_tenants'`)
	for _, by := range []string{"round", "award_stage", "category"} {
		rows, _, err := callOp(t, app, q, d0, today, by)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		for _, r := range rows {
			if str(r[1]) != "2" || str(r[2]) != "14" || r[3] != false {
				t.Errorf("by %s: row %v", by, r)
			}
		}
		if len(rows) == 0 {
			t.Errorf("by %s: no cohort", by)
		}
	}
	if err := tryIn(t, `UPDATE scf.settings SET value = '1' WHERE key = 'cohort_min_tenants'`); code(err) != "23514" {
		t.Errorf("cohort_min_tenants 1: want 23514, got %q", sqlState(err))
	}
	// invalid grouping, and no operator context at all
	if _, _, err := callOp(t, app, q, d0, today, "name"); code(err) != "22023" {
		t.Errorf("by name: want 22023, got %q", sqlState(err))
	}
	if _, _, err := callOp(t, opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}}, q, d0, today, "round"); code(err) != "42501" {
		t.Errorf("tenant user: want 42501, got %q", sqlState(err))
	}
	if _, au, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("web:read")}, q, d0, today, "round"); err != nil {
		t.Errorf("machine key: %s", sqlState(err))
	} else {
		oneAudit(t, au, "operator.read.op_cohorts")
	}
	if _, _, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("api:read")}, q, d0, today, "round"); code(err) != "42501" {
		t.Errorf("key without web:read: want 42501, got %q", sqlState(err))
	}
}

func TestSnapshotV2AndSeal0065(t *testing.T) {
	ctx := context.Background()
	snapA := uid(A, 10)
	// v2 needs a preset; v1 has none (checked on a pending request: a signed row's columns never change, C-137)
	pendingRow := fmt.Sprintf(`INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end)
	    VALUES ('%s', '%s', '%s', '2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z')`, A, uid(A, 303), users[A])
	for _, bad := range []string{
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET schema_version = 2 WHERE snapshot_id = '%s'`, uid(A, 303)),
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET preset = 'custom' WHERE snapshot_id = '%s'`, uid(A, 303)),
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET schema_version = 3 WHERE snapshot_id = '%s'`, uid(A, 303)),
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET schema_version = 4, preset = 'custom' WHERE snapshot_id = '%s'`, uid(A, 303)),
	} {
		if err := tryIn(t, pendingRow, bad); code(err) != "23514" {
			t.Errorf("%s: want 23514, got %q", bad, sqlState(err))
		}
	}
	// v3 (0078, the SCF Evidence Link) is accepted with a preset
	if err := tryIn(t, pendingRow, fmt.Sprintf(`UPDATE scf.traction_snapshots SET schema_version = 3, preset = 'custom' WHERE snapshot_id = '%s'`, uid(A, 303))); err != nil {
		t.Errorf("schema v3 with a preset: %v", err)
	}
	// append-only after signing: the document never changes; a revocation is final (even for the superuser)
	if err := tryIn(t, fmt.Sprintf(`UPDATE scf.traction_snapshots SET document = '{"x":1}' WHERE snapshot_id = '%s'`, snapA)); code(err) != "42501" {
		t.Errorf("changing a signed document: want 42501, got %q", sqlState(err))
	}
	if err := tryIn(t,
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET revoked_at = now(), revoked_reason = 'x' WHERE snapshot_id = '%s'`, snapA),
		fmt.Sprintf(`UPDATE scf.traction_snapshots SET revoked_at = NULL, revoked_reason = NULL WHERE snapshot_id = '%s'`, snapA)); code(err) != "42501" {
		t.Errorf("un-revoking: want 42501, got %q", sqlState(err))
	}
	// the control plane may insert a v2 request with its preset (request columns only)
	app := runtimeConn(t, "scf_app")
	owner := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end,
		    include_api, schema_version, preset) VALUES ($1, $2, $3, '2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z', true, 2,
		    'pg_renewal_quarter')`, A, uid(A, 300), users[A])
		return err
	}); err != nil {
		t.Errorf("v2 request insert: %s", sqlState(err))
	}
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end,
		    signed_at) VALUES ($1, $2, $3, '2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z', now())`, A, uid(A, 301), users[A])
		return err
	}); code(err) != "42501" {
		t.Errorf("control plane setting signed_at: want 42501, got %q", sqlState(err))
	}

	// public list and proof (scf_definer functions, executable by scf_app)
	anon := Ctx{Kind: "anonymous"}
	var list []string
	if err := inCtx(t, app, anon, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		list, err = queryStrings(ctx, tx, `SELECT snapshot_id, schema_version, status FROM scf.public_snapshot_list('tenant-a')`)
		return err
	}); err != nil || len(list) != 1 || !strings.Contains(list[0], "| 1 | valid") {
		t.Errorf("public_snapshot_list(tenant-a): %v %s", list, sqlState(err))
	}
	var proof []byte
	if err := inCtx(t, app, anon, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT scf.public_seal_proof($1)::text`, snapA).Scan(&proof)
	}); err != nil {
		t.Fatalf("public_seal_proof: %s", sqlState(err))
	}
	var proofs []map[string]any
	if err := json.Unmarshal(proof, &proofs); err != nil || len(proofs) != 1 {
		t.Fatalf("proof %s: %v", proof, err)
	}
	for _, k := range []string{"salt", "leaf_hash", "audit_path", "head_path", "segment", "root", "prev_root", "network",
		"status", "snapshot_sha256"} {
		if _, ok := proofs[0][k]; !ok {
			t.Errorf("proof lacks %s: %s", k, proof)
		}
	}
	if proofs[0]["network"] != "testnet" || proofs[0]["status"] != "built" {
		t.Errorf("proof: %s", proof)
	}
	var none *string
	if err := inCtx(t, app, anon, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT scf.public_seal_proof($1)::text`, uid(A, 999)).Scan(&none)
	}); err != nil || none != nil {
		t.Errorf("proof of an unknown snapshot: %v %s", none, sqlState(err))
	}
	// the leaves themselves are not readable by the app outside the tenant, nor writable by it
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash, audit_path)
		    VALUES ($1, $2, 'mainnet', current_date, 9, decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'),
		    ARRAY[decode(repeat('03', 32), 'hex')])`, A, snapA)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app inserting a leaf: want 42501, got %q", sqlState(err))
	}

	// seal days: public read; written only by job daily_seal; the tree never changes once built
	jobs := runtimeConn(t, "scf_jobs")
	seal := Ctx{Kind: "job", Actor: "daily_seal", Job: "daily_seal"}
	if err := inCtx(t, jobs, seal, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE scf.seal_days SET status = 'confirmed', source_account = $1,
		    tx_hash = decode(repeat('aa', 32), 'hex'), ledger = 123, submitted_at = now(), confirmed_at = now()
		    WHERE network = 'testnet'`, "G"+strings.Repeat("A", 55)); err != nil {
			return err
		}
		// the job reads signed snapshots of every tenant (cross-tenant read, tenant unset)
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.traction_snapshots WHERE signature IS NOT NULL`).Scan(&n); err != nil {
			return err
		}
		if n != 3 {
			return fmt.Errorf("daily_seal sees %d signed snapshots, want 3", n)
		}
		return nil
	}); err != nil {
		t.Errorf("daily_seal: %s", sqlState(err))
	}
	if err := inCtx(t, jobs, seal, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.seal_days SET root = decode(repeat('bb', 32), 'hex')`)
		return err
	}); code(err) != "42501" {
		t.Errorf("rewriting a root: want 42501, got %q", sqlState(err))
	}
	for _, j := range []string{"retention", "public_metrics"} {
		if err := inCtx(t, jobs, Ctx{Kind: "job", Actor: j, Job: j}, func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `UPDATE scf.seal_days SET last_checked_at = now()`)
			if err == nil && tag.RowsAffected() > 0 {
				return fmt.Errorf("job %s updated %d seal days", j, tag.RowsAffected())
			}
			return nil
		}); err != nil {
			t.Error(err)
		}
	}
	var days int
	if err := inCtx(t, app, anon, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM scf.seal_days`).Scan(&days)
	}); err != nil || days != 1 {
		t.Errorf("anonymous read of seal_days: %d %s", days, sqlState(err))
	}

	// public_metrics (which signs v2) reads on-chain counts and annotations of the tenant it works for
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "public_metrics", Job: "public_metrics"}, func(ctx context.Context, tx pgx.Tx) error {
		for _, rel := range []string{"onchain_daily", "trust_annotations", "declared_contracts", "web_event_property_daily"} {
			var n int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.`+rel).Scan(&n); err != nil {
				return fmt.Errorf("%s: %s", rel, sqlState(err))
			}
			if n == 0 {
				return fmt.Errorf("%s: no rows visible", rel)
			}
		}
		return nil
	}); err != nil {
		t.Error(err)
	}
	_ = ctx
}

func TestFootprint0066(t *testing.T) {
	g := "G" + strings.Repeat("B", 55)
	ins := func(kind, subject, extra string) error {
		return tryIn(t, fmt.Sprintf(`INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, created_by%s)
		  VALUES ('%s', '%s', '%s', 'mainnet', '%s'%s)`, colsOf(extra), A, kind, subject, users[A], valsOf(extra)))
	}
	if err := ins("app_account", g, ""); err != nil {
		t.Errorf("app_account: %s", sqlState(err))
	}
	if err := ins("wasm_hash", strings.Repeat("ab", 32), ""); err != nil {
		t.Errorf("wasm_hash: %s", sqlState(err))
	}
	for _, c := range []struct{ kind, subject, extra string }{
		{"contract", "C" + strings.Repeat("A", 55), ""},    // contracts live in declared_contracts
		{"app_account", "M" + strings.Repeat("A", 68), ""}, // muxed accounts never
		{"wasm_hash", strings.Repeat("AB", 32), ""},        // lower-case hex only
		{"wasm_hash", g, ""},                               // a wasm hash is not an account
		{"app_account", g, "status=verified"},              // verified needs method and time
		{"app_account", g, "status=rejected"},              // rejected needs a reason
		{"wasm_hash", strings.Repeat("ab", 32), "status=verified,verification_method=signed_challenge,verified_at=now()"},
		{"app_account", g, "status=verified,verification_method=deployer_admin_match,verified_at=now()"},
	} {
		if err := ins(c.kind, c.subject, c.extra); code(err) != "23514" {
			t.Errorf("%s %s %s: want 23514, got %q", c.kind, c.subject[:8], c.extra, sqlState(err))
		}
	}
	if err := ins("issuing_account", g, "status=verified,verification_method=sep1_accounts,verified_at=now()"); err != nil {
		t.Errorf("verified by sep1_accounts: %s", sqlState(err))
	}
	// declared_contracts: rejected with a reason
	if err := tryIn(t, fmt.Sprintf(`UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'not_deployer_or_admin'
	    WHERE tenant_id = '%s'`, A)); err != nil {
		t.Errorf("contract rejected: %s", sqlState(err))
	}
	if err := tryIn(t, fmt.Sprintf(`UPDATE scf.declared_contracts SET status = 'rejected' WHERE tenant_id = '%s'`, A)); code(err) != "23514" {
		t.Errorf("contract rejected without reason: want 23514, got %q", sqlState(err))
	}
	// the tenant toggles the "no footprint" declaration and seal opt-in; lifecycle columns stay closed (G3)
	app := runtimeConn(t, "scf_app")
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE scf.tenants SET footprint_none_declared = true, seal_enabled = true WHERE tenant_id = $1`, A)
		return err
	}); err != nil {
		t.Errorf("scf_app updating footprint_none_declared/seal_enabled: %s", sqlState(err))
	}

	// op_footprint: one list, contracts shown as claimed, canary C only when named, audited once
	op := opCall{"scf_app", operatorCtx(false)}
	rows, au, err := callOp(t, op, `SELECT tenant_id, kind, status FROM scf.op_footprint()`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	oneAudit(t, au, "operator.read.op_footprint")
	var got []string
	for _, r := range rows {
		got = append(got, fmt.Sprintf("%s/%s/%s", str(r[0])[:2], str(r[1]), str(r[2])))
	}
	slices.Sort(got)
	want := []string{"aa/contract/claimed", "aa/issuing_account/claimed", "bb/contract/claimed", "bb/issuing_account/claimed"}
	if !slices.Equal(got, want) {
		t.Errorf("op_footprint(): got %v, want %v", got, want)
	}
	rows, _, err = callOp(t, op, `SELECT tenant_id FROM scf.op_footprint($1::uuid[], 'claimed')`, []string{C})
	if err != nil || len(rows) != 2 {
		t.Errorf("op_footprint(C named): %d rows, %s", len(rows), sqlState(err))
	}
	if _, _, err := callOp(t, op, `SELECT * FROM scf.op_footprint(NULL, 'declared')`); code(err) != "22023" {
		t.Errorf("status declared: want 22023, got %q", sqlState(err))
	}
	if _, _, err := callOp(t, opCall{"scf_metrics_ro", keyCtx("web:read")}, `SELECT * FROM scf.op_footprint()`); code(err) != "42501" {
		t.Errorf("key without registry:read: want 42501, got %q", sqlState(err))
	}
	rows, _, err = callOp(t, opCall{"scf_metrics_ro", keyCtx("registry:read", B)}, `SELECT tenant_id FROM scf.op_footprint()`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	for _, r := range rows {
		if str(r[0]) != B {
			t.Errorf("key restricted to B saw %s", str(r[0]))
		}
	}
	// the job that verifies footprint items may update them; others may not
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "contract_verification", Job: "contract_verification"},
		func(ctx context.Context, tx pgx.Tx) error {
			tag, err := tx.Exec(ctx, `UPDATE scf.footprint_items SET status = 'rejected', rejected_reason = 'not_listed_in_toml',
			    last_checked_at = now()`)
			if err == nil && tag.RowsAffected() != 1 {
				return fmt.Errorf("%d rows", tag.RowsAffected())
			}
			return err
		}); err != nil {
		t.Errorf("contract_verification rejecting an item: %s", sqlState(err))
	}
}

// colsOf / valsOf turn "a=x,b=y" into ", a, b" and ", 'x', y" (now() stays an expression).
func colsOf(extra string) string {
	if extra == "" {
		return ""
	}
	var cols []string
	for _, kv := range strings.Split(extra, ",") {
		cols = append(cols, strings.SplitN(kv, "=", 2)[0])
	}
	return ", " + strings.Join(cols, ", ")
}

func valsOf(extra string) string {
	if extra == "" {
		return ""
	}
	var vals []string
	for _, kv := range strings.Split(extra, ",") {
		v := strings.SplitN(kv, "=", 2)[1]
		if v != "now()" {
			v = "'" + v + "'"
		}
		vals = append(vals, v)
	}
	return ", " + strings.Join(vals, ", ")
}

// C-137 (architecture review 2026-11-16, findings 8 and 14): in a shown cohort every figure below op_min_count is
// withheld, the on-chain figures need cohort_min_tenants tenants with on-chain data, and a contract with an open
// footprint conflict is not summed.
func TestCohortFloor0064(t *testing.T) {
	ctx := context.Background()
	su := super(t)
	d0, today, _ := days(t)
	mustExec(t, su, `UPDATE scf.registry_projects SET award_round = 35 WHERE registry_project_id = $1`, reg)
	mustExec(t, su, `UPDATE scf.tenant_registry_links SET status = 'confirmed' WHERE registry_project_id = $1`, reg)
	mustExec(t, su, `UPDATE scf.settings SET value = '2' WHERE key = 'cohort_min_tenants'`)
	t.Cleanup(func() {
		_, _ = su.Exec(ctx, `UPDATE scf.tenant_registry_links SET status = 'candidate' WHERE registry_project_id = $1`, reg)
		_, _ = su.Exec(ctx, `UPDATE scf.registry_projects SET award_round = NULL WHERE registry_project_id = $1`, reg)
		_, _ = su.Exec(ctx, `UPDATE scf.settings SET value = '5' WHERE key = 'cohort_min_tenants'`)
		_, _ = su.Exec(ctx, `UPDATE scf.settings SET value = '10' WHERE key = 'op_min_count'`)
		_, _ = su.Exec(ctx, `UPDATE scf.declared_contracts SET status = 'declared', verified_role = NULL,
		    verified_by_evidence = NULL, verified_at = NULL, conflict_since = NULL WHERE tenant_id IN ($1, $2)`, A, B)
	})
	app := opCall{"scf_app", operatorCtx(true)}
	q := `SELECT tenant_count, pageviews_verified, tenants_with_onchain, onchain_invocations, suppressed
	        FROM scf.op_cohorts($1, $2, 'round')`
	one := func(label string) []any {
		t.Helper()
		rows, _, err := callOp(t, app, q, d0, today)
		if err != nil || len(rows) != 1 {
			t.Fatalf("%s: %d rows, %s", label, len(rows), sqlState(err))
		}
		return rows[0]
	}
	// seed: 7 verified page views per tenant (14), 3 invocations per tenant yesterday, contracts only declared
	mustExec(t, su, `UPDATE scf.settings SET value = '20' WHERE key = 'op_min_count'`)
	if r := one("floor 20"); str(r[0]) != "2" || r[1] != nil || r[4] != false {
		t.Errorf("figure below op_min_count must be NULL in a shown cohort: %v", r)
	}
	mustExec(t, su, `UPDATE scf.settings SET value = '5' WHERE key = 'op_min_count'`) // the lowest floor allowed (0070)
	if r := one("floor 5"); str(r[1]) != "14" || str(r[2]) != "0" || r[3] != nil {
		t.Errorf("no tenant with on-chain data: on-chain figures must be NULL: %v", r)
	}
	verify := func(ten string) {
		mustExec(t, su, `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'deployer',
		    verified_by_evidence = $2, verified_at = now() WHERE tenant_id = $1`, ten, uid(ten, 12))
	}
	verify(A)
	if r := one("one on-chain tenant"); str(r[2]) != "1" || r[3] != nil {
		t.Errorf("one tenant with on-chain data (< cohort_min_tenants): figures must be NULL: %v", r)
	}
	verify(B)
	if r := one("two on-chain tenants"); str(r[2]) != "2" || str(r[3]) != "6" {
		t.Errorf("two tenants with on-chain data: want 6 invocations, got %v", r)
	}
	mustExec(t, su, `UPDATE scf.declared_contracts SET conflict_since = now() WHERE tenant_id = $1`, A)
	if r := one("conflict"); str(r[2]) != "1" || r[3] != nil {
		t.Errorf("a contract in conflict is not summed: %v", r)
	}
	// the conflict flag exists only on verified items
	if err := tryIn(t, fmt.Sprintf(`UPDATE scf.declared_contracts SET status = 'declared', verified_role = NULL,
	    verified_by_evidence = NULL, verified_at = NULL WHERE tenant_id = '%s'`, A)); code(err) != "23514" {
		t.Errorf("conflict on a non-verified contract: want 23514, got %q", sqlState(err))
	}
}

// C-137 (finding 6, 10, 13): series numbers, signed_at, the extended guard and delete protection, and the list.
func TestSnapshotSeries0065(t *testing.T) {
	ctx := context.Background()
	su := super(t)
	snapA := uid(A, 10)
	var seq int
	var signedAt *time.Time
	if err := su.QueryRow(ctx, `SELECT series_seq, signed_at FROM scf.traction_snapshots WHERE snapshot_id = $1`, snapA).
		Scan(&seq, &signedAt); err != nil || seq != 1 || signedAt == nil {
		t.Fatalf("seeded signed snapshot: seq %d signed_at %v %s", seq, signedAt, sqlState(err))
	}
	// the signed request columns and the series number never change; a signed row is never deleted outside tenant_purge
	for _, set := range []string{`period_start = period_start - interval '1 day'`, `period_end = period_end - interval '1 day'`,
		`schema_version = 2, preset = 'custom'`, `series_seq = 9`, `signed_at = NULL`} {
		if err := tryIn(t, fmt.Sprintf(`UPDATE scf.traction_snapshots SET %s WHERE snapshot_id = '%s'`, set, snapA)); code(err) != "42501" {
			t.Errorf("changing %s of a signed snapshot: want 42501, got %q", set, sqlState(err))
		}
	}
	if err := tryIn(t, fmt.Sprintf(`DELETE FROM scf.traction_snapshots WHERE snapshot_id = '%s'`, snapA)); code(err) != "42501" {
		t.Errorf("superuser deleting a signed snapshot: want 42501, got %q", sqlState(err))
	}
	app := runtimeConn(t, "scf_app")
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM scf.traction_snapshots WHERE snapshot_id = $1`, snapA)
		return err
	}); code(err) != "42501" {
		t.Errorf("scf_app deleting a snapshot: want 42501, got %q", sqlState(err))
	}
	jobs := runtimeConn(t, "scf_jobs")
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM scf.traction_snapshots WHERE snapshot_id = $1`, snapA)
		if err == nil && tag.RowsAffected() != 1 {
			return fmt.Errorf("%d rows", tag.RowsAffected())
		}
		return err
	}); err != nil {
		t.Errorf("tenant_purge deleting a signed snapshot (and its leaf): %s", sqlState(err))
	}

	// signing a pending v2 request as job public_metrics: a wrong series number is refused; the next one is accepted,
	// and signed_at is stamped
	pending := uid(A, 302)
	mustExec(t, su, `INSERT INTO scf.traction_snapshots (tenant_id, snapshot_id, created_by, period_start, period_end,
	    include_api, schema_version, preset) VALUES ($1, $2, $3, '2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z', true, 2,
	    'pg_renewal_quarter')`, A, pending, users[A])
	t.Cleanup(func() {
		// the guard binds the superuser too: remove the test row with triggers off, in one transaction
		if tx, err := su.Begin(ctx); err == nil {
			_, _ = tx.Exec(ctx, `SET LOCAL session_replication_role = replica`)
			_, _ = tx.Exec(ctx, `DELETE FROM scf.traction_snapshots WHERE snapshot_id = $1`, pending)
			_ = tx.Commit(ctx)
		}
	})
	sign := func(seq string) error {
		return inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "public_metrics", Job: "public_metrics"},
			func(ctx context.Context, tx pgx.Tx) error {
				_, err := tx.Exec(ctx, `UPDATE scf.traction_snapshots SET document = '{"schema":"scf-analytics/traction-snapshot/2"}',
				    canonical_sha256 = sha256('v2'), signature = decode(repeat('11', 64), 'hex'), kid = 'k1',
				    methodology_version = 'scf-methodology/1.0.0', series_seq = `+seq+` WHERE snapshot_id = $1`, pending)
				return err
			})
	}
	if err := sign("5"); code(err) != "23514" {
		t.Errorf("signing with a gap in the series: want 23514, got %q", sqlState(err))
	}
	if err := sign("2"); err != nil {
		t.Errorf("signing with the next series number: %s", sqlState(err))
	}
	// committed sign (NULL: the trigger fills the next number) for the list check
	mustExec(t, su, `UPDATE scf.traction_snapshots SET document = '{}', canonical_sha256 = sha256('v2'),
	    signature = decode(repeat('11', 64), 'hex'), kid = 'k1' WHERE snapshot_id = $1`, pending)
	var list []string
	if err := inCtx(t, app, Ctx{Kind: "anonymous"}, func(ctx context.Context, tx pgx.Tx) error {
		var err error
		list, err = queryStrings(ctx, tx, `SELECT series_seq, COALESCE(previous_sha256, '-'), canonical_sha256, signed_at IS NOT NULL
		    FROM scf.public_snapshot_list('tenant-a')`)
		return err
	}); err != nil || len(list) != 2 {
		t.Fatalf("public_snapshot_list: %v %s", list, sqlState(err))
	}
	first := strings.Split(list[0], " | ")
	second := strings.Split(list[1], " | ")
	if first[0] != "1" || first[1] != "-" || second[0] != "2" || second[1] != first[2] || second[3] != "true" {
		t.Errorf("series in the list: %v", list)
	}
}

// C-137 (findings 1, 2, 11, 13): head path, segments and chain continuity of seal days; provisional leaves.
func TestSealChain0065(t *testing.T) {
	ctx := context.Background()
	su := super(t)
	z := `decode(repeat('00', 32), 'hex')`
	h := func(b string) string { return `decode(repeat('` + b + `', 32), 'hex')` }
	// seed: testnet, yesterday, root = SHA-256("op…"), segment 1
	yRoot := `(SELECT root FROM scf.seal_days WHERE network = 'testnet' AND day = (now() AT TIME ZONE 'UTC')::date - 1)`
	day := func(network, offset, prev, segment, leafCount, head string) string {
		return fmt.Sprintf(`INSERT INTO scf.seal_days (network, day, segment, prev_root, audit_anchor_sha256, leaf_count,
		    head_path, root) VALUES ('%s', (now() AT TIME ZONE 'UTC')::date + %s, %s, %s, %s, %s, %s, %s)`,
			network, offset, segment, prev, h("aa"), leafCount, head, h("cc"))
	}
	for _, c := range []struct{ name, stmt, want string }{
		{"next day continues the chain", day("testnet", "0", yRoot, "1", "2", "'{}'"), ""},
		{"next day after a reset", day("testnet", "0", yRoot, "2", "3", "ARRAY["+h("01")+"]"), ""},
		{"wrong prev_root", day("testnet", "0", h("dd"), "1", "2", "'{}'"), "23514"},
		{"segment jumps by two", day("testnet", "0", yRoot, "3", "2", "'{}'"), "23514"},
		{"a skipped day", day("testnet", "1", yRoot, "1", "2", "'{}'"), "23514"},
		{"a day before the chain", day("testnet", "-2", z, "1", "2", "'{}'"), "23514"},
		{"first mainnet day", day("mainnet", "0", z, "1", "5", "ARRAY["+h("01")+","+h("02")+"]"), ""},
		{"first mainnet day with a prev_root", day("mainnet", "0", h("dd"), "1", "2", "'{}'"), "23514"},
		{"first mainnet day in segment 2", day("mainnet", "0", z, "2", "2", "'{}'"), "23514"},
		{"head path too short", day("mainnet", "0", z, "1", "5", "ARRAY["+h("01")+"]"), "23514"},
		{"head path for 2 leaves is empty", day("mainnet", "0", z, "1", "2", "ARRAY["+h("01")+"]"), "23514"},
		{"head path with NULL", day("mainnet", "0", z, "1", "3", "ARRAY[NULL::bytea]"), "23514"},
		{"head path for 9 leaves has 3", day("mainnet", "0", z, "1", "9", "ARRAY["+h("01")+","+h("02")+","+h("03")+"]"), ""},
	} {
		if err := tryIn(t, c.stmt); code(err) != c.want {
			t.Errorf("%s: want %q, got %q", c.name, c.want, sqlState(err))
		}
	}
	for _, set := range []string{`head_path = '{}'`, `segment = 2`} {
		if err := tryIn(t, `UPDATE scf.seal_days SET `+set); code(err) != "42501" {
			t.Errorf("changing %s of a built day: want 42501, got %q", set, sqlState(err))
		}
	}
	// one leaf index per day and network, across tenants
	leaf := func(ten, snap, network, offset string, idx int) string {
		return fmt.Sprintf(`INSERT INTO scf.seal_leaves (tenant_id, snapshot_id, network, day, leaf_index, salt, leaf_hash,
		    audit_path) VALUES ('%s', '%s', '%s', (now() AT TIME ZONE 'UTC')::date + %s, %d, %s, %s, ARRAY[%s])`,
			ten, snap, network, offset, idx, h("01"), h("02"), h("03"))
	}
	if err := tryIn(t, leaf(A, uid(A, 10), "mainnet", "0", 2), leaf(B, uid(B, 10), "mainnet", "0", 2)); code(err) != "23505" {
		t.Errorf("two leaves with one index: want 23505, got %q", sqlState(err))
	}
	// daily_seal may delete a provisional leaf (no seal_days row) but never a final one
	jobs := runtimeConn(t, "scf_jobs")
	seal := Ctx{Tenant: A, Kind: "job", Actor: "daily_seal", Job: "daily_seal"}
	if err := inCtx(t, jobs, seal, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, leaf(A, uid(A, 10), "mainnet", "0", 2)); err != nil {
			return fmt.Errorf("insert provisional: %s", sqlState(err))
		}
		tag, err := tx.Exec(ctx, `DELETE FROM scf.seal_leaves WHERE network = 'mainnet'`)
		if err != nil || tag.RowsAffected() != 1 {
			return fmt.Errorf("delete provisional: %d %s", tag.RowsAffected(), sqlState(err))
		}
		return nil
	}); err != nil {
		t.Error(err)
	}
	if err := inCtx(t, jobs, seal, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM scf.seal_leaves WHERE network = 'testnet'`)
		return err
	}); code(err) != "42501" {
		t.Errorf("daily_seal deleting a final leaf: want 42501, got %q", sqlState(err))
	}
	// a provisional leaf is never served as a proof
	mustExec(t, su, leaf(A, uid(A, 10), "mainnet", "0", 2))
	t.Cleanup(func() { _, _ = su.Exec(ctx, `DELETE FROM scf.seal_leaves WHERE network = 'mainnet'`) })
	var proof []byte
	app := runtimeConn(t, "scf_app")
	if err := inCtx(t, app, Ctx{Kind: "anonymous"}, func(ctx context.Context, tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT scf.public_seal_proof($1)::text`, uid(A, 10)).Scan(&proof)
	}); err != nil {
		t.Fatal(sqlState(err))
	}
	var proofs []map[string]any
	if err := json.Unmarshal(proof, &proofs); err != nil || len(proofs) != 1 || proofs[0]["network"] != "testnet" {
		t.Errorf("proofs with a provisional mainnet leaf: %s %v", proof, err)
	}
	if hp, ok := proofs[0]["head_path"].([]any); !ok || len(hp) != 2 {
		t.Errorf("head_path of a 5-leaf day: %v", proofs[0]["head_path"])
	}
}

// C-137 (findings 5 and 9): footprint retention, the machine-key view of op_footprint, conflicts and their resolution.
func TestFootprintRetentionAndConflict0066(t *testing.T) {
	ctx := context.Background()
	su := super(t)
	acct := func(n int) string { return "G" + strings.Repeat("C", 54) + string("ABCDEFGH"[n]) }
	for i, c := range []struct{ status, extra string }{
		{"rejected", `, rejected_reason, last_checked_at) VALUES ('%s', '%s', '%s', 'mainnet', '%s', 'rejected', 'not_listed_in_toml', now() - interval '31 days')`},
		{"claimed", `, removed_at) VALUES ('%s', '%s', '%s', 'mainnet', '%s', 'claimed', now() - interval '31 days')`},
		{"claimed", `, created_at) VALUES ('%s', '%s', '%s', 'mainnet', '%s', 'claimed', now() - interval '31 days')`},
		{"verified", `, verification_method, verified_at, created_at) VALUES ('%s', '%s', '%s', 'mainnet', '%s', 'verified', 'sep1_accounts', now(), now() - interval '31 days')`},
		{"claimed", `, created_at) VALUES ('%s', '%s', '%s', 'mainnet', '%s', 'claimed', now() - interval '10 days')`},
	} {
		mustExec(t, su, fmt.Sprintf(`INSERT INTO scf.footprint_items (tenant_id, kind, subject, network, created_by, status`+c.extra,
			A, "app_account", acct(i), users[A]))
	}
	t.Cleanup(func() {
		_, _ = su.Exec(ctx, `DELETE FROM scf.footprint_items WHERE subject LIKE 'GCCCC%'`)
		_, _ = su.Exec(ctx, `UPDATE scf.declared_contracts SET status = 'declared', verified_role = NULL,
		    verified_by_evidence = NULL, verified_at = NULL, conflict_since = NULL, rejected_reason = NULL,
		    next_check_at = NULL WHERE tenant_id IN ($1, $2)`, A, B)
	})
	jobs := runtimeConn(t, "scf_jobs")
	var n int64
	if err := inCtx(t, jobs, Ctx{Tenant: A, Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `SELECT scf.retention_apply('footprint_items')`).Scan(&n); err != nil {
			return err
		}
		left, err := queryStrings(ctx, tx, `SELECT status FROM scf.footprint_items WHERE subject LIKE 'GCCCC%' ORDER BY status`)
		if err == nil && strings.Join(left, ",") != "claimed,verified" {
			return fmt.Errorf("left after retention: %v", left)
		}
		return err
	}); err != nil || n != 3 {
		t.Errorf("retention_apply(footprint_items): n=%d err=%v", n, err)
	}

	// a machine key sees an account item's subject only when it is verified; a human operator sees every subject
	subjects := func(oc opCall) map[string]string {
		t.Helper()
		rows, _, err := callOp(t, oc, `SELECT status, subject FROM scf.op_footprint($1::uuid[]) WHERE kind = 'app_account'`, []string{A})
		if err != nil {
			t.Fatal(sqlState(err))
		}
		m := map[string]string{}
		for _, r := range rows {
			m[str(r[0])+"/"+str(r[1])[:min(5, len(str(r[1])))]] = ""
		}
		return m
	}
	if m := subjects(opCall{"scf_metrics_ro", keyCtx("registry:read")}); fmt.Sprint(m) != fmt.Sprint(map[string]string{
		"claimed/<nil>": "", "rejected/<nil>": "", "verified/GCCCC": ""}) {
		t.Errorf("machine key view: %v", m)
	}
	if m := subjects(opCall{"scf_app", operatorCtx(false)}); fmt.Sprint(m) != fmt.Sprint(map[string]string{
		"claimed/GCCCC": "", "rejected/GCCCC": "", "verified/GCCCC": ""}) {
		t.Errorf("operator view: %v", m)
	}

	// the same contract verified for A and B: both flagged; an operator_admin rejects A's claim
	var cidB string
	if err := su.QueryRow(ctx, `SELECT contract_id FROM scf.declared_contracts WHERE tenant_id = $1`, B).Scan(&cidB); err != nil {
		t.Fatal(err)
	}
	mustExec(t, su, `UPDATE scf.declared_contracts b SET contract_id = a.contract_id FROM scf.declared_contracts a
	    WHERE a.tenant_id = $1 AND b.tenant_id = $2`, A, B)
	t.Cleanup(func() {
		_, _ = su.Exec(ctx, `UPDATE scf.declared_contracts SET contract_id = $2 WHERE tenant_id = $1`, B, cidB)
	})
	for _, ten := range []string{A, B} {
		mustExec(t, su, `UPDATE scf.declared_contracts SET status = 'verified', verified_role = 'admin',
		    verified_by_evidence = $2, verified_at = now(), conflict_since = now() WHERE tenant_id = $1`, ten, uid(ten, 12))
	}
	admin := opCall{"scf_app", adminCtx()}
	if _, _, err := callOp(t, opCall{"scf_app", operatorCtx(true)}, `SELECT scf.op_footprint_reject($1, $2)`, A, uid(A, 6)); code(err) != "42501" {
		t.Errorf("operator (not admin): want 42501, got %q", sqlState(err))
	}
	if _, _, err := callOp(t, admin, `SELECT scf.op_footprint_reject($1, $2)`, A, uid(A, 999)); code(err) != "P0002" {
		t.Errorf("unknown item: want P0002, got %q", sqlState(err))
	}
	if _, _, err := callOp(t, admin, `SELECT scf.op_footprint_reject($1, $2)`, A, uid(A, 16)); code(err) != "22023" {
		t.Errorf("item not in conflict: want 22023, got %q", sqlState(err))
	}
	conn := runtimeConn(t, "scf_app")
	if err := inCtx(t, conn, adminCtx(), func(ctx context.Context, tx pgx.Tx) error {
		var kind string
		if err := tx.QueryRow(ctx, `SELECT scf.op_footprint_reject($1, $2)`, A, uid(A, 6)).Scan(&kind); err != nil || kind != "contract" {
			return fmt.Errorf("reject: %q %s", kind, sqlState(err))
		}
		got, err := queryStrings(ctx, tx, `SELECT tenant_id::text, status, COALESCE(rejected_reason, '-'), conflict_since IS NOT NULL
		    FROM scf.op_footprint($1::uuid[]) WHERE kind = 'contract' ORDER BY tenant_id`, []string{A, B})
		if err != nil {
			return err
		}
		want := []string{A + " | rejected | claimed_by_other_tenant | false", B + " | verified | - | true"}
		if !slices.Equal(got, want) {
			return fmt.Errorf("after resolution: %v, want %v", got, want)
		}
		var actions []string
		actions, err = queryStrings(ctx, tx, `SELECT action FROM scf.audit_log WHERE tx_id = pg_current_xact_id() ORDER BY seq`)
		if err == nil && !slices.Contains(actions, "footprint.conflict_resolved") {
			return fmt.Errorf("audit: %v", actions)
		}
		return err
	}); err != nil {
		t.Error(err)
	}
}
