// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"os"
	"path/filepath"
	"testing"
)

// Source lint of C-103 (docs/data-model.md §4.1): outside db/, no code calls set_config( or issues SET/SET LOCAL/
// RESET app.*. Runs over the whole repository (no database needed).
func TestNoContextBypassInSources(t *testing.T) {
	findings, err := ScanContextBypass(repoDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range findings {
		t.Errorf("%s:%d: tenant context must be set through scf.set_tenant_ctx() only (C-103): %s", f.Path, f.Line, f.Text)
	}
}

func TestContextBypassLintCatches(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// must be reported
	write("services/x/repo.go", "q := `SELECT set_config('app.tenant_id', $1, true)`\n")
	write("services/x/internal/db/ctx.sql", "SET LOCAL app.tenant_id = 'x';\n") // a nested db/ is scanned
	write("apps/portal/src/x.ts", "await sql`SET app.actor_kind = 'user'`;\n")
	write("services/jobs/x.py", "cur.execute('reset app.job')\n")
	write("infra/ansible/x.yml", "query: \"SELECT pg_catalog.set_config ('app.job', 'x', false)\"\n")
	// must not be reported
	write("db/migrations/0002.sql", "PERFORM pg_catalog.set_config('app.tenant_id', '', true);\n")
	write("docs/x.md", "never call set_config(\n")
	write("README.md", "SET app.tenant_id is banned\n")
	write("apps/portal/node_modules/pg/x.js", "set_config(\n")
	write("packages/x-py/.venv/lib/python3.13/site-packages/psycopg/x.py", "set_config(\n") // a local virtualenv
	write("services/x/ok.go", "q := `SELECT scf.set_tenant_ctx(p_tenant => $1, p_actor_kind => 'user')`\n")
	write("services/x/doc.ts", "// never calls `set_config(` and never issues SET app.*\n  * set_config( in a block comment\n")
	write("services/x/trailing.go", "db.Exec(\"SET app.job = 'x'\") // looks like a comment at the end\n")
	findings, err := ScanContextBypass(root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, f := range findings {
		got[f.Path] = true
	}
	for _, want := range []string{"services/x/repo.go", "services/x/internal/db/ctx.sql", "apps/portal/src/x.ts",
		"services/jobs/x.py", "infra/ansible/x.yml", "services/x/trailing.go"} {
		if !got[want] {
			t.Errorf("lint missed %s", want)
		}
	}
	if len(findings) != 6 {
		t.Errorf("want exactly 6 findings, got %v", findings)
	}
}
