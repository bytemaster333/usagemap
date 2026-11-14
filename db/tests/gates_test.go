// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Gates G1–G12 of docs/data-model.md §15 (as amended by C-103 and C-114), loaded from db/gates/*.sql — the same files
// the db-migrate image runs with `migrate.sh gates`. Each gate must return zero rows on the migrated + seeded
// database, and at least one row for each deliberate breakage below (applied by the superuser in a rolled-back
// transaction).

// gate: list is the allow-list file a gate takes as its one parameter ($1), or "".
type gate struct{ id, file, sql, list string }

func loadGates(t testing.TB) map[string]gate {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dbDir, "gates", "g*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no gate files: %v", err)
	}
	out := map[string]gate{}
	for _, f := range files {
		base := filepath.Base(f)
		id := strings.ToUpper(strings.SplitN(base, "_", 2)[0]) // g05 → G05
		id = "G" + strings.TrimLeft(id[1:], "0")               // G05 → G5, G08R → G8R
		sql := readFile(t, f)
		list := ""
		for param, file := range map[string]string{":'definer_allowlist'": "definer-allowlist.txt", ":'rls_allowlist'": "rls-allowlist.txt"} {
			if strings.Contains(sql, param) {
				sql, list = strings.ReplaceAll(sql, param, "$1"), file
			}
		}
		out[id] = gate{id: id, file: base, sql: strings.TrimRight(strings.TrimSpace(sql), ";"), list: list}
	}
	for _, want := range []string{"G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G8R", "G9", "G10", "G11", "G12"} {
		if _, ok := out[want]; !ok {
			t.Fatalf("gate %s missing in db/gates", want)
		}
	}
	return out
}

// definerAllowlist reads db/definer-allowlist.txt (regprocedure per line, # comments).
func definerAllowlist(t testing.TB) []string { return readList(t, "definer-allowlist.txt") }

// readList reads an allow-list file of db/ (one entry per line, # comments).
func readList(t testing.TB, name string) []string {
	t.Helper()
	f, err := os.Open(filepath.Join(dbDir, name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" && !strings.HasPrefix(l, "#") {
			out = append(out, l)
		}
	}
	return out
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func runGate(t testing.TB, ctx context.Context, q querier, g gate) ([]string, error) {
	t.Helper()
	if g.list != "" {
		return queryStrings(ctx, q, g.sql, readList(t, g.list))
	}
	return queryStrings(ctx, q, g.sql)
}

func TestGatesClean(t *testing.T) {
	gates := loadGates(t)
	allow := definerAllowlist(t)
	if len(allow) != 50 { // 47 + 0081 lookup_footprint_key + 0082 op_protocol_usage + 0087 op_enrolment_summary
		t.Fatalf("definer allow-list has %d entries, data-model.md §12 says 50", len(allow))
	}
	m := migrator(t)
	ctx := context.Background()
	ids := make([]string, 0, len(gates))
	for id := range gates {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		t.Run(id, func(t *testing.T) {
			rows, err := runGate(t, ctx, m, gates[id])
			if err != nil {
				t.Fatalf("%s: %s", gates[id].file, sqlState(err))
			}
			if len(rows) > 0 {
				t.Errorf("%s returns %d row(s) on the clean database: %v", gates[id].file, len(rows), rows)
			}
		})
	}
}

// One deliberate breakage per gate (the S-03 set), plus the three blind spots S-03 found (C-103) and further cases
// for the amended gates. Every breakage must make its gate return at least one row.
var breakages = []struct {
	gate, name, ddl string
}{
	{"G1", "partition created by plain PARTITION OF (no RLS/FORCE)",
		`CREATE TABLE scf_part.api_metrics_1m_20310101 PARTITION OF scf.api_metrics_1m
		   FOR VALUES FROM ('2031-01-01 00:00+00') TO ('2031-01-02 00:00+00')`},
	{"G1", "FORCE removed from an existing tenant table", `ALTER TABLE scf.sites NO FORCE ROW LEVEL SECURITY`},
	{"G1", "materialized view in schema scf", `CREATE MATERIALIZED VIEW scf.g1_mv AS SELECT tenant_id FROM scf.sites`},
	{"G2", "new tenant table with ENABLE+FORCE but no backstop",
		`CREATE TABLE scf.g2_bad (tenant_id uuid PRIMARY KEY); ALTER TABLE scf.g2_bad ENABLE ROW LEVEL SECURITY;
		 ALTER TABLE scf.g2_bad FORCE ROW LEVEL SECURITY`},
	{"G2", "F1 regression: tenant_backstop_delete dropped from a table", `DROP POLICY tenant_backstop_delete ON scf.web_daily_totals`},
	{"G2", "F1 regression on tenants (added by hand, C-110(9))", `DROP POLICY tenant_backstop_delete ON scf.tenants`},
	{"G2", "backstop made PERMISSIVE", `DROP POLICY tenant_backstop ON scf.share_keys;
		CREATE POLICY tenant_backstop ON scf.share_keys FOR ALL TO scf_app USING (true)`},
	{"G3", "GRANT SELECT on an existing partition",
		`DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits
		   WHERE inhparent = 'scf.api_metrics_1h'::regclass LIMIT 1; EXECUTE format('GRANT SELECT ON %s TO scf_app', p); END $$`},
	{"G3", "TRUNCATE granted to a runtime role", `GRANT TRUNCATE ON scf.sites TO scf_app`},
	{"G3", "scf_metrics_ro granted SELECT on a tenant table (C-17)", `GRANT SELECT ON scf.web_daily_totals TO scf_metrics_ro`},
	{"G3", "table in schema public readable by a runtime role (C-103 blind spot)",
		`CREATE TABLE public.g3_leak (tenant_id uuid); GRANT USAGE ON SCHEMA public TO scf_app; GRANT SELECT ON public.g3_leak TO scf_app`},
	{"G4", "view without security_invoker in scf",
		`CREATE VIEW scf.g4_bad AS SELECT tenant_id, site_id FROM scf.sites; GRANT SELECT ON scf.g4_bad TO scf_app`},
	{"G4", "owner-semantics view in schema public over scf.sites (C-103 blind spot)",
		`CREATE VIEW public.g4_outside AS SELECT tenant_id FROM scf.sites; GRANT USAGE ON SCHEMA public TO scf_app;
		 GRANT SELECT ON public.g4_outside TO scf_app`},
	{"G5", "definer function without search_path, EXECUTE left to PUBLIC",
		`CREATE FUNCTION scf.g5_bad() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1::bigint $$`},
	{"G5", "UNLISTED definer function with search_path, no PUBLIC EXECUTE (C-103 blind spot)",
		`CREATE FUNCTION scf.g5_sneaky() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
		   AS $$ SELECT count(*) FROM scf.sites $$; REVOKE ALL ON FUNCTION scf.g5_sneaky() FROM PUBLIC;
		 GRANT EXECUTE ON FUNCTION scf.g5_sneaky() TO scf_app`},
	{"G5", "unlisted definer function in another schema",
		`CREATE FUNCTION scf_admin.g5_other() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$;
		 REVOKE ALL ON FUNCTION scf_admin.g5_other() FROM PUBLIC`},
	{"G5", "listed op_* function moved to another owner", `ALTER FUNCTION scf.op_lift_tombstone(uuid) OWNER TO scf_definer`},
	{"G5", "listed function re-opened to PUBLIC", `GRANT EXECUTE ON FUNCTION scf.lookup_share_key(text) TO PUBLIC`},
	{"G5", "audit_chain_append() moved to another owner", `ALTER FUNCTION scf.audit_chain_append() OWNER TO scf_definer`},
	{"G6", "extra LOGIN role with BYPASSRLS", `CREATE ROLE g6_bad LOGIN BYPASSRLS`},
	{"G6", "scf_maintenance given LOGIN", `ALTER ROLE scf_maintenance LOGIN`},
	{"G7", "a partition loses one parent policy",
		`DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits
		   WHERE inhparent = 'scf.api_metrics_1d'::regclass LIMIT 1; EXECUTE format('DROP POLICY app_select ON %s', p); END $$`},
	{"G7", "parent policy changed but partitions not re-applied (CR-31)",
		`ALTER POLICY app_select ON scf.web_hourly_totals USING (tenant_id = (SELECT scf.current_tenant()) AND true)`},
	{"G7", "partition attached from schema public without policies",
		`CREATE TABLE public.g7_outside (LIKE scf.api_metrics_1m INCLUDING CONSTRAINTS);
		 ALTER TABLE scf.api_metrics_1m ATTACH PARTITION public.g7_outside FOR VALUES FROM ('2031-01-01 00:00+00') TO ('2031-01-02 00:00+00')`},
	{"G8", "LOGIN role made member of scf_definer", `GRANT scf_definer TO scf_app`},
	{"G8", "LOGIN role made member of scf_audit_definer", `GRANT scf_audit_definer TO scf_jobs`},
	{"G9", "tenant table whose PK does not start with tenant_id",
		`CREATE TABLE scf.g9_bad (id bigint, tenant_id uuid NOT NULL, PRIMARY KEY (id, tenant_id))`},
	{"G10", "single-column FK to sites(site_id)",
		`CREATE TABLE scf.g10_bad (tenant_id uuid NOT NULL, site_id uuid REFERENCES scf.sites (site_id), PRIMARY KEY (tenant_id))`},

	// C-114 (G1 review, finding 16): the gates compare what they used to check only for presence, scan every
	// non-system schema and every role.
	{"G1", "table without RLS in a new schema", `CREATE SCHEMA g1_other; CREATE TABLE g1_other.t (x int)`},
	{"G1", "table without RLS in scf_admin", `CREATE TABLE scf_admin.g1_bad (x int)`},
	{"G2", "backstop opened: USING (true)", `ALTER POLICY tenant_backstop ON scf.share_keys USING (true)`},
	{"G2", "backstop WITH CHECK opened", `ALTER POLICY tenant_backstop ON scf.sites WITH CHECK (true)`},
	{"G2", "backstop narrowed to one role (scf_jobs no longer bound)", `ALTER POLICY tenant_backstop ON scf.sites TO scf_app`},
	{"G2", "delete backstop opened: USING (true)", `ALTER POLICY tenant_backstop_delete ON scf.web_daily_totals USING (true)`},
	{"G2", "tenants backstop lost its membership branch condition",
		`ALTER POLICY tenant_backstop ON scf.tenants USING ((SELECT scf.cross_tenant_read_ok()) OR true)`},
	{"G2", "backstop on a partition differs (scf_part)",
		`DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits
		   WHERE inhparent = 'scf.api_metrics_1d'::regclass LIMIT 1; EXECUTE format('ALTER POLICY tenant_backstop ON %s USING (true)', p); END $$`},
	{"G2", "tenant table without backstops in another schema",
		`CREATE TABLE scf_admin.g2_other (tenant_id uuid PRIMARY KEY); ALTER TABLE scf_admin.g2_other ENABLE ROW LEVEL SECURITY;
		 ALTER TABLE scf_admin.g2_other FORCE ROW LEVEL SECURITY`},
	{"G3", "column-level SELECT for scf_metrics_ro on a tenant table", `GRANT SELECT (tenant_id) ON scf.web_daily_totals TO scf_metrics_ro`},
	{"G3", "column-level UPDATE on a partition",
		`DO $$ DECLARE p regclass; BEGIN SELECT inhrelid::regclass INTO p FROM pg_inherits
		   WHERE inhparent = 'scf.api_metrics_1h'::regclass LIMIT 1; EXECUTE format($q$GRANT UPDATE (tenant_id) ON %s TO scf_writer$q$, p); END $$`},
	{"G3", "scf_app may UPDATE tenants.purged_at (lifecycle column)", `GRANT UPDATE (purged_at) ON scf.tenants TO scf_app`},
	{"G3", "scf_jobs may UPDATE tenants.purge_after (lifecycle column)", `GRANT UPDATE (purge_after) ON scf.tenants TO scf_jobs`},
	{"G3", "scf_app may INSERT tenants.is_canary", `GRANT INSERT (is_canary) ON scf.tenants TO scf_app`},
	{"G3", "new LOGIN role with SELECT on a tenant table", `CREATE ROLE g3_new LOGIN; GRANT SELECT ON scf.sites TO g3_new`},
	{"G3", "column grant to a new role", `CREATE ROLE g3_col NOLOGIN; GRANT SELECT (tenant_id) ON scf.sites TO g3_col`},
	{"G3", "table in scf_admin readable by a runtime role",
		`CREATE TABLE scf_admin.g3_leak (x int); GRANT USAGE ON SCHEMA scf_admin TO scf_app; GRANT SELECT ON scf_admin.g3_leak TO scf_app`},
	{"G4", "owner-semantics view in a new schema usable by a new role",
		`CREATE SCHEMA g4_other; CREATE VIEW g4_other.v AS SELECT tenant_id FROM scf.sites; CREATE ROLE g4_new LOGIN;
		 GRANT USAGE ON SCHEMA g4_other TO g4_new; GRANT SELECT ON g4_other.v TO g4_new`},
	{"G5", "listed definer function with a widened search_path",
		`ALTER FUNCTION scf.lookup_share_key(text) SET search_path = public, pg_catalog, pg_temp`},
	{"G5", "listed definer function with an extra setting",
		`ALTER FUNCTION scf.lookup_share_key(text) SET row_security = off`},
	{"G5", "non-op definer function moved to scf_op_definer", `ALTER FUNCTION scf.lookup_share_key(text) OWNER TO scf_op_definer`},
	{"G5", "non-op definer function moved to the migrator", `ALTER FUNCTION scf.accept_invitation(bytea, uuid) OWNER TO scf_migrator`},
	{"G5", "partition function moved to scf_definer", `ALTER FUNCTION scf.ensure_partitions() OWNER TO scf_definer`},
	{"G6", "CREATEROLE on a runtime role", `ALTER ROLE scf_app CREATEROLE`},
	{"G6", "CREATEDB on the migrator", `ALTER ROLE scf_migrator CREATEDB`},
	{"G6", "REPLICATION on a new role", `CREATE ROLE g6_repl NOLOGIN REPLICATION`},
	{"G6", "replicator with CREATEDB besides REPLICATION (C-120)", `CREATE ROLE replicator LOGIN REPLICATION CREATEDB`},
	{"G6", "replicator with CREATEROLE besides REPLICATION (C-120)", `CREATE ROLE replicator LOGIN REPLICATION CREATEROLE`},
	{"G6", "replicator with BYPASSRLS besides REPLICATION (C-120)", `CREATE ROLE replicator LOGIN REPLICATION BYPASSRLS`},
	{"G6", "REPLICATION on a role with another name (C-120)", `CREATE ROLE replicator2 LOGIN REPLICATION`},
	{"G8", "migrator inherits a definer role again (finding 10)", `GRANT scf_op_definer TO scf_migrator WITH INHERIT TRUE`},
	{"G8", "migrator inherits pg_read_all_data", `GRANT pg_read_all_data TO scf_migrator`},
	{"G8", "LOGIN role member of a definer role through an intermediate role",
		`CREATE ROLE g8_mid NOLOGIN; GRANT scf_definer TO g8_mid; GRANT g8_mid TO scf_writer`},
	{"G8", "migrator inherits a runtime role", `GRANT scf_app TO scf_migrator`},
	{"G9", "tenant table with a wrong PK in another schema",
		`CREATE TABLE scf_admin.g9_bad (id bigint, tenant_id uuid NOT NULL, PRIMARY KEY (id, tenant_id))`},
	{"G10", "single-column FK from another schema",
		`CREATE TABLE scf_admin.g10_bad (tenant_id uuid NOT NULL, site_id uuid REFERENCES scf.sites (site_id), PRIMARY KEY (tenant_id))`},
	{"G11", "new global table in scf, not reviewed", `CREATE TABLE scf.g11_global (id int PRIMARY KEY)`},
	{"G11", "global table in another schema", `CREATE TABLE scf_admin.g11_global (id int PRIMARY KEY)`},
	{"G11", "listed table dropped", `DROP TABLE scf.hist_exp3_map CASCADE`},

	// G12: nothing that runs with its owner's rights is owned by a
	// superuser or a BYPASSRLS role, and every definer function fixes its search_path. (The breakage DDL runs as the
	// superuser, so an object it creates is superuser-owned.)
	{"G12", "definer function owned by the superuser (in a schema G5 does not police the owner of)",
		`CREATE FUNCTION scf_admin.g12_su() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$`},
	{"G12", "listed definer function handed to the BYPASSRLS backup role", `ALTER FUNCTION scf.lookup_share_key(text) OWNER TO scf_maintenance`},
	{"G12", "definer function owned by a superuser in schema public",
		`CREATE FUNCTION public.g12_pub() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$`},
	{"G12", "definer function without a search_path (non-superuser owner)",
		`CREATE FUNCTION scf_admin.g12_nopath() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
		 ALTER FUNCTION scf_admin.g12_nopath() OWNER TO scf_definer`},
	{"G12", "owner-semantics view owned by the superuser", `CREATE VIEW scf_admin.g12_v AS SELECT 1 AS x`},
	{"G12", "materialized view owned by the superuser", `CREATE MATERIALIZED VIEW scf_admin.g12_mv AS SELECT 1 AS x`},
}

func TestGatesCatchBreakage(t *testing.T) {
	gates := loadGates(t)
	su := super(t)
	ctx := context.Background()
	for _, b := range breakages {
		t.Run(b.gate+"/"+b.name, func(t *testing.T) {
			tx, err := su.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, b.ddl); err != nil {
				t.Fatalf("breakage DDL failed: %s", sqlState(err))
			}
			rows, err := runGate(t, ctx, tx, gates[b.gate])
			if err != nil {
				t.Fatalf("gate %s: %s", b.gate, sqlState(err))
			}
			if len(rows) == 0 {
				t.Errorf("gate %s (%s) did NOT catch: %s", b.gate, gates[b.gate].file, b.name)
			} else {
				t.Logf("%s caught: %v", b.gate, rows)
			}
		})
	}
}

// C-120: the HA replication role `replicator` (LOGIN REPLICATION, nothing else) is the one REPLICATION role G6 allows.
func TestGateG6AllowsPlainReplicator(t *testing.T) {
	ctx := context.Background()
	tx, err := super(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `CREATE ROLE replicator LOGIN REPLICATION`); err != nil {
		t.Fatal(sqlState(err))
	}
	if rows, err := runGate(t, ctx, tx, loadGates(t)["G6"]); err != nil || len(rows) != 0 {
		t.Errorf("G6 with a plain replicator: %v %s", rows, sqlState(err))
	}
}

// G11 (G2 companion) is a gate file now, run by `migrate.sh gates` as well; its allow-list does not rot.
func TestGateG11GlobalTables(t *testing.T) {
	g := loadGates(t)["G11"]
	if g.list != "rls-allowlist.txt" {
		t.Fatalf("G11 must take db/rls-allowlist.txt, got %q", g.list)
	}
	if rows, err := runGate(t, context.Background(), migrator(t), g); err != nil || len(rows) > 0 {
		t.Errorf("G11 on the clean database: %v %v", rows, err)
	}
	if n := len(readList(t, "rls-allowlist.txt")); n < 15 {
		t.Errorf("rls-allowlist.txt has %d entries", n)
	}
}

func mustTx(t testing.TB, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %q: %s", firstLine(sql), sqlState(err))
	}
}

// G8 runtime half (C-103): pg_stat_statements shows a session-level SET app.* and a driver's direct
// set_config(…, false) of a runtime role (recorded as `SELECT set_config($1, $2, $3)`), but not the wrapper.
func TestGateG8Runtime(t *testing.T) {
	g := loadGates(t)["G8R"]
	su := super(t)
	m := migrator(t)
	ctx := context.Background()
	reset := func() { mustExec(t, su, `SELECT pg_stat_statements_reset()`) }

	// clean: context set through the wrapper only (through PgBouncer, as the services do)
	reset()
	app := runtimeConn(t, "scf_app")
	if err := inCtx(t, app, Ctx{Tenant: A, Kind: "user", Actor: users[A]}, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `SELECT count(*) FROM scf.sites`)
		return err
	}); err != nil {
		t.Fatal(sqlState(err))
	}
	if rows, err := runGate(t, ctx, m, g); err != nil || len(rows) > 0 {
		t.Errorf("G8 runtime flags the wrapper: rows=%v err=%v", rows, err)
	}

	cases := []struct{ name, sql string }{
		{"session SET app.tenant_id", `SET app.tenant_id = '` + A + `'`},
		{"SET LOCAL app.tenant_id", `BEGIN; SET LOCAL app.tenant_id = '` + A + `'; COMMIT`},
		{"RESET app.tenant_id", `RESET app.tenant_id`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reset()
			conn := connectTo(t, "scf_app", "scf", false) // direct: a session SET through PgBouncer would leak (S-03 T5)
			if _, err := conn.Exec(ctx, c.sql); err != nil {
				t.Fatal(sqlState(err))
			}
			_, _ = conn.Exec(ctx, `RESET app.tenant_id`)
			if rows, err := runGate(t, ctx, m, g); err != nil || len(rows) == 0 {
				t.Errorf("G8 runtime missed %q: rows=%v err=%v", c.name, rows, err)
			}
		})
	}
	t.Run("driver set_config(…, false) (C-103 blind spot)", func(t *testing.T) {
		reset()
		conn := connectTo(t, "scf_writer", "scf", false)
		if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, A); err != nil {
			t.Fatal(sqlState(err))
		}
		_, _ = conn.Exec(ctx, `RESET app.tenant_id`)
		if rows, err := runGate(t, ctx, m, g); err != nil || len(rows) == 0 {
			t.Errorf("G8 runtime missed a direct set_config: rows=%v err=%v", rows, err)
		}
	})
	reset()
}
