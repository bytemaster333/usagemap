// SPDX-License-Identifier: Apache-2.0
package dbtests

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Stack of compose.yaml: project scf-wse, PostgreSQL on 56100 (direct), PgBouncer on 56101 (transaction mode).
// SCF_WSE_PROJECT / SCF_WSE_PG_PORT / SCF_WSE_PGB_PORT let a second run on the same machine use its own stack.
var (
	project     = envOr("SCF_WSE_PROJECT", "scf-wse")
	pgPort      = envInt("SCF_WSE_PG_PORT", 56100)
	bouncerPort = envInt("SCF_WSE_PGB_PORT", 56101)
)

const (
	superPW = "wse-test-super" // throwaway values of the disposable test container (compose.yaml)
	rolePW  = "wse-test"
)

func envOr(name, dflt string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return dflt
}

func envInt(name string, dflt int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return dflt
}

var (
	testDir string // db/tests
	dbDir   string // db
	repoDir string
)

// Seeded tenants (seed_test.go): A and B ordinary, C a canary tenant.
const (
	A = "aaaaaaaa-0000-7000-8000-000000000001"
	B = "bbbbbbbb-0000-7000-8000-000000000002"
	C = "cccccccc-0000-7000-8000-000000000003"
)

func TestMain(m *testing.M) {
	os.Exit(runMain(m))
}

func runMain(m *testing.M) int {
	_, file, _, _ := runtime.Caller(0)
	testDir = filepath.Dir(file)
	dbDir = filepath.Dir(testDir)
	repoDir = filepath.Dir(dbDir)
	// C-114: the suite never reports ok without having run. Without Docker it fails, unless the caller opts out
	// explicitly with SCF_SKIP_DOCKER_TESTS=1 (then it says SKIP).
	if _, err := exec.LookPath("docker"); err != nil {
		if os.Getenv("SCF_SKIP_DOCKER_TESTS") == "1" {
			fmt.Println("db/tests: SKIP — docker not found and SCF_SKIP_DOCKER_TESTS=1 (nothing was tested)")
			return 0
		}
		fmt.Fprintln(os.Stderr, "db/tests: docker is required (PostgreSQL 18.6 + PgBouncer containers); set SCF_SKIP_DOCKER_TESTS=1 to skip explicitly")
		return 1
	}
	if os.Getenv("KEEP") != "1" {
		defer func() {
			if out, err := compose("down", "-v", "--remove-orphans"); err != nil {
				fmt.Fprintf(os.Stderr, "compose down: %v\n%s", err, out)
			}
		}()
	}
	if out, err := compose("up", "-d", "--wait", "pg", "bouncer"); err != nil {
		fmt.Fprintf(os.Stderr, "compose up: %v\n%s", err, out)
		return 1
	}
	if out, err := compose("--profile", "tools", "build", "migrate"); err != nil {
		fmt.Fprintf(os.Stderr, "build db-migrate image: %v\n%s", err, out)
		return 1
	}
	if err := resetCluster(); err != nil {
		fmt.Fprintf(os.Stderr, "reset: %v\n", err)
		return 1
	}
	if out, err := runMigrate(nil, "migrate"); err != nil {
		fmt.Fprintf(os.Stderr, "db-migrate: %v\n%s", err, out)
		return 1
	}
	if err := seed(); err != nil {
		fmt.Fprintf(os.Stderr, "seed: %v\n", err)
		return 1
	}
	return m.Run()
}

// compose runs docker compose for the test stack and returns combined output.
func compose(args ...string) (string, error) {
	full := append([]string{"compose", "-p", project, "-f", filepath.Join(testDir, "compose.yaml")}, args...)
	cmd := exec.Command("docker", full...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("SCF_WSE_PG_PORT=%d", pgPort), fmt.Sprintf("SCF_WSE_PGB_PORT=%d", bouncerPort))
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

// runMigrate runs the db-migrate image one-shot (`docker compose run --rm migrate <cmd>`); extra holds additional
// `docker compose run` flags placed before the service name (e.g. -e K=V, -v src:dst).
func runMigrate(extra []string, cmd ...string) (string, error) {
	args := append([]string{"--profile", "tools", "run", "--rm", "-T"}, extra...)
	args = append(args, "migrate")
	return compose(append(args, cmd...)...)
}

// resetCluster drops everything a previous KEEP=1 run left, so every run migrates from zero.
func resetCluster() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "postgres", false))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	for _, db := range []string{"scf", "scf_conc", "scf_fail", "scf_quote", "umami", "umami_pw"} {
		if _, err := su.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", db)); err != nil {
			return err
		}
	}
	for _, r := range []string{"scf_dump_login", "scf_maintenance", "scf_metrics_ro", "scf_jobs", "scf_writer", "scf_app",
		"scf_audit_definer", "scf_op_definer", "scf_definer", "scf_migrator", "scf_umami_ro", "scf_umami_maint", "scf_umami_view_owner",
		"umami_app"} {
		if _, err := su.Exec(ctx, "DROP ROLE IF EXISTS "+r); err != nil {
			return err
		}
	}
	return nil
}

// dsn builds a connection string. db "scf_one" is the PgBouncer pool with exactly one server connection.
func dsn(user, db string, viaBouncer bool) string {
	pw, port := rolePW, pgPort
	if user == "postgres" {
		pw = superPW
	}
	if viaBouncer {
		port = bouncerPort
	}
	return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable&connect_timeout=10&application_name=scf-wse-tests",
		user, pw, port, db)
}

func connectTo(t testing.TB, user, db string, viaBouncer bool) *pgx.Conn {
	t.Helper()
	ctx := context.Background()
	c, err := pgx.Connect(ctx, dsn(user, db, viaBouncer))
	if err != nil {
		t.Fatalf("connect %s@%s (bouncer=%v): %v", user, db, viaBouncer, err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c
}

// super returns a direct superuser connection to database scf.
func super(t testing.TB) *pgx.Conn { return connectTo(t, "postgres", "scf", false) }

// migrator returns a direct connection as scf_migrator (the gates run as it).
func migrator(t testing.TB) *pgx.Conn { return connectTo(t, "scf_migrator", "scf", false) }

// runtimeConn returns a connection of a runtime role through PgBouncer (transaction mode), as production does.
func runtimeConn(t testing.TB, role string) *pgx.Conn { return connectTo(t, role, "scf", true) }

// Ctx mirrors the arguments of scf.set_tenant_ctx() (docs/data-model.md §4.2).
type Ctx struct {
	Tenant, Kind, Actor, PlatformRole, KeyScopes, Job, RequestID string
	KeyTenants                                                   []string
	StepUp, Reauth                                               *time.Time
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// setCtx sets the transaction's context the only permitted way: scf.set_tenant_ctx().
func setCtx(ctx context.Context, tx pgx.Tx, c Ctx) error {
	kind := c.Kind
	if kind == "" {
		kind = "anonymous"
	}
	var keyTenants any
	if c.KeyTenants != nil {
		keyTenants = c.KeyTenants
	}
	var stepUp, reauth any
	if c.StepUp != nil {
		stepUp = *c.StepUp
	}
	if c.Reauth != nil {
		reauth = *c.Reauth
	}
	_, err := tx.Exec(ctx, `SELECT scf.set_tenant_ctx(p_tenant => $1::uuid, p_actor_kind => $2, p_actor_id => $3,
	    p_platform_role => $4, p_step_up_at => $5::timestamptz, p_reauthenticated_at => $6::timestamptz,
	    p_key_scopes => $7, p_key_tenants => $8::uuid[], p_job => $9, p_request_id => $10)`,
		nullStr(c.Tenant), kind, nullStr(c.Actor), nullStr(c.PlatformRole), stepUp, reauth, nullStr(c.KeyScopes),
		keyTenants, nullStr(c.Job), nullStr(c.RequestID))
	return err
}

// inCtx runs fn in one transaction of conn with context c; the transaction is always rolled back.
func inCtx(t testing.TB, conn *pgx.Conn, c Ctx, fn func(ctx context.Context, tx pgx.Tx) error) error {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := setCtx(ctx, tx, c); err != nil {
		return err
	}
	return fn(ctx, tx)
}

// sqlState returns "SQLSTATE: message" for a PostgreSQL error, or the error text.
func sqlState(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return pe.Code + ": " + pe.Message
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

func code(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

// savepoint runs fn in a nested transaction that is always rolled back; it returns fn's error.
func savepoint(ctx context.Context, tx pgx.Tx, fn func(pgx.Tx) error) error {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = sp.Rollback(ctx) }()
	return fn(sp)
}

// queryStrings runs a query and renders every row as one string (for gate output).
func queryStrings(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		parts := make([]string, len(vals))
		for i, v := range vals {
			parts[i] = fmt.Sprint(v)
		}
		out = append(out, strings.Join(parts, " | "))
	}
	return out, rows.Err()
}

func mustExec(t testing.TB, c *pgx.Conn, sql string, args ...any) {
	t.Helper()
	if _, err := c.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("exec %q: %v", firstLine(sql), err)
	}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i] + " …"
	}
	return s
}

func readFile(t testing.TB, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
