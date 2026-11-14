// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The migration runner (db/migrate.sh in the db-migrate image, db/Dockerfile): re-runs are no-ops, two runners at
// once apply every migration exactly once (session advisory lock + ledger re-check), a migration edited after it was
// applied stops the run, and a failing migration leaves nothing behind (one transaction per migration).

func migrationFiles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dbDir, "migrations", "[0-9][0-9][0-9][0-9]_*.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no migrations: %v", err)
	}
	return files
}

func ledgerCount(t *testing.T, db string) int {
	t.Helper()
	c := connectTo(t, "postgres", db, false)
	var n int
	if err := c.QueryRow(context.Background(), `SELECT count(*) FROM scf_migrations.applied`).Scan(&n); err != nil {
		t.Fatal(sqlState(err))
	}
	return n
}

func dropDB(t *testing.T, db string) {
	t.Helper()
	pg := connectTo(t, "postgres", "postgres", false)
	mustExec(t, pg, fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, db))
}

func TestMigrateRerunIsNoop(t *testing.T) {
	n := len(migrationFiles(t))
	out, err := runMigrate(nil, "migrate")
	if err != nil {
		t.Fatalf("re-run: %v\n%s", err, out)
	}
	if strings.Contains(out, "applying ") || !strings.Contains(out, fmt.Sprintf("%d migrations applied, ledger matches", n)) {
		t.Errorf("re-run is not a no-op:\n%s", out)
	}
	if got := ledgerCount(t, "scf"); got != n {
		t.Errorf("ledger has %d rows, %d migration files", got, n)
	}
	// the gates through the image, as deployments run them
	out, err = runMigrate(nil, "gates")
	if err != nil || strings.Contains(out, "FAIL") {
		t.Errorf("migrate.sh gates: %v\n%s", err, out)
	}
	if out, err := runMigrate(nil, "status"); err != nil || strings.Contains(out, "pending:") {
		t.Errorf("migrate.sh status: %v\n%s", err, out)
	}
}

func TestMigrateConcurrentRunners(t *testing.T) {
	const db = "scf_conc"
	n := len(migrationFiles(t))
	t.Cleanup(func() { dropDB(t, db) })
	env := []string{"-e", "SCF_DB_NAME=" + db, "-e", "SCF_DB_BOOTSTRAP=0"}
	if out, err := runMigrate(env, "bootstrap"); err != nil {
		t.Fatalf("bootstrap %s: %v\n%s", db, err, out)
	}
	var wg sync.WaitGroup
	outs := make([]string, 2)
	errs := make([]error, 2)
	for i := range outs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outs[i], errs[i] = runMigrate(env, "migrate")
		}()
	}
	wg.Wait()
	applied := 0
	for i := range outs {
		if errs[i] != nil {
			t.Errorf("runner %d: %v\n%s", i, errs[i], outs[i])
		}
		applied += strings.Count(outs[i], "applying ")
	}
	if applied != n {
		t.Errorf("two concurrent runners applied %d migrations in total, want exactly %d", applied, n)
	}
	if got := ledgerCount(t, db); got != n {
		t.Errorf("ledger has %d rows, want %d", got, n)
	}

	// a migration changed after it was applied stops the run
	c := connectTo(t, "postgres", db, false)
	mustExec(t, c, `UPDATE scf_migrations.applied SET sha256 = repeat('0', 64) WHERE version = '0005_types'`)
	out, err := runMigrate(env, "migrate")
	if err == nil || !strings.Contains(out, "changed after it was applied") {
		t.Errorf("drift not detected: err=%v\n%s", err, out)
	}
	_ = c.Close(context.Background())
}

func TestMigrateFailureRollsBack(t *testing.T) {
	const db = "scf_fail"
	t.Cleanup(func() { dropDB(t, db) })
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range migrationFiles(t) {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, filepath.Base(f)), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	broken := "-- migration: 0099_broken\nCREATE TABLE scf.wse_partial (tenant_id uuid PRIMARY KEY);\nSELECT 1/0;\n"
	if err := os.WriteFile(filepath.Join(dir, "0099_broken.sql"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	env := []string{"-e", "SCF_DB_NAME=" + db, "-e", "SCF_DB_BOOTSTRAP=1", "-v", dir + ":/db/migrations:ro"}
	out, err := runMigrate(env, "migrate")
	if err == nil || !strings.Contains(out, "division by zero") || !strings.Contains(out, "0099_broken") {
		t.Fatalf("broken migration: want failure naming it, got err=%v\n%s", err, out)
	}
	c := connectTo(t, "postgres", db, false)
	var partial bool
	var ledger int
	if err := c.QueryRow(context.Background(), `SELECT to_regclass('scf.wse_partial') IS NOT NULL,
	    (SELECT count(*) FROM scf_migrations.applied WHERE version = '0099_broken')`).Scan(&partial, &ledger); err != nil {
		t.Fatal(err)
	}
	if partial || ledger != 0 {
		t.Errorf("failed migration left state: table=%v ledger=%d", partial, ledger)
	}
	if got := ledgerCount(t, db); got != len(migrationFiles(t)) {
		t.Errorf("migrations before the broken one: %d applied, want %d", got, len(migrationFiles(t)))
	}
	_ = c.Close(context.Background())
}

// The contract is the document: every `-- migration:` block of docs/data-model.md is a file here with exactly that
// text (after the two-line source header), and every migration file is either such a block or a listed
// addition still waiting to be copied into the document.
func TestMigrationsMatchDataModel(t *testing.T) {
	doc := readFile(t, filepath.Join(repoDir, "docs", "data-model.md"))
	blocks := map[string]string{}
	for _, part := range strings.Split(doc, "```sql\n")[1:] {
		body := part[:strings.Index(part, "```")]
		if first, _, _ := strings.Cut(body, "\n"); strings.HasPrefix(first, "-- migration: ") {
			blocks[strings.Fields(first)[2]] = body
		}
	}
	if len(blocks) < 23 {
		t.Fatalf("found %d migration blocks in data-model.md", len(blocks))
	}
	// Blocks not yet copied into docs/data-model.md §12; add a name while its block is not in yet.
	notYetInDoc := map[string]bool{}
	for _, f := range migrationFiles(t) {
		name := strings.TrimSuffix(filepath.Base(f), ".sql")
		body := readFile(t, f)
		want, ok := blocks[name]
		if !ok {
			if !notYetInDoc[name] {
				t.Errorf("%s is not a block of docs/data-model.md", name)
			}
			continue
		}
		delete(blocks, name)
		if lines := strings.SplitN(body, "\n", 3); len(lines) < 3 || lines[2] != want {
			t.Errorf("%s differs from its block in docs/data-model.md", name)
		}
	}
	for name := range blocks {
		t.Errorf("data-model.md block %s has no migration file", name)
	}
}
