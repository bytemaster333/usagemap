// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

// db/umami/scf_ro.sql (docs/data-model.md §16, C-109, C-112(12)) run by the db-migrate image as `umami-views` in a
// stand-in `umami` database whose tables carry the Umami v3.5.0 columns the SQL touches. The contract test against
// the real pinned Umami image (column names and types, rollup SQL vs /stats) belongs to the Umami integration suite.

// Columns as in Umami v3.5.0 (prisma/migrations, PostgreSQL) for the six tables of §16.1 / §16.3 (revenue: prisma
// migration 13_add_revenue).
const umamiTables = `
SET ROLE umami_app;
CREATE TABLE public.session (session_id uuid PRIMARY KEY, website_id uuid NOT NULL, browser varchar(20), os varchar(20),
  device varchar(20), screen varchar(11), language varchar(35), country char(2), region varchar(20), city varchar(50),
  distinct_id varchar(50), created_at timestamptz(6) DEFAULT now());
CREATE TABLE public.website_event (event_id uuid PRIMARY KEY, website_id uuid NOT NULL, session_id uuid NOT NULL,
  visit_id uuid NOT NULL, created_at timestamptz(6) DEFAULT now(), url_path varchar(500) NOT NULL, url_query varchar(500),
  referrer_path varchar(500), referrer_query varchar(500), referrer_domain varchar(500), page_title varchar(500),
  hostname varchar(100), event_type integer NOT NULL DEFAULT 1, event_name varchar(50), tag varchar(50));
CREATE TABLE public.event_data (event_data_id uuid PRIMARY KEY, website_id uuid NOT NULL, website_event_id uuid NOT NULL,
  data_key varchar(500) NOT NULL, string_value varchar(500), number_value numeric(19,4), date_value timestamptz(6),
  data_type integer NOT NULL, created_at timestamptz(6) DEFAULT now());
CREATE TABLE public.session_data (session_data_id uuid PRIMARY KEY, website_id uuid NOT NULL, session_id uuid NOT NULL,
  data_key varchar(500) NOT NULL, string_value varchar(500), number_value numeric(19,4), date_value timestamptz(6),
  data_type integer NOT NULL, distinct_id varchar(50), created_at timestamptz(6) DEFAULT now());
CREATE TABLE public.session_link (session_id uuid NOT NULL, website_id uuid NOT NULL, created_at timestamptz(6) DEFAULT now());
CREATE TABLE public.revenue (revenue_id uuid PRIMARY KEY, website_id uuid NOT NULL, session_id uuid NOT NULL,
  event_id uuid NOT NULL, event_name varchar(50) NOT NULL, currency varchar(100) NOT NULL, revenue numeric(19,4),
  created_at timestamptz(6) DEFAULT now());
CREATE TABLE public."user" (user_id uuid PRIMARY KEY, username varchar(255));
INSERT INTO public.session (session_id, website_id, browser, os, device, country, city)
  VALUES ('11111111-0000-7000-8000-000000000001', '22222222-0000-7000-8000-000000000002', 'chrome', 'Linux', 'desktop', 'DE', 'Berlin');
INSERT INTO public.website_event (event_id, website_id, session_id, visit_id, url_path, url_query, page_title, tag)
  VALUES ('33333333-0000-7000-8000-000000000003', '22222222-0000-7000-8000-000000000002', '11111111-0000-7000-8000-000000000001',
          '44444444-0000-7000-8000-000000000004', '/a', 'q=secret', 'Title', 'v');
RESET ROLE;`

func TestUmamiViews(t *testing.T) {
	ctx := context.Background()
	pg := connectTo(t, "postgres", "postgres", false)
	mustExec(t, pg, `DO $$ BEGIN CREATE ROLE umami_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
	mustExec(t, pg, `CREATE DATABASE umami OWNER umami_app`)
	um := connectTo(t, "postgres", "umami", false)
	mustExec(t, um, umamiTables)

	for i := 0; i < 2; i++ { // idempotent: a second run (as after every Umami migration) also succeeds
		if out, err := runMigrate([]string{"-e", "SCF_DB_BOOTSTRAP=0"}, "umami-views"); err != nil {
			t.Fatalf("umami-views run %d: %v\n%s", i+1, err, out)
		}
	}
	// role settings
	settings := func(role string) []string {
		rows, err := queryStrings(ctx, um, `SELECT unnest(setconfig) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
		    WHERE r.rolname = $1 AND s.setdatabase = 0 ORDER BY 1`, role)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if got := settings("umami_app"); !slices.Contains(got, "statement_timeout=30s") {
		t.Errorf("umami_app settings: %v", got)
	}
	if got := settings("scf_umami_ro"); !slices.Contains(got, "statement_timeout=300s") || !slices.Contains(got, "default_transaction_read_only=on") {
		t.Errorf("scf_umami_ro settings: %v", got)
	}
	// scf_umami_ro: the two views with exactly the §16.3 columns; nothing else
	ro := connectTo(t, "scf_umami_ro", "umami", false)
	cols, err := queryStrings(ctx, ro, `SELECT table_name || '.' || column_name FROM information_schema.columns
	    WHERE table_schema = 'scf_ro' ORDER BY table_name, ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"session.session_id", "session.website_id", "session.browser", "session.os", "session.device", "session.country",
		"website_event.website_id", "website_event.session_id", "website_event.visit_id", "website_event.created_at",
		"website_event.event_type", "website_event.event_name", "website_event.tag", "website_event.url_path",
		"website_event.referrer_domain"}
	if !slices.Equal(cols, want) {
		t.Errorf("scf_ro columns:\n got %v\nwant %v", cols, want)
	}
	var n int
	if err := ro.QueryRow(ctx, `SELECT count(*) FROM scf_ro.website_event e JOIN scf_ro.session s USING (session_id)
	    WHERE e.website_id = '22222222-0000-7000-8000-000000000002' AND e.tag = 'v'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("rollup read through scf_ro: %d %s", n, sqlState(err))
	}
	for _, q := range []string{`SELECT url_query FROM public.website_event`, `SELECT * FROM public.session`,
		`SELECT * FROM public."user"`} {
		if _, err := ro.Exec(ctx, q); code(err) != "42501" {
			t.Errorf("scf_umami_ro %q: want 42501, got %s", q, sqlState(err))
		}
	}
	if _, err := ro.Exec(ctx, `CREATE TEMP TABLE x (i int)`); code(err) != "25006" {
		t.Errorf("scf_umami_ro is read-only by default: want 25006, got %s", sqlState(err))
	}
	// even in an explicit read-write transaction it has no write right
	if _, err := ro.Exec(ctx, `BEGIN READ WRITE; DELETE FROM public.website_event; COMMIT`); code(err) != "42501" {
		t.Errorf("scf_umami_ro DELETE in a read-write transaction: want 42501, got %s", sqlState(err))
	}
	_, _ = ro.Exec(ctx, `ROLLBACK`)
	// finding 7 / G12: the owner-semantics views belong to a NOLOGIN role without superuser or BYPASSRLS, which reads
	// exactly the viewed columns; gate G12 is clean in this database (umami-views ran it) and catches a regression.
	owners, err := queryStrings(ctx, um, `SELECT c.relname || ' ' || r.rolname || ' ' || r.rolsuper || ' ' || r.rolbypassrls || ' ' || r.rolcanlogin
	    FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.relnamespace = 'scf_ro'::regnamespace ORDER BY 1`)
	if err != nil || !slices.Equal(owners, []string{"session scf_umami_view_owner false false false",
		"website_event scf_umami_view_owner false false false"}) {
		t.Errorf("scf_ro view owners: %v %s", owners, sqlState(err))
	}
	for _, q := range []string{`SELECT has_column_privilege('scf_umami_view_owner', 'public.website_event', 'url_query', 'SELECT')`,
		`SELECT has_column_privilege('scf_umami_view_owner', 'public.session', 'city', 'SELECT')`,
		`SELECT has_table_privilege('scf_umami_view_owner', 'public."user"', 'SELECT')`,
		`SELECT has_table_privilege('scf_umami_view_owner', 'public.website_event', 'DELETE')`} {
		var b bool
		if err := um.QueryRow(ctx, q).Scan(&b); err != nil {
			t.Fatal(sqlState(err))
		}
		if b {
			t.Errorf("scf_umami_view_owner holds more than the viewed columns: %s", q)
		}
	}
	g12 := loadGates(t)["G12"]
	if rows, err := runGate(t, ctx, um, g12); err != nil || len(rows) > 0 {
		t.Errorf("G12 in the umami database: %v %s", rows, sqlState(err))
	}
	if out, err := runMigrate(nil, "umami-gates"); err != nil || !strings.Contains(out, "g12_definer_owners.sql (database 'umami'): ok") {
		t.Errorf("migrate.sh umami-gates: %v\n%s", err, out)
	}
	func() {
		utx, err := um.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = utx.Rollback(ctx) }()
		mustTx(t, utx, `ALTER VIEW scf_ro.session OWNER TO postgres`)
		if rows, err := runGate(t, ctx, utx, g12); err != nil || len(rows) == 0 {
			t.Errorf("G12 missed a superuser-owned scf_ro view: %v %s", rows, sqlState(err))
		}
	}()
	// scf_umami_maint: DELETE with the column SELECTs it needs, nothing more (§16.1)
	maint := connectTo(t, "scf_umami_maint", "umami", false)
	tx, _ := maint.Begin(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM public.website_event WHERE website_id = '22222222-0000-7000-8000-000000000002'
	    AND created_at < now() + interval '1 day' AND url_path LIKE '/a%'`); err != nil {
		t.Errorf("scf_umami_maint retention delete: %s", sqlState(err))
	}
	_ = tx.Rollback(ctx)
	// jobs-onchain finding 1: revenue rows are pruned like their events (the retention job's batch statement)
	mustExec(t, um, `INSERT INTO public.revenue (revenue_id, website_id, session_id, event_id, event_name, currency, revenue, created_at)
	    VALUES (gen_random_uuid(), '22222222-0000-7000-8000-000000000002', '11111111-0000-7000-8000-000000000001',
	            '33333333-0000-7000-8000-000000000003', 'signup', 'usd', 9, now() - interval '400 days')`)
	tag, err := maint.Exec(ctx, `DELETE FROM public.revenue
	    WHERE revenue_id = ANY (ARRAY(SELECT r.revenue_id FROM public.revenue r
	                                   WHERE r.website_id = $1 AND r.created_at < $2 LIMIT $3))`,
		"22222222-0000-7000-8000-000000000002", time.Now().Add(-90*24*time.Hour), 10000)
	if err != nil || tag.RowsAffected() != 1 {
		t.Errorf("scf_umami_maint revenue prune: %d rows, %s", tag.RowsAffected(), sqlState(err))
	}
	for _, q := range []string{`SELECT url_query FROM public.website_event`, `SELECT city FROM public.session`,
		`SELECT currency, revenue FROM public.revenue`, `UPDATE public.revenue SET currency = 'eur'`,
		`UPDATE public.website_event SET tag = 's'`, `INSERT INTO public.session_link VALUES (gen_random_uuid(), gen_random_uuid())`,
		`SELECT * FROM public."user"`, `TRUNCATE public.website_event`} {
		if _, err := maint.Exec(ctx, q); code(err) != "42501" {
			t.Errorf("scf_umami_maint %q: want 42501, got %s", q, sqlState(err))
		}
	}
	// upgrade procedure: with the views present an Umami migration altering a viewed column fails; after
	// umami-views-drop it succeeds, and umami-views recreates the views
	alter := `SET ROLE umami_app; ALTER TABLE public.website_event ALTER COLUMN url_path TYPE varchar(600); RESET ROLE`
	if _, err := um.Exec(ctx, alter); err == nil || !strings.Contains(sqlState(err), "view") {
		t.Errorf("altering a viewed column with scf_ro present: want an error naming the view, got %v", sqlState(err))
	}
	_, _ = um.Exec(ctx, `RESET ROLE`)
	if out, err := runMigrate(nil, "umami-views-drop"); err != nil {
		t.Fatalf("umami-views-drop: %v\n%s", err, out)
	}
	mustExec(t, um, alter)
	if out, err := runMigrate(nil, "umami-views"); err != nil {
		t.Fatalf("umami-views after the migration: %v\n%s", err, out)
	}
	if err := ro.QueryRow(ctx, `SELECT count(*) FROM scf_ro.website_event`).Scan(&n); err != nil || n != 1 {
		t.Errorf("views after recreation: %d %s", n, sqlState(err))
	}
}
