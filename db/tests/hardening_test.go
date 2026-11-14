// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Database resolutions of the G1 review (register C-114). Each test reproduces one finding and holds the fix.

// Finding 10: scf_migrator holds the definer roles WITH INHERIT FALSE, SET TRUE — it may hand functions to them
// (ALTER … OWNER TO needs SET), but never uses their unconditional policies to read or write tenant data.
func TestMigratorInheritsNoDefinerRole(t *testing.T) {
	ctx := context.Background()
	rows, err := queryStrings(ctx, super(t), `SELECT g.rolname, a.inherit_option, a.set_option
	    FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
	   WHERE m.rolname = 'scf_migrator' AND g.rolname IN ('scf_definer', 'scf_op_definer', 'scf_audit_definer') ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"scf_audit_definer | false | true", "scf_definer | false | true", "scf_op_definer | false | true"}
	if !slices.Equal(rows, want) {
		t.Errorf("migrator memberships: want %v, got %v", want, rows)
	}
	m := migrator(t)
	for _, c := range []struct {
		name string
		c    Ctx
		set  bool
	}{
		{"no context", Ctx{}, false},
		{"operator context", Ctx{Kind: "operator", Actor: uOp, PlatformRole: "operator_admin"}, true},
		{"tenant A user", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, true},
		{"job audit_anchor", Ctx{Kind: "job", Actor: "audit_anchor", Job: "audit_anchor"}, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			tx, err := m.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if c.set {
				if err := setCtx(ctx, tx, c.c); err != nil {
					t.Fatal(sqlState(err))
				}
			}
			for _, rel := range []string{"scf.tenants", "scf.memberships", "scf.sites", "scf.audit_log", "scf.audit_chain_heads",
				"scf.share_keys", "scf.enrollment_tombstones", "scf.api_metrics_1h"} {
				var n int64
				err := savepoint(ctx, tx, func(sp pgx.Tx) error { return sp.QueryRow(ctx, "SELECT count(*) FROM "+rel).Scan(&n) })
				if err != nil {
					t.Errorf("%s: %s", rel, sqlState(err))
				} else if n != 0 {
					t.Errorf("migrator reads %d rows of %s", n, rel)
				}
			}
			var changed int64
			_ = savepoint(ctx, tx, func(sp pgx.Tx) error {
				tag, err := sp.Exec(ctx, `UPDATE scf.audit_chain_heads SET last_seq = last_seq`)
				changed = tag.RowsAffected()
				return err
			})
			_ = savepoint(ctx, tx, func(sp pgx.Tx) error {
				tag, err := sp.Exec(ctx, `UPDATE scf.tenants SET name = name`)
				changed += tag.RowsAffected()
				return err
			})
			if changed != 0 {
				t.Errorf("migrator updated %d chain heads / tenants", changed)
			}
		})
	}
}

// Finding 11: role passwords never reach the server as clear text — db/migrate.sh sets them with psql's \password
// (libpq computes the SCRAM-SHA-256 verifier client-side) in a session with pg_stat_statements utility tracking and
// statement logging off. Checked for the bootstrap (roles.sql) and the umami step (umami/scf_ro.sql).
func TestNoClearTextPasswordsInStats(t *testing.T) {
	ctx := context.Background()
	pg := connectTo(t, "postgres", "postgres", false)
	const udb = "umami_pw"
	mustExec(t, pg, `DO $$ BEGIN CREATE ROLE umami_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
	mustExec(t, pg, `DROP DATABASE IF EXISTS `+udb+` WITH (FORCE)`)
	mustExec(t, pg, `CREATE DATABASE `+udb+` OWNER umami_app`)
	t.Cleanup(func() { mustExec(t, pg, `DROP DATABASE IF EXISTS `+udb+` WITH (FORCE)`) })
	um := connectTo(t, "postgres", udb, false)
	mustExec(t, um, umamiTables)
	_ = um.Close(ctx)

	stats := super(t) // the extension lives in database scf; its view covers the whole cluster
	mustExec(t, stats, `SELECT pg_stat_statements_reset()`)
	if out, err := runMigrate(nil, "bootstrap"); err != nil {
		t.Fatalf("bootstrap: %v\n%s", err, out)
	}
	if out, err := runMigrate([]string{"-e", "UMAMI_DB_NAME=" + udb}, "umami-views"); err != nil {
		t.Fatalf("umami-views: %v\n%s", err, out)
	}
	rows, err := queryStrings(ctx, stats, `SELECT query FROM pg_stat_statements WHERE query ILIKE '%PASSWORD ''%'`)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) > 0 {
		t.Errorf("pg_stat_statements keeps password statements: %v", rows)
	}
	// every role got a SCRAM verifier, and the passwords work (the suite connects with them throughout)
	bad, err := queryStrings(ctx, pg, `SELECT rolname FROM pg_authid
	   WHERE rolname IN ('scf_migrator', 'scf_app', 'scf_writer', 'scf_jobs', 'scf_metrics_ro', 'scf_umami_ro', 'scf_umami_maint')
	     AND rolpassword !~ '^SCRAM-SHA-256\$4096:'`)
	if err != nil || len(bad) > 0 {
		t.Errorf("roles without a SCRAM verifier: %v %v", bad, err)
	}
	for _, role := range []string{"scf_app", "scf_umami_ro"} {
		db := "scf"
		if role == "scf_umami_ro" {
			db = udb
		}
		c, err := pgx.Connect(ctx, dsn(role, db, false))
		if err != nil {
			t.Errorf("%s cannot sign in with its password: %v", role, err)
			continue
		}
		_ = c.Close(ctx)
	}
	// and the SQL files no longer carry a password statement at all
	for _, f := range []string{"bootstrap/roles.sql", "umami/scf_ro.sql"} {
		if body := readFile(t, filepath.Join(dbDir, f)); regexp.MustCompile(`(?i)PASSWORD\s+%L`).MatchString(body) {
			t.Errorf("%s still formats a clear-text password into SQL", f)
		}
	}
}

// Finding 12: the lifecycle columns of tenants are not writable by runtime roles (column-level grants, §8.3).
func TestTenantLifecycleColumnsNotWritable(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	owner := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	for _, set := range []string{"purged_at = now()", "purge_after = now()", "removed_at = now()", "created_at = now()",
		"status_changed_at = now()", "status_changed_by = NULL", "created_by = created_by", "is_canary = false", "slug = slug",
		"tenant_id = tenant_id"} {
		err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE scf.tenants SET `+set+` WHERE tenant_id = $1`, A)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("scf_app SET %s: want 42501, got %q", set, sqlState(err))
		}
	}
	// the columns the control plane does write still work
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE scf.tenants SET name = name, description = description, public_stats_enabled = public_stats_enabled,
		    onchain_correlation_enabled = onchain_correlation_enabled WHERE tenant_id = $1`, A)
		if err == nil && tag.RowsAffected() != 1 {
			return fmt.Errorf("%d rows updated", tag.RowsAffected())
		}
		return err
	}); err != nil {
		t.Errorf("scf_app updating name/description/toggles: %s", sqlState(err))
	}
	// INSERT cannot pre-set lifecycle columns either
	err := inCtx(t, app, Ctx{Tenant: uid(A, 900), Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by, created_at)
		    VALUES ($1, 'lifecycle-x', 'x', 'active', $2, now() - interval '1 year')`, uid(A, 900), users[A])
		return err
	})
	if code(err) != "42501" {
		t.Errorf("scf_app INSERT with created_at: want 42501, got %q", sqlState(err))
	}
	// tenant_purge may set purged_at — and nothing else
	jobs := runtimeConn(t, "scf_jobs")
	purge := Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}
	for _, set := range []string{"purge_after = now()", "status = 'active'", "removed_at = now()", "name = 'x'"} {
		err := inCtx(t, jobs, purge, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `UPDATE scf.tenants SET `+set+` WHERE tenant_id = $1`, A)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("tenant_purge SET %s: want 42501, got %q", set, sqlState(err))
		}
	}
}

// Finding 20: op_* functions authorise before they read or lock anything — a caller without an operator context
// learns nothing about whether a tenant, site or service exists.
func TestOpFunctionsAuthoriseFirst(t *testing.T) {
	missing := "99999999-0000-7000-8000-000000000099"
	cases := []struct {
		name string
		oc   opCall
		sql  string
		args []any
	}{
		{"transition, tenant user", opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}},
			`SELECT scf.op_tenant_transition($1, 'suspend', 'x')`, nil},
		{"transition, operator without step-up", opCall{"scf_app", operatorCtx(false)},
			`SELECT scf.op_tenant_transition($1, 'suspend', 'x')`, nil},
		{"transition purge_now, operator (not admin)", opCall{"scf_app", operatorCtx(true)},
			`SELECT scf.op_tenant_transition($1, 'purge_now', 'x')`, nil},
		{"annotation, tenant user", opCall{"scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}},
			`SELECT scf.op_add_annotation($1, $2::uuid, NULL, now() - interval '1 day', now(), 'x')`, []any{missing}},
		{"annotation, operator without step-up", opCall{"scf_app", operatorCtx(false)},
			`SELECT scf.op_add_annotation($1, $2::uuid, NULL, now() - interval '1 day', now(), 'x')`, []any{missing}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for _, tenant := range []string{B, missing} {
				_, _, err := callOp(t, c.oc, c.sql, append([]any{tenant}, c.args...)...)
				if code(err) != "42501" {
					t.Errorf("tenant %s: want 42501 before any lookup, got %q", tenant, sqlState(err))
				}
			}
		})
	}
}

// Finding 21: every audit action has a writer list; audit-log inserts are limited per role to that list.
func TestAuditActionAllowlists(t *testing.T) {
	op := Ctx{Kind: "operator", Actor: uOp, PlatformRole: "operator"}
	refused := []struct {
		role, action string
		c            Ctx
		tenant       any
	}{
		{"scf_metrics_ro", "tenant.purged", op, nil},
		{"scf_metrics_ro", "audit.anchored", op, nil},
		{"scf_app", "tenant.purged", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, A},
		{"scf_app", "audit.anchored", Ctx{Kind: "user", Actor: users[A]}, nil},
		{"scf_app", "operator.read.op_projects", op, nil},
		{"scf_app", "tenant.approved", op, nil},
		{"scf_jobs", "auth.signed_in", Ctx{Kind: "job", Actor: "retention", Job: "retention"}, nil},
		{"scf_jobs", "settings.updated", Ctx{Kind: "job", Actor: "retention", Job: "retention"}, nil},
	}
	for _, r := range refused {
		if err := appendAudit(t, runtimeConn(t, r.role), r.c, r.tenant, r.action); code(err) != "42501" {
			t.Errorf("%s inserting %s: want 42501, got %q", r.role, r.action, sqlState(err))
		}
	}
	allowed := []struct {
		role, action string
		c            Ctx
		tenant       any
	}{
		{"scf_metrics_ro", "operator.read.registry", Ctx{Kind: "op_key", Actor: "opkey0000001", KeyScopes: "registry:read"}, nil},
		{"scf_jobs", "audit.verified", Ctx{Kind: "job", Actor: "audit_verify", Job: "audit_verify"}, nil},
		{"scf_jobs", "tenant.purged", Ctx{Tenant: A, Kind: "job", Actor: "tenant_purge", Job: "tenant_purge"}, A},
		{"scf_app", "tenant.updated", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, A},
	}
	for _, r := range allowed {
		conn := runtimeConn(t, r.role)
		err := inCtx(t, conn, r.c, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO scf.audit_log (tenant_id, actor_kind, actor_id, action) VALUES ($1::uuid, $2, $3, $4)`,
				r.tenant, r.c.Kind, nullStr(r.c.Actor), r.action)
			return err
		})
		if err != nil {
			t.Errorf("%s inserting %s: %s", r.role, r.action, sqlState(err))
		}
	}

	// the lists themselves: every action has a writer; every action the control plane writes (OpenAPI
	// x-audit-action of operations that are not op_* functions, and every literal in services/control-plane/src)
	// is allowed for scf_app; the op_* operations' actions are allowed for scf_op_definer.
	writers := map[string][]string{}
	rows, err := super(t).Query(context.Background(), `SELECT action, writers FROM scf.audit_actions`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	for rows.Next() {
		var a string
		var w []string
		if err := rows.Scan(&a, &w); err != nil {
			t.Fatal(err)
		}
		writers[a] = w
	}
	rows.Close()
	for a, w := range writers {
		if len(w) == 0 {
			t.Errorf("action %s has no writer", a)
		}
	}
	// The audit list endpoints validate every row against components.schemas.AuditAction: an action the database
	// registers but the enum lacks makes GET /v1/operator/audit fail as soon as such a row exists (found by the
	// isolation matrix after footprint.conflict_resolved, C-139). Both lists must be the same.
	enum := openAPIAuditActionEnum(t)
	for a := range writers {
		if !slices.Contains(enum, a) {
			t.Errorf("scf.audit_actions has %s, missing from AuditAction in docs/api/control-plane.openapi.yaml", a)
		}
	}
	for _, a := range enum {
		if _, ok := writers[a]; !ok {
			t.Errorf("AuditAction in docs/api/control-plane.openapi.yaml has %s, not in scf.audit_actions", a)
		}
	}
	appActs, opActs := openAPIAuditActions(t)
	for _, a := range appActs {
		if !slices.Contains(writers[a], "scf_app") {
			t.Errorf("OpenAPI action %s (control plane) is not allowed for scf_app: %v", a, writers[a])
		}
	}
	for _, a := range opActs {
		if !slices.Contains(writers[a], "scf_op_definer") {
			t.Errorf("OpenAPI action %s (op_* function) is not allowed for scf_op_definer: %v", a, writers[a])
		}
	}
	// The control plane writes as scf_app, and as scf_jobs for the jobs it runs in-process (edge_snapshot,
	// umami_reconcile, domain_verification, erasure; C-113, C-117). The trigger still enforces the exact role per
	// action at run time, which the control plane's integration tests exercise.
	for _, a := range controlPlaneAuditLiterals(t) {
		if !slices.Contains(writers[a], "scf_app") && !slices.Contains(writers[a], "scf_jobs") {
			t.Errorf("services/control-plane writes %s, not allowed for scf_app or scf_jobs: %v", a, writers[a])
		}
	}
}

// openAPIAuditActions reads x-audit-action values of docs/api/*.openapi.yaml per operation and splits them by
// whether the operation names an op_* function in x-db-function (written by scf_op_definer) or not (the control
// plane's own transaction). A line-based reader is enough: both documents are generated with a fixed layout.
func openAPIAuditActions(t *testing.T) (app, op []string) {
	t.Helper()
	opRe := regexp.MustCompile(`^\s*x-db-function:\s*scf\.op_`)
	actRe := regexp.MustCompile(`^(\s*)x-audit-action:\s*(\S*)\s*$`)
	itemRe := regexp.MustCompile(`^\s*-\s*([a-z][a-z0-9_.]+)\s*$`)
	methodRe := regexp.MustCompile(`^    (get|put|post|patch|delete):\s*$`)
	for _, f := range []string{"control-plane.openapi.yaml", "operator-metrics.openapi.yaml"} {
		lines := strings.Split(readFile(t, filepath.Join(repoDir, "docs", "api", f)), "\n")
		var acts []string
		isOp := false
		// An operator.read.op_<fn> action is written by that op_* function whatever else the operation does (e.g.
		// /op/v1/registry/projects reads the global registry table itself and op_projects for the links).
		flush := func() {
			for _, a := range acts {
				if isOp || strings.HasPrefix(a, "operator.read.op_") {
					op = append(op, a)
				} else {
					app = append(app, a)
				}
			}
			acts, isOp = nil, false
		}
		for i := 0; i < len(lines); i++ {
			l := lines[i]
			if methodRe.MatchString(l) || (len(l) > 2 && l[0] == ' ' && l[1] == ' ' && l[2] == '/') {
				flush()
				continue
			}
			if opRe.MatchString(l) {
				isOp = true
			}
			if m := actRe.FindStringSubmatch(l); m != nil {
				if m[2] != "" {
					acts = append(acts, m[2])
					continue
				}
				for i+1 < len(lines) {
					im := itemRe.FindStringSubmatch(lines[i+1])
					if im == nil {
						break
					}
					acts = append(acts, im[1])
					i++
				}
			}
		}
		flush()
	}
	if len(app) < 40 || len(op) < 15 {
		t.Fatalf("OpenAPI reader found too few actions (app %d, op %d)", len(app), len(op))
	}
	return
}

// openAPIAuditActionEnum reads the enum of components.schemas.AuditAction (fixed generated layout, as above).
func openAPIAuditActionEnum(t *testing.T) []string {
	t.Helper()
	lines := strings.Split(readFile(t, filepath.Join(repoDir, "docs", "api", "control-plane.openapi.yaml")), "\n")
	itemRe := regexp.MustCompile(`^      - ([a-z][a-z0-9_.]+)\s*$`)
	var out []string
	for i, l := range lines {
		if l != "    AuditAction:" {
			continue
		}
		for j := i + 1; j < len(lines); j++ {
			if m := itemRe.FindStringSubmatch(lines[j]); m != nil {
				out = append(out, m[1])
			} else if strings.HasPrefix(lines[j], "    ") && !strings.HasPrefix(lines[j], "      ") {
				break
			}
		}
		break
	}
	if len(out) < 50 {
		t.Fatalf("AuditAction enum reader found %d actions", len(out))
	}
	return out
}

// controlPlaneAuditLiterals collects `action: "…"` literals of services/control-plane/src.
func controlPlaneAuditLiterals(t *testing.T) []string {
	t.Helper()
	re := regexp.MustCompile(`action:\s*"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"`)
	var out []string
	root := filepath.Join(repoDir, "services", "control-plane", "src")
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".ts") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		for _, m := range re.FindAllStringSubmatch(string(b), -1) {
			out = append(out, m[1])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatal("no audit literals found in services/control-plane/src")
	}
	return out
}

// Finding 22: canonical text v2 is version-prefixed and injective. Under v1 (concat_ws('|', …)) both pairs collided.
func TestAuditCanonicalInjective(t *testing.T) {
	su := super(t)
	base := `{"chain_id":"` + A + `","seq":7,"occurred_at":"2026-11-12T10:00:00Z","tenant_id":"` + A + `",
	  "actor_kind":"user","action":"site.updated","outcome":"success","details":{}}`
	canon := func(extra string) string {
		var s string
		if err := su.QueryRow(context.Background(), `SELECT scf.audit_canonical(jsonb_populate_record(NULL::scf.audit_log, $1::jsonb || $2::jsonb))`,
			base, extra).Scan(&s); err != nil {
			t.Fatal(sqlState(err))
		}
		return s
	}
	pairs := [][2]string{
		{`{"target_type":"a|b","target_id":"c"}`, `{"target_type":"a","target_id":"b|c"}`}, // separator inside a field
		{`{"actor_id":null}`, `{"actor_id":""}`},                                           // NULL vs empty string
		{`{"subject_tenant_ids":null}`, `{"request_id":"*"}`},                              // '*' marker vs a value
		{`{"actor_id":"x|site.updated"}`, `{"actor_id":"x","action":"site.updated"}`},
	}
	for _, p := range pairs {
		a, b := canon(p[0]), canon(p[1])
		if a == b {
			t.Errorf("canonical texts collide for %s vs %s: %s", p[0], p[1], a)
		}
		if !strings.HasPrefix(a, "v2:") || !strings.HasPrefix(b, "v2:") {
			t.Errorf("canonical text is not version-prefixed v2: %s", a)
		}
	}
	verifyChains(t, su)
}

// Finding 23: retention of registry_projects keeps rows a tenant link still references (the FK would fail).
func TestRetentionRegistryProjectsWithLinks(t *testing.T) {
	su := super(t)
	orphan := "0d000000-0000-7000-8000-0000000000d2"
	mustExec(t, su, `INSERT INTO scf.registry_projects (registry_project_id, source, source_id, name, fetched_at, content_sha256, raw, missing_since)
	    VALUES ($1, 'stellarlight', 'p-orphan', 'Gone', now(), sha256('orphan'::bytea), '{}', now() - interval '400 days')`, orphan)
	mustExec(t, su, `UPDATE scf.registry_projects SET missing_since = now() - interval '400 days' WHERE registry_project_id = $1`, reg)
	t.Cleanup(func() {
		mustExec(t, su, `DELETE FROM scf.registry_projects WHERE registry_project_id = $1`, orphan)
		mustExec(t, su, `UPDATE scf.registry_projects SET missing_since = NULL WHERE registry_project_id = $1`, reg)
	})
	jobs := runtimeConn(t, "scf_jobs")
	err := inCtx(t, jobs, Ctx{Kind: "job", Actor: "retention", Job: "retention"}, func(ctx context.Context, tx pgx.Tx) error {
		var n int64
		if err := tx.QueryRow(ctx, `SELECT scf.retention_apply('registry_projects')`).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			return fmt.Errorf("deleted %d registry projects, want 1 (the unlinked one)", n)
		}
		var left int
		if err := su.QueryRow(ctx, `SELECT count(*) FROM scf.registry_projects WHERE registry_project_id = $1`, reg).Scan(&left); err != nil || left != 1 {
			return fmt.Errorf("linked project gone (%d, %v)", left, err)
		}
		return nil
	})
	if err != nil {
		t.Error(sqlState(err))
	}
}

// Finding 24: later migrations can seed and correct the global constant tables as scf_migrator (FORCE RLS applies to
// the owner, so it needs its own policies there).
func TestMigratorCanSeedGlobalTables(t *testing.T) {
	m := migrator(t)
	ctx := context.Background()
	tx, err := m.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, s := range []struct{ sql string }{
		{`INSERT INTO scf.audit_actions SELECT (jsonb_populate_record(NULL::scf.audit_actions,
		    '{"action":"test.seeded","description":"seeded by a later migration","writers":["scf_jobs"]}')).*`},
		{`UPDATE scf.audit_actions SET description = description WHERE action = 'tenant.created'`},
		{`INSERT INTO scf.settings (key, value, description) VALUES ('test_seeded', '1', 'seeded by a later migration')`},
		{`UPDATE scf.settings SET description = description WHERE key = 'pow_cost'`},
		{`UPDATE scf.hist_exp3_map SET frac_lo = frac_lo WHERE k = 1`},
	} {
		var n int64
		err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			tag, err := sp.Exec(ctx, s.sql)
			n = tag.RowsAffected()
			return err
		})
		if err != nil || n != 1 {
			t.Errorf("migrator %q: %d rows, %s", firstLine(s.sql), n, sqlState(err))
		}
	}
}

// Finding 26: scf.accept_invitation joins only tenants that are active or pending.
func TestAcceptInvitationTenantStatus(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	tD, uD, uE := "dddddddd-0000-7000-8000-00000000000d", "0d000000-0000-7000-8000-0000000000d0", "0d000000-0000-7000-8000-0000000000e0"
	mustExec(t, su, `INSERT INTO scf.users (user_id, display_name) VALUES ($1, 'owner d'), ($2, 'invitee e')`, uD, uE)
	mustExec(t, su, `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ($1, 'tenant-d', 'D', 'active', $2)`, tD, uD)
	t.Cleanup(func() {
		for _, q := range []string{`DELETE FROM scf.memberships WHERE tenant_id = $1`, `DELETE FROM scf.tenant_invitations WHERE tenant_id = $1`,
			`DELETE FROM scf.tenants WHERE tenant_id = $1`} {
			mustExec(t, su, q, tD)
		}
		mustExec(t, su, `DELETE FROM scf.users WHERE user_id IN ($1, $2)`, uD, uE)
	})
	setStatus := func(status string) {
		t.Helper()
		tx, err := su.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		mustTx(t, tx, `SET LOCAL ROLE scf_op_definer`)
		mustTx(t, tx, `UPDATE scf.tenants SET status = $2 WHERE tenant_id = $1`, tD, status)
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	app := runtimeConn(t, "scf_app")
	for i, c := range []struct {
		status string
		joins  bool
	}{{"suspended", false}, {"removed", false}, {"pending", true}} {
		setStatus(c.status)
		hash := fmt.Sprintf("invite-d-%d", i)
		mustExec(t, su, `INSERT INTO scf.tenant_invitations (tenant_id, role, code_hash, created_by, expires_at)
		    VALUES ($1, 'viewer', sha256(convert_to($2, 'UTF8')), $3, now() + interval '1 day')`, tD, hash, uD)
		var got *string
		err := inCtx(t, app, Ctx{Kind: "user", Actor: uE}, func(ctx context.Context, tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT scf.accept_invitation(sha256(convert_to($1, 'UTF8')), $2)::text`, hash, uE).Scan(&got)
		})
		if err != nil {
			t.Fatalf("%s: %s", c.status, sqlState(err))
		}
		if (got != nil) != c.joins {
			t.Errorf("tenant %s: accept_invitation returned %v, want joins=%v", c.status, got, c.joins)
		}
	}
}

// Finding 27: migrate.sh includes migration files by a quoted path (a directory with a space or a quote works).
func TestMigratePathQuoting(t *testing.T) {
	const db = "scf_quote"
	t.Cleanup(func() { dropDB(t, db) })
	dir := "/tmp/db dir's copy"
	env := []string{"-e", "SCF_DB_NAME=" + db, "-e", "SCF_DB_BOOTSTRAP=1", "-e", "SCF_DB_DIR=" + dir, "-v", dbDir + ":" + dir + ":ro"}
	out, err := runMigrate(env, "migrate")
	if err != nil || !strings.Contains(out, fmt.Sprintf("%d migrations applied, ledger matches", len(migrationFiles(t)))) {
		t.Fatalf("migrate from %q: %v\n%s", dir, err, out)
	}
}

// Finding 17: without Docker the suite fails unless SCF_SKIP_DOCKER_TESTS=1 is set explicitly.
func TestSuiteFailsWithoutDocker(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go not on PATH")
	}
	envOut, err := exec.Command(goBin, "env", "GOROOT", "GOCACHE", "GOMODCACHE", "GOPATH").Output()
	if err != nil {
		t.Fatal(err)
	}
	vals := strings.Split(strings.TrimSpace(string(envOut)), "\n")
	bin := t.TempDir() // PATH holds go and nothing else: no docker
	if err := os.Symlink(filepath.Join(vals[0], "bin", "go"), filepath.Join(bin, "go")); err != nil {
		t.Fatal(err)
	}
	run := func(extra ...string) (string, error) {
		cmd := exec.Command(goBin, "test", "-v", "-count=1", "-run", "^$", ".")
		cmd.Dir = testDir
		cmd.Env = append([]string{"PATH=" + bin, "HOME=" + os.Getenv("HOME"), "CGO_ENABLED=0", "GOTOOLCHAIN=local",
			"GOROOT=" + vals[0], "GOCACHE=" + vals[1], "GOMODCACHE=" + vals[2], "GOPATH=" + vals[3], "GOFLAGS=-mod=readonly"}, extra...)
		b, err := cmd.CombinedOutput()
		return string(b), err
	}
	if out, err := run(); err == nil || !strings.Contains(out, "docker is required") {
		t.Errorf("without docker: want failure naming docker, got err=%v\n%s", err, out)
	}
	if out, err := run("SCF_SKIP_DOCKER_TESTS=1"); err != nil || !strings.Contains(out, "SKIP") {
		t.Errorf("with SCF_SKIP_DOCKER_TESTS=1: want an explicit skip, got err=%v\n%s", err, out)
	}
}

// Finding 26 (host claims, C-114): removing the domain row that holds a tenant's claim moves the claim to another
// declaration of the same host by the same tenant (verified first), or releases it when none is left. Called by the
// control plane before it deletes the row (the FK would otherwise cascade the claim away).
func TestReleaseDomainClaim(t *testing.T) {
	su := super(t)
	ctx := context.Background()
	var host, dom, site string
	if err := su.QueryRow(ctx, `SELECT host, domain_id::text FROM scf.host_claims WHERE tenant_id = $1`, A).Scan(&host, &dom); err != nil {
		t.Fatal(err)
	}
	site2 := uid(A, 801)
	dom2 := uid(A, 802)
	if err := su.QueryRow(ctx, `SELECT site_id::text FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2`, A, dom).Scan(&site); err != nil {
		t.Fatal(err)
	}
	app := runtimeConn(t, "scf_app")
	owner := Ctx{Tenant: A, Kind: "user", Actor: users[A]}
	call := func(tx pgx.Tx, d string) (string, error) {
		var r string
		err := tx.QueryRow(ctx, `SELECT scf.release_domain_claim($1, $2)`, A, d).Scan(&r)
		return r, err
	}
	claimOf := func(tx pgx.Tx) (string, error) {
		var d *string
		err := tx.QueryRow(ctx, `SELECT domain_id::text FROM scf.host_claims WHERE host = $1`, host).Scan(&d)
		if err == pgx.ErrNoRows {
			return "", nil
		}
		if d == nil {
			return "", err
		}
		return *d, err
	}
	// a second site of A declares the same host: the claim moves there and survives the delete
	mustExec(t, su, `INSERT INTO scf.sites (tenant_id, site_id, name, site_key, umami_website_id, visitor_id, created_by)
	    SELECT tenant_id, $2::uuid, 'second site', substr(md5($2::uuid::text), 1, 22), gen_random_uuid(), visitor_id, created_by
	      FROM scf.sites WHERE tenant_id = $1 AND site_id = $3`, A, site2, site)
	mustExec(t, su, `INSERT INTO scf.site_domains (tenant_id, domain_id, site_id, host) VALUES ($1, $2, $3, $4)`, A, dom2, site2, host)
	t.Cleanup(func() { mustExec(t, su, `DELETE FROM scf.sites WHERE tenant_id = $1 AND site_id = $2`, A, site2) })
	if err := inCtx(t, app, owner, func(ctx context.Context, tx pgx.Tx) error {
		r, err := call(tx, dom)
		if err != nil || r != "moved" {
			return fmt.Errorf("first call: %q %v", r, err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM scf.site_domains WHERE tenant_id = $1 AND domain_id = $2`, A, dom); err != nil {
			return err
		}
		if c, err := claimOf(tx); err != nil || c != dom2 {
			return fmt.Errorf("claim after delete: %q %v (want %s)", c, err, dom2)
		}
		// the last declaration goes: released
		if r, err := call(tx, dom2); err != nil || r != "released" {
			return fmt.Errorf("second call: %q %v", r, err)
		}
		if c, err := claimOf(tx); err != nil || c != "" {
			return fmt.Errorf("claim after release: %q %v", c, err)
		}
		// a row without a claim
		if r, err := call(tx, dom2); err != nil || r != "none" {
			return fmt.Errorf("third call: %q %v", r, err)
		}
		return nil
	}); err != nil {
		t.Error(sqlState(err))
	}
	// only under the tenant's own context
	err := inCtx(t, app, Ctx{Tenant: B, Kind: "user", Actor: users[B]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := call(tx, dom)
		return err
	})
	if code(err) != "42501" {
		t.Errorf("release_domain_claim for A under B: want 42501, got %q", sqlState(err))
	}
}

// C-114: one node-name pattern everywhere, ^[a-z0-9][a-z0-9-]{1,31}$ (edge ledger, spool accounting, durability).
func TestNodeNamePattern(t *testing.T) {
	su := super(t)
	for _, c := range []struct {
		node string
		ok   bool
	}{{"edge-2", true}, {"e1", true}, {"-edge", false}, {"e", false}, {strings.Repeat("a", 32), true}, {strings.Repeat("a", 33), false}} {
		err := inCtxSuper(t, su, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO scf.edge_report_ledger (node_id, record_id) VALUES ($1, gen_random_uuid())`, c.node)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `INSERT INTO scf.durability_reports (day, subject, expected, observed, status)
			    VALUES (current_date - 7, 'node:' || $1, 1, 1, 'balanced')`, c.node)
			return err
		})
		if (err == nil) != c.ok {
			t.Errorf("node %q: want ok=%v, got %s", c.node, c.ok, sqlState(err))
		}
	}
}

func inCtxSuper(t *testing.T, su *pgx.Conn, fn func(context.Context, pgx.Tx) error) error {
	t.Helper()
	ctx := context.Background()
	tx, err := su.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return fn(ctx, tx)
}

// C-117 (migration 0052_tombstone_admin_read): scf_app reads the tombstone list only for an operator_admin; an
// operator, a tenant member and the anonymous context read nothing, and scf_app can never write a tombstone.
func TestTombstonesReadableByOperatorAdminOnly(t *testing.T) {
	app := runtimeConn(t, "scf_app")
	for _, c := range []struct {
		name string
		c    Ctx
		some bool
	}{
		{"operator_admin", Ctx{Kind: "operator", Actor: uAdm, PlatformRole: "operator_admin"}, true},
		{"operator", Ctx{Kind: "operator", Actor: uOp, PlatformRole: "operator"}, false},
		{"tenant A user", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, false},
		{"anonymous", Ctx{}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := inCtx(t, app, c.c, func(ctx context.Context, tx pgx.Tx) error {
				var n int64
				if err := tx.QueryRow(ctx, `SELECT count(*) FROM scf.enrollment_tombstones`).Scan(&n); err != nil {
					return err
				}
				if (n > 0) != c.some {
					t.Errorf("read %d tombstones, want rows: %v", n, c.some)
				}
				if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
					_, err := sp.Exec(ctx, `UPDATE scf.enrollment_tombstones SET reason = reason`)
					return err
				}); code(err) != "42501" {
					t.Errorf("UPDATE by scf_app: want 42501, got %v", sqlState(err))
				}
				if err := savepoint(ctx, tx, func(sp pgx.Tx) error {
					_, err := sp.Exec(ctx, `INSERT INTO scf.enrollment_tombstones (kind, subject, tenant_id) VALUES ('host', 'x.example', $1)`, A)
					return err
				}); code(err) != "42501" {
					t.Errorf("INSERT by scf_app: want 42501, got %v", sqlState(err))
				}
				return nil
			})
			if err != nil {
				t.Fatal(sqlState(err))
			}
		})
	}
}
