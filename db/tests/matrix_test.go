// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Cross-tenant matrix (port of spikes/s03-rls-real-postgres/tests/t_matrix.py to the final text, C-112(12)).
// Relations are enumerated from the catalog — every table, partitioned table, partition and view of scf and
// scf_part — so a new table is covered without touching this file. For every runtime role and context (one
// transaction, context set by scf.set_tenant_ctx()), it counts visible rows of tenants B and C, tries to UPDATE and
// DELETE B's rows, tries to move one of A's rows to B and to INSERT a row of B (a copy of one of B's rows, ON CONFLICT
// DO NOTHING — RLS checks the new row before any conflict, so anything but a refusal is a hole; C-114). Run once
// through PgBouncer (transaction mode) and once on direct connections; scf_migrator (the owner, which holds the
// definer roles without INHERIT, C-114) is probed on direct connections only. Expected: zero everywhere, except the documented cross-tenant READS of named jobs.

// jobs of docs/data-model.md §6.3.
var jobs = []string{"partitions", "retention", "edge_snapshot", "web_rollup", "trust_scoring", "registry_sync",
	"domain_verification", "contract_verification", "onchain_correlation", "erasure", "tenant_purge", "public_metrics",
	"umami_reconcile", "durability_reconcile", "audit_verify", "audit_anchor", "stream_gc", "daily_seal"}

// refOnly: tenant_id is a reference there, not ownership (§15 G2/G9 allow-list).
var refOnly = map[string]bool{"auth_challenges": true, "enrollment_tombstones": true}

type relation struct {
	name, relname string
	kind          byte
	col           string // tenant_id or chain_id; "" for global relations
	insCols, bRow string // INSERT probe: insertable columns and one of B's rows as JSON ("" = no probe)
}

func relations(t testing.TB) []relation {
	t.Helper()
	rows, err := super(t).Query(context.Background(), `
	  SELECT c.oid::regclass::text, c.relname, c.relkind::text,
	         CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) THEN 'tenant_id'
	              WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'chain_id' AND NOT a.attisdropped) THEN 'chain_id'
	              ELSE '' END
	    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	   WHERE n.nspname IN ('scf', 'scf_part') AND c.relkind IN ('r', 'p', 'v') ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []relation
	for rows.Next() {
		var r relation
		var kind string
		if err := rows.Scan(&r.name, &r.relname, &kind, &r.col); err != nil {
			t.Fatal(err)
		}
		r.kind = kind[0]
		out = append(out, r)
	}
	rows.Close()
	su := super(t)
	for i, r := range out {
		if r.col != "tenant_id" || r.kind == 'v' || refOnly[r.relname] {
			continue
		}
		ctx := context.Background()
		if err := su.QueryRow(ctx, `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) FROM pg_attribute
		    WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attidentity <> 'a'`,
			r.name).Scan(&out[i].insCols); err != nil {
			t.Fatal(err)
		}
		var row *string
		if err := su.QueryRow(ctx, fmt.Sprintf(`SELECT to_jsonb(t)::text FROM %s t WHERE tenant_id = '%s' LIMIT 1`, r.name, B)).Scan(&row); err != nil &&
			err != pgx.ErrNoRows {
			t.Fatal(err)
		}
		if row != nil {
			out[i].bRow = *row
		}
	}
	return out
}

type probeResult struct {
	rel                    relation
	visible, written, move int64
	inserted               int64  // 1 when the INSERT of B's row was not refused
	insErr                 string // the INSERT probe's error when it was not a refusal (42501): inconclusive
	err                    string
}

// probe runs every check of one context in one transaction (savepoints per statement), always rolled back.
// set=false: the transaction never calls set_tenant_ctx (a fresh pooled connection with no context at all).
func probe(t *testing.T, rels []relation, role string, c Ctx, set, viaBouncer bool) []probeResult {
	t.Helper()
	ctx := context.Background()
	conn := connectTo(t, role, "scf", viaBouncer)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if set {
		if err := setCtx(ctx, tx, c); err != nil {
			t.Fatalf("set_tenant_ctx: %s", sqlState(err))
		}
	}
	out := make([]probeResult, 0, len(rels))
	for _, r := range rels {
		res := probeResult{rel: r}
		err := savepoint(ctx, tx, func(sp pgx.Tx) error {
			q := "SELECT count(*) FROM " + r.name
			if r.col != "" {
				q += fmt.Sprintf(" WHERE %s IN ('%s'::uuid, '%s'::uuid)", r.col, B, C)
			}
			return sp.QueryRow(ctx, q).Scan(&res.visible)
		})
		if err != nil {
			res.err = sqlState(err)
		}
		if r.col != "" && r.kind != 'v' {
			for _, stmt := range []string{
				fmt.Sprintf("UPDATE %s SET %s = %s WHERE %s = '%s'", r.name, r.col, r.col, r.col, B),
				fmt.Sprintf("DELETE FROM %s WHERE %s = '%s'", r.name, r.col, B),
			} {
				_ = savepoint(ctx, tx, func(sp pgx.Tx) error {
					tag, err := sp.Exec(ctx, stmt)
					if err == nil {
						res.written += tag.RowsAffected()
					}
					return err
				})
			}
			if r.col == "tenant_id" {
				// inserting a row of B must be refused (42501: privilege or WITH CHECK)
				if r.bRow != "" {
					err := savepoint(ctx, tx, func(sp pgx.Tx) error {
						_, err := sp.Exec(ctx, fmt.Sprintf(
							"INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s, $1::jsonb) ON CONFLICT DO NOTHING",
							r.name, r.insCols, r.insCols, r.name), r.bRow)
						return err
					})
					switch {
					case err == nil:
						res.inserted = 1
					case code(err) != "42501":
						res.insErr = sqlState(err)
					}
				}
				// moving one of A's rows into B must never succeed (WITH CHECK)
				_ = savepoint(ctx, tx, func(sp pgx.Tx) error {
					tag, err := sp.Exec(ctx, fmt.Sprintf(
						"UPDATE %s SET tenant_id = '%s' WHERE ctid = (SELECT ctid FROM %s WHERE tenant_id = '%s' LIMIT 1)",
						r.name, B, r.name, A))
					if err == nil {
						res.move += tag.RowsAffected()
					}
					return err
				})
			}
		}
		out = append(out, res)
	}
	return out
}

type matrixCase struct {
	id, role, label string
	c               Ctx
	set             bool
	crossReads      bool // documented cross-tenant reads (§6.3, §5); writes must still be zero
}

func matrixCases() []matrixCase {
	op := Ctx{Kind: "operator", Actor: uOp, PlatformRole: "operator"}
	key := Ctx{Kind: "op_key", Actor: "opkey0000001", KeyScopes: "web:read,api:read"}
	cs := []matrixCase{
		{"M1", "scf_app", "tenant A, actor user", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, true, false},
		{"M2", "scf_app", "no tenant (''), actor user of A: tenants/memberships via membership only", Ctx{Kind: "user", Actor: users[A]}, true, false},
		{"M3", "scf_app", "actor operator WITH tenant A set (C-17: no tenant row at all)", func() Ctx { c := op; c.Tenant = A; return c }(), true, false},
		{"M4", "scf_app", "anonymous", Ctx{Kind: "anonymous"}, true, false},
		{"M5", "scf_app", "op_key with tenant A set", func() Ctx { c := key; c.Tenant = A; return c }(), true, false},
		{"M5s", "scf_app", "system actor with tenant A (counter endpoint)", Ctx{Tenant: A, Kind: "system", Actor: "edge"}, true, false},
		{"M6", "scf_writer", "tenant A, actor writer", Ctx{Tenant: A, Kind: "writer", Actor: "writer"}, true, false},
		{"M7", "scf_writer", "writer, no tenant", Ctx{Kind: "writer", Actor: "writer"}, true, false},
		{"M8", "scf_metrics_ro", "op_key, tenant A set", func() Ctx { c := key; c.Tenant = A; return c }(), true, false},
		{"M9", "scf_metrics_ro", "operator, no tenant", op, true, false},
		{"M12", "scf_jobs", "no app.job, no tenant", Ctx{Kind: "job", Actor: "x"}, true, false},
	}
	for _, role := range []string{"scf_app", "scf_writer", "scf_jobs", "scf_metrics_ro"} {
		cs = append(cs, matrixCase{"M0." + role, role, "context never set (fresh pooled connection)", Ctx{}, false, false})
	}
	for _, j := range jobs {
		cs = append(cs, matrixCase{"M10." + j, "scf_jobs", "job " + j + ", tenant A", Ctx{Tenant: A, Kind: "job", Actor: j, Job: j}, true,
			j == "audit_verify" || j == "audit_anchor"})
	}
	for _, j := range []string{"erasure", "tenant_purge"} {
		cs = append(cs, matrixCase{"M11." + j, "scf_jobs", "job " + j + ", tenant UNSET (C-87: no cross-tenant read)",
			Ctx{Kind: "job", Actor: j, Job: j}, true, false})
	}
	// F1 (C-103): named jobs with no tenant may READ across tenants but never UPDATE/DELETE another tenant's rows.
	for _, j := range jobs {
		if j != "erasure" && j != "tenant_purge" {
			cs = append(cs, matrixCase{"M13." + j, "scf_jobs", "job " + j + ", tenant unset (F1)", Ctx{Kind: "job", Actor: j, Job: j}, true, true})
		}
	}
	// C-114 (finding 10): the owner reads and writes nothing of any tenant, whatever the context.
	cs = append(cs,
		matrixCase{"M14.none", "scf_migrator", "migrator, context never set", Ctx{}, false, false},
		matrixCase{"M14.operator", "scf_migrator", "migrator, operator_admin context", Ctx{Kind: "operator", Actor: uAdm, PlatformRole: "operator_admin"}, true, false},
		matrixCase{"M14.tenant", "scf_migrator", "migrator, tenant A context", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, true, false},
		matrixCase{"M14.job", "scf_migrator", "migrator, job audit_verify", Ctx{Kind: "job", Actor: "audit_verify", Job: "audit_verify"}, true, false})
	return cs
}

func TestCrossTenantMatrix(t *testing.T) {
	rels := relations(t)
	nTenant := 0
	for _, r := range rels {
		if r.col != "" && !refOnly[r.relname] {
			nTenant++
		}
	}
	t.Logf("%d relations enumerated from the catalog, %d carry tenant_id/chain_id", len(rels), nTenant)
	// precondition (M0 of S-03): B has rows in every tenant-owned base table
	su := super(t)
	for _, r := range rels {
		if r.col == "" || r.kind == 'v' || refOnly[r.relname] || strings.HasPrefix(r.name, "scf_part.") {
			continue
		}
		var n int64
		if err := su.QueryRow(context.Background(), fmt.Sprintf("SELECT count(*) FROM %s WHERE %s = '%s'", r.name, r.col, B)).Scan(&n); err != nil || n == 0 {
			t.Fatalf("precondition: tenant B has no row in %s (%v)", r.name, err)
		}
	}
	for _, via := range []struct {
		name    string
		bouncer bool
	}{{"pgbouncer", true}, {"direct", false}} {
		t.Run(via.name, func(t *testing.T) {
			for _, mc := range matrixCases() {
				if mc.role == "scf_migrator" && via.bouncer { // the owner never goes through PgBouncer
					continue
				}
				t.Run(mc.id, func(t *testing.T) {
					res := probe(t, rels, mc.role, mc.c, mc.set, via.bouncer)
					readable := 0
					var reads, writes, inconclusive []string
					for _, r := range res {
						if r.err == "" {
							readable++
						}
						if r.rel.col == "" || refOnly[r.rel.relname] {
							continue
						}
						if r.visible > 0 {
							reads = append(reads, fmt.Sprintf("%s:%d", r.rel.name, r.visible))
						}
						if r.written > 0 || r.move > 0 || r.inserted > 0 {
							writes = append(writes, fmt.Sprintf("%s:upd/del=%d,move=%d,insert=%d", r.rel.name, r.written, r.move, r.inserted))
						}
						if r.insErr != "" {
							inconclusive = append(inconclusive, r.rel.name+": "+r.insErr)
						}
					}
					if len(writes) > 0 {
						t.Errorf("%s %s (%s): other tenants' rows writable: %v", mc.role, mc.label, mc.id, writes)
					}
					if !mc.crossReads && len(reads) > 0 {
						t.Errorf("%s %s (%s): foreign rows visible: %v", mc.role, mc.label, mc.id, reads)
					}
					if len(inconclusive) > 0 {
						t.Errorf("%s %s (%s): INSERT probe neither refused nor allowed: %v", mc.role, mc.label, mc.id, inconclusive)
					}
					t.Logf("%s %s: %d/%d relations readable, cross-tenant reads %d (allowed=%v), writes 0",
						mc.role, mc.label, readable, len(res), len(reads), mc.crossReads)
				})
			}
		})
	}
}

// The operator context sees no tenant row in a base table (C-17) and the four runtime roles cannot read partitions.
func TestPartitionsUnreachable(t *testing.T) {
	var part string
	if err := super(t).QueryRow(context.Background(),
		`SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = 'scf.api_metrics_1d'::regclass LIMIT 1`).Scan(&part); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"scf_app", "scf_writer", "scf_jobs", "scf_metrics_ro"} {
		conn := runtimeConn(t, role)
		_, err := conn.Exec(context.Background(), "SELECT count(*) FROM "+part)
		if code(err) != "42501" {
			t.Errorf("%s reading partition %s directly: want 42501, got %q", role, part, sqlState(err))
		}
	}
}

// The matrix itself must fail on a broken schema: an F1 regression (named job without a tenant deletes another
// tenant's rows) and a read hole (backstop gone, permissive policy opened). Breakages are committed for the probe
// and restored afterwards.
func TestCrossTenantMatrixCatchesHoles(t *testing.T) {
	rels := relations(t)
	su := super(t)
	find := func(res []probeResult, name string) probeResult {
		for _, r := range res {
			if r.rel.name == name {
				return r
			}
		}
		t.Fatalf("relation %s not probed", name)
		return probeResult{}
	}

	t.Run("F1 regression", func(t *testing.T) {
		mustExec(t, su, `DROP POLICY tenant_backstop_delete ON scf.web_daily_totals`)
		t.Cleanup(func() {
			mustExec(t, su, `CREATE POLICY tenant_backstop_delete ON scf.web_daily_totals AS RESTRICTIVE FOR DELETE
			  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
			  USING (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()))`)
		})
		res := probe(t, rels, "scf_jobs", Ctx{Kind: "job", Actor: "web_rollup", Job: "web_rollup"}, true, true)
		if r := find(res, "scf.web_daily_totals"); r.written == 0 {
			t.Errorf("matrix missed the F1 hole: web_rollup without tenant deleted %d of B's rows", r.written)
		}
	})
	t.Run("read hole", func(t *testing.T) {
		mustExec(t, su, `ALTER POLICY tenant_backstop ON scf.sites USING (true)`)
		mustExec(t, su, `ALTER POLICY app_select ON scf.sites USING (true)`)
		t.Cleanup(func() {
			mustExec(t, su, `ALTER POLICY tenant_backstop ON scf.sites
			  USING (((tenant_id = (SELECT scf.current_tenant())) AND (SELECT scf.tenant_ctx_ok())) OR (SELECT scf.cross_tenant_read_ok()))`)
			mustExec(t, su, `ALTER POLICY app_select ON scf.sites USING (tenant_id = (SELECT scf.current_tenant()))`)
		})
		res := probe(t, rels, "scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, true, true)
		if r := find(res, "scf.sites"); r.visible == 0 {
			t.Errorf("matrix missed the read hole on scf.sites")
		}
	})
	// (scf.sites has column-level INSERT grants since 0067, so the probe's all-columns INSERT is refused by privilege
	// there; share_keys keeps a table-level INSERT grant and shows that the probe reaches RLS.)
	t.Run("insert hole", func(t *testing.T) {
		mustExec(t, su, `ALTER POLICY tenant_backstop ON scf.share_keys WITH CHECK (true)`)
		mustExec(t, su, `ALTER POLICY app_insert ON scf.share_keys WITH CHECK (true)`)
		t.Cleanup(func() {
			mustExec(t, su, `ALTER POLICY tenant_backstop ON scf.share_keys
			  WITH CHECK ((tenant_id = (SELECT scf.current_tenant())) AND (SELECT scf.tenant_ctx_ok()))`)
			mustExec(t, su, `ALTER POLICY app_insert ON scf.share_keys WITH CHECK (tenant_id = (SELECT scf.current_tenant()))`)
		})
		res := probe(t, rels, "scf_app", Ctx{Tenant: A, Kind: "user", Actor: users[A]}, true, true)
		if r := find(res, "scf.share_keys"); r.inserted == 0 {
			t.Errorf("matrix missed the INSERT hole on scf.share_keys (err %q)", r.insErr)
		}
	})
	t.Run("migrator inherits a definer role", func(t *testing.T) {
		mustExec(t, su, `GRANT scf_op_definer TO scf_migrator WITH INHERIT TRUE`)
		t.Cleanup(func() { mustExec(t, su, `GRANT scf_op_definer TO scf_migrator WITH INHERIT FALSE`) })
		res := probe(t, rels, "scf_migrator", Ctx{}, false, false)
		if r := find(res, "scf.tenants"); r.visible == 0 {
			t.Errorf("matrix missed the migrator reading through scf_op_definer")
		}
	})
	// restored exactly: the gates are clean again
	gates := loadGates(t)
	for _, id := range []string{"G2", "G7", "G8"} {
		if rows, err := runGate(t, context.Background(), migrator(t), gates[id]); err != nil || len(rows) > 0 {
			t.Errorf("after restore %s: %v %v", id, rows, err)
		}
	}
}

// Cross-tenant matrix, SECURITY DEFINER half. A definer
// function bypasses RLS, so its own checks are the boundary. Every scf_definer function (enumerated from the catalog;
// trigger functions excepted, they cannot be called) is either tenant-scoped — called with ANOTHER tenant's id under
// tenant A's context, and with A's own id under every context that is not a tenant context (operator, op_key, pub_key,
// anonymous with A set: C-17), each call refused with 42501 and nothing changed — or public by design (listed with its
// reason; their status filters are tested in TestPublicDefinersHideInactiveTenants). A new function fails this test
// until it has a row here.
func TestCrossTenantDefinerMatrix(t *testing.T) {
	ctx := context.Background()
	hostA, hostB := slugOf(A)+".example.org", slugOf(B)+".example.org"
	type call struct {
		role, sql string
		args      []any
		job       string // app.job of the call's context (scf_jobs only)
	}
	tenantScoped := map[string]struct{ foreign, own call }{
		"scf.claim_host(text,uuid,uuid)": {
			call{"scf_jobs", `SELECT scf.claim_host($1, $2, $3)`, []any{hostB, B, uid(B, 2)}, "domain_verification"},
			call{"scf_jobs", `SELECT scf.claim_host($1, $2, $3)`, []any{hostA, A, uid(A, 2)}, "domain_verification"}},
		"scf.release_host(text,uuid)": {
			call{"scf_app", `SELECT scf.release_host($1, $2)`, []any{hostB, B}, ""},
			call{"scf_app", `SELECT scf.release_host($1, $2)`, []any{hostA, A}, ""}},
		"scf.release_domain_claim(uuid,uuid)": {
			call{"scf_app", `SELECT scf.release_domain_claim($1, $2)`, []any{B, uid(B, 2)}, ""},
			call{"scf_app", `SELECT scf.release_domain_claim($1, $2)`, []any{A, uid(A, 2)}, ""}},
		"scf.write_removal_tombstones(uuid)": {
			call{"scf_app", `SELECT scf.write_removal_tombstones($1)`, []any{B}, ""},
			call{"scf_app", `SELECT scf.write_removal_tombstones($1)`, []any{A}, ""}},
		"scf.accept_invitation(bytea,uuid)": { // the user is the actor; nobody accepts for someone else
			call{"scf_app", `SELECT scf.accept_invitation($1, $2)`, []any{sha256Bytes("inv" + B), users[B]}, ""},
			call{"scf_app", `SELECT scf.accept_invitation($1, $2)`, []any{sha256Bytes("inv" + A), users[A]}, ""}},
		"scf.job_queue(text)": { // work discovery only without a tenant (C-87)
			call{"scf_jobs", `SELECT * FROM scf.job_queue('erasure')`, nil, "erasure"},
			call{"scf_jobs", `SELECT * FROM scf.job_queue('tenant_purge')`, nil, "tenant_purge"}},
	}
	publicByDesign := map[string]string{
		"scf.is_tombstoned(text,text)":           "boolean over tombstones, which hold no tenant data (C-64)",
		"scf.lookup_share_key(text)":             "pub key verification before the tenant is known; returns only the named key's hash",
		"scf.lookup_footprint_key(text)":         "reg key verification before the tenant is known; returns only the named key's hash (0081)",
		"scf.public_snapshot(uuid)":              "signed snapshot verification for anyone holding the id; active/suspended tenants only",
		"scf.public_metrics_document(text,uuid)": "metrics_endpoint: public tenants, or the tenant of a verified pub key",
		"scf.public_snapshot_list(text)":         "the public append-only snapshot list of an active/suspended tenant",
		"scf.public_seal_proof(uuid)":            "inclusion proofs for whoever names the snapshot id; active/suspended tenants only",
		"scf.writer_tenant_gone()":               "no tenant argument: answers for the context's own tenant, writer actor only (TestWriterTenantGone)",
		"scf.registry_claimants(uuid)":           "count of tenants claiming a public registry project; signed-in users only, names no tenant (TestRegistryOnboarding0073)",
	}
	fns, err := queryStrings(ctx, super(t), `SELECT p.oid::regprocedure::text FROM pg_proc p
	    WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'scf_definer' AND p.prorettype <> 'trigger'::regtype ORDER BY 1`)
	if err != nil {
		t.Fatal(sqlState(err))
	}
	for _, f := range fns {
		_, scoped := tenantScoped[f]
		if _, pub := publicByDesign[f]; !scoped && !pub {
			t.Errorf("definer function %s is in neither list of the definer matrix", f)
		}
	}
	claims := func() string {
		rows, err := queryStrings(ctx, super(t), `SELECT host || '=' || tenant_id || '/' || domain_id FROM scf.host_claims ORDER BY 1`)
		if err != nil {
			t.Fatal(sqlState(err))
		}
		return strings.Join(rows, ",")
	}
	before := claims()
	run := func(t *testing.T, c call, cx Ctx, viaBouncer bool) {
		t.Helper()
		cx.Job = c.job
		err := inCtx(t, connectTo(t, c.role, "scf", viaBouncer), cx, func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(ctx, c.sql, c.args...)
			return err
		})
		if code(err) != "42501" {
			t.Errorf("%s %q under %s/%s (tenant %s): want 42501, got %q", c.role, c.sql, cx.Kind, cx.PlatformRole, cx.Tenant, sqlState(err))
		}
	}
	for _, via := range []struct {
		name    string
		bouncer bool
	}{{"pgbouncer", true}, {"direct", false}} {
		t.Run(via.name, func(t *testing.T) {
			for name, c := range tenantScoped {
				t.Run(name, func(t *testing.T) {
					// another tenant's id under tenant A's own context
					kind, actor := "user", users[A]
					if c.foreign.role == "scf_jobs" {
						kind, actor = "job", c.foreign.job
					}
					run(t, c.foreign, Ctx{Tenant: A, Kind: kind, Actor: actor}, via.bouncer)
					// A's own id under contexts that are not tenant contexts (C-17)
					for _, cx := range []Ctx{
						{Tenant: A, Kind: "operator", Actor: uAdm, PlatformRole: "operator_admin"},
						{Tenant: A, Kind: "op_key", Actor: "opkey0000001", KeyScopes: "web:read,api:read"},
						{Tenant: A, Kind: "pub_key", Actor: alnum(A, 4, 12)},
						{Tenant: A, Kind: "anonymous"},
					} {
						run(t, c.own, cx, via.bouncer)
					}
				})
			}
		})
	}
	if after := claims(); after != before {
		t.Errorf("host claims changed by refused calls:\nbefore %s\nafter  %s", before, after)
	}
}
