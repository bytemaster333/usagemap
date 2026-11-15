// SPDX-License-Identifier: Apache-2.0

// Package integration runs the writer against real PostgreSQL 18.6 + PgBouncer 1.26.1 (transaction mode) with the
// migrations of db/ applied by the own migration image, and — in e2e_test.go — behind the real Collector.
package integration

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// Host ports of the writer tests: 56180–56199. 56180 PostgreSQL, 56181 PgBouncer, 56182–56190 writer listeners and the
// Collector of the end-to-end test. SCF_WSD_PROJECT and SCF_WSD_PORT_BASE (default 56180; every port keeps its offset)
// let a second run use its own Compose project and ports next to a running one.
const (
	superPW = "wsd-test-super"
	rolePW  = "wsd-test"
)

var (
	project     = envOr("SCF_WSD_PROJECT", "scf-wsd")
	portBase    = envPort("SCF_WSD_PORT_BASE", 56180)
	pgPort      = portBase
	bouncerPort = portBase + 1
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envPort(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 1024 && n < 65500 {
			return n
		}
		panic(k + " must be a port number")
	}
	return def
}

// Seeded tenants.
const (
	tenantA = "0198a000-0000-7000-8000-00000000000a"
	tenantB = "0198b000-0000-7000-8000-00000000000b"
	userID  = "0198f000-0000-7000-8000-0000000000f0"
)

var testDir string

func TestMain(m *testing.M) { os.Exit(runMain(m)) }

func runMain(m *testing.M) int {
	_, file, _, _ := runtime.Caller(0)
	testDir = filepath.Dir(file)
	if _, err := exec.LookPath("docker"); err != nil {
		if os.Getenv("SCF_SKIP_DOCKER_TESTS") == "1" {
			fmt.Println("metrics-writer/integration: SKIP — docker not found and SCF_SKIP_DOCKER_TESTS=1 (nothing was tested)")
			return 0
		}
		fmt.Fprintln(os.Stderr, "metrics-writer/integration: docker is required; set SCF_SKIP_DOCKER_TESTS=1 to skip explicitly")
		return 1
	}
	if os.Getenv("KEEP") != "1" {
		defer func() {
			if out, err := compose("down", "-v", "--remove-orphans"); err != nil {
				fmt.Fprintf(os.Stderr, "compose down: %v\n%s", err, out)
			}
		}()
	}
	steps := []struct {
		name string
		fn   func() (string, error)
	}{
		{"compose up", func() (string, error) { return compose("up", "-d", "--wait", "pg", "bouncer") }},
		{"build db-migrate", func() (string, error) { return compose("--profile", "tools", "build", "migrate") }},
		{"reset", func() (string, error) { return "", resetCluster() }},
		{"migrate", func() (string, error) {
			return compose("--profile", "tools", "run", "--rm", "-T", "migrate", "migrate")
		}},
		{"pending migration", func() (string, error) { return "", pendingMigration() }},
		{"seed", func() (string, error) { return "", seed() }},
	}
	for _, s := range steps {
		if out, err := s.fn(); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n%s", s.name, err, out)
			return 1
		}
	}
	return m.Run()
}

func compose(args ...string) (string, error) {
	full := append([]string{"compose", "-p", project, "-f", filepath.Join(testDir, "compose.yaml")}, args...)
	cmd := exec.Command("docker", full...)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("SCF_WSD_PG_PORT=%d", pgPort),
		fmt.Sprintf("SCF_WSD_PGB_PORT=%d", bouncerPort),
		"SCF_WSD_MIGRATE_IMAGE="+project+"-db-migrate:test")
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

func dsn(user, db string, viaBouncer bool) string {
	pw, port := rolePW, pgPort
	if user == "postgres" {
		pw = superPW
	}
	if viaBouncer {
		port = bouncerPort
	}
	return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable&connect_timeout=5&application_name=scf-wsd-tests",
		user, pw, port, db)
}

func resetCluster() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "postgres", false))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	if _, err := su.Exec(ctx, "DROP DATABASE IF EXISTS scf WITH (FORCE)"); err != nil {
		return err
	}
	for _, r := range []string{"scf_dump_login", "scf_maintenance", "scf_metrics_ro", "scf_jobs", "scf_writer", "scf_app",
		"scf_audit_definer", "scf_op_definer", "scf_definer", "scf_migrator", "scf_umami_ro", "scf_umami_maint", "umami_app"} {
		if _, err := su.Exec(ctx, "DROP ROLE IF EXISTS "+r); err != nil {
			return err
		}
	}
	return nil
}

// pendingMigration applies testdata/pending-writer-tenant-status.sql when the migrations of db/ do not yet define
// scf.writer_tenant_gone() (a change that lands in db/; until then the writer's probe keeps the
// listener closed). It says so loudly; it is a no-op once the migration exists.
func pendingMigration() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "scf", false))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	var exists bool
	if err := su.QueryRow(ctx, `SELECT to_regprocedure('scf.writer_tenant_gone()') IS NOT NULL`).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	sql, err := os.ReadFile(filepath.Join(testDir, "testdata", "pending-writer-tenant-status.sql"))
	if err != nil {
		return err
	}
	fmt.Println("metrics-writer/integration: NOTE — db/migrations lacks scf.writer_tenant_gone(); applying testdata/pending-writer-tenant-status.sql")
	_, err = su.Exec(ctx, string(sql))
	return err
}

// seed creates the owner user and tenants A and B (superuser, direct) and partitions for yesterday, so that a run
// shortly after midnight UTC still has a partition for points of the previous day.
func seed() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "scf", false))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	if _, err := su.Exec(ctx, `INSERT INTO scf.users (user_id, display_name) VALUES ($1, 'owner')`, userID); err != nil {
		return err
	}
	for i, t := range []string{tenantA, tenantB} {
		if _, err := su.Exec(ctx, `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by) VALUES ($1, $2, $3, 'active', $4)`,
			t, fmt.Sprintf("tenant-%c", 'a'+i), fmt.Sprintf("Tenant %c", 'A'+i), userID); err != nil {
			return err
		}
	}
	mig, err := pgx.Connect(ctx, dsn("scf_migrator", "scf", false))
	if err != nil {
		return err
	}
	defer mig.Close(ctx)
	y := time.Now().UTC().AddDate(0, 0, -1)
	day := time.Date(y.Year(), y.Month(), y.Day(), 0, 0, 0, 0, time.UTC)
	for _, p := range []struct {
		tbl, name string
		from, to  time.Time
	}{
		{"api_metrics_1m", "api_metrics_1m_" + day.Format("20060102"), day, day.AddDate(0, 0, 1)},
		{"api_metrics_1h", "api_metrics_1h_" + day.Format("200601"), time.Date(y.Year(), y.Month(), 1, 0, 0, 0, 0, time.UTC),
			time.Date(y.Year(), y.Month()+1, 1, 0, 0, 0, 0, time.UTC)},
		{"api_metrics_1d", "api_metrics_1d_" + day.Format("2006"), time.Date(y.Year(), 1, 1, 0, 0, 0, 0, time.UTC),
			time.Date(y.Year()+1, 1, 1, 0, 0, 0, 0, time.UTC)},
	} {
		var exists bool
		if err := mig.QueryRow(ctx, `SELECT to_regclass('scf_part.' || $1) IS NOT NULL`, p.name).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := mig.Exec(ctx, fmt.Sprintf(`CREATE TABLE scf_part.%s PARTITION OF scf.%s FOR VALUES FROM ('%s') TO ('%s') WITH (fillfactor = 80)`,
			p.name, p.tbl, p.from.Format(time.RFC3339), p.to.Format(time.RFC3339))); err != nil {
			return err
		}
		if _, err := mig.Exec(ctx, `SELECT scf_admin.secure_partition($1::regclass, $2::regclass)`,
			"scf_part."+p.name, "scf."+p.tbl); err != nil {
			return err
		}
	}
	return nil
}

// newTenant creates a fresh tenant for one test (superuser), so tests never see each other's rows.
func newTenant(t testing.TB) string {
	t.Helper()
	ctx := context.Background()
	su := superConn(t)
	var id string
	if err := su.QueryRow(ctx, `INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by)
VALUES (uuidv7(), 't-' || substr(md5(random()::text), 1, 20), 'test', 'active', $1) RETURNING tenant_id::text`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

var (
	superOnce sync.Once
	superPool *pgxpool.Pool
)

// superConn returns the shared superuser pool (direct, bypasses RLS: tests read exactly what was stored).
func superConn(t testing.TB) *pgxpool.Pool {
	t.Helper()
	superOnce.Do(func() {
		cfg, err := pgxpool.ParseConfig(dsn("postgres", "scf", false))
		if err == nil {
			cfg.MaxConns = 4
			superPool, err = pgxpool.NewWithConfig(context.Background(), cfg)
		}
		if err != nil {
			panic(err)
		}
	})
	return superPool
}

// writerPool is a pool of role scf_writer through PgBouncer — exactly what the service uses.
func writerPool(t testing.TB, maxConns int32) *pgxpool.Pool {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(dsn("scf_writer", "scf", true))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = maxConns
	p, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func newStore(t testing.TB, o store.Options) *store.Store {
	t.Helper()
	return store.New(writerPool(t, 8), o)
}

// apply decodes md as one request and applies every tenant part; it fails the test on an unavailable database.
func apply(t testing.TB, st *store.Store, md pmetric.Metrics, now time.Time) []store.Result {
	t.Helper()
	body, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		t.Fatal(err)
	}
	return applyBody(t, st, body, now)
}

func applyBody(t testing.TB, st *store.Store, body []byte, now time.Time) []store.Result {
	t.Helper()
	b, err := batch.Decode(body, now)
	if err != nil {
		t.Fatal(err)
	}
	var out []store.Result
	for _, p := range b.Parts {
		r, err := st.Apply(context.Background(), b.Key, p)
		if err != nil {
			t.Fatalf("apply: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// ---- PKI (C-60 private CA; node certificates with one OU naming the role, C-113) -----------------------------------

type pkiFiles struct {
	dir                                      string
	CA, ServerCert, ServerKey                string
	EdgeCert, EdgeKey, ReaderCert, ReaderKey string
	caCert                                   *x509.Certificate
}

func writePEM(path, typ string, der []byte) error {
	return os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600)
}

func newPKI(t testing.TB) *pkiFiles {
	t.Helper()
	dir := t.TempDir()
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "wsd test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)
	f := &pkiFiles{dir: dir, caCert: caCert}
	f.CA = filepath.Join(dir, "ca.pem")
	if err := writePEM(f.CA, "CERTIFICATE", caDER); err != nil {
		t.Fatal(err)
	}
	issue := func(name string, subj pkix.Name, eku x509.ExtKeyUsage, dns []string, ips []net.IP) (string, string) {
		k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
		tmpl := &x509.Certificate{SerialNumber: serial, Subject: subj, NotBefore: time.Now().Add(-time.Hour),
			NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature,
			ExtKeyUsage: []x509.ExtKeyUsage{eku}, DNSNames: dns, IPAddresses: ips}
		der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &k.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		kd, _ := x509.MarshalPKCS8PrivateKey(k)
		cp, kp := filepath.Join(dir, name+".pem"), filepath.Join(dir, name+"-key.pem")
		if err := writePEM(cp, "CERTIFICATE", der); err != nil {
			t.Fatal(err)
		}
		if err := writePEM(kp, "PRIVATE KEY", kd); err != nil {
			t.Fatal(err)
		}
		return cp, kp
	}
	// Writer certificate: node name and the shared name both writers carry (C-107).
	f.ServerCert, f.ServerKey = issue("core-a-writer", pkix.Name{CommonName: "core-a-writer"}, x509.ExtKeyUsageServerAuth,
		[]string{"core-a-writer", "writers.mesh.test", "localhost"}, []net.IP{net.ParseIP("127.0.0.1")})
	f.EdgeCert, f.EdgeKey = issue("edge-a1", pkix.Name{OrganizationalUnit: []string{"edge"}, CommonName: "edge-a1"},
		x509.ExtKeyUsageClientAuth, nil, nil)
	f.ReaderCert, f.ReaderKey = issue("core-a-jobs", pkix.Name{OrganizationalUnit: []string{"reader"}, CommonName: "core-a-jobs"},
		x509.ExtKeyUsageClientAuth, nil, nil)
	return f
}

func (f *pkiFiles) clientTLS(t testing.TB, cert, key string) *tls.Config {
	t.Helper()
	c, err := tls.LoadX509KeyPair(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(f.caCert)
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{c}, RootCAs: pool,
		ServerName: "writers.mesh.test"}
}
