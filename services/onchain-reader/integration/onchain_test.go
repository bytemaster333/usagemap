// SPDX-License-Identifier: Apache-2.0

// Package integration runs the on-chain pipeline of wire-formats §p/§p.1 against real PostgreSQL (all migrations,
// row-level security, the scf_jobs role): a synthetic ledger store served over HTTPS → `onchain-reader fetch` → the
// local mirror → the §p contract list read as job onchain_correlation → `onchain-reader -contracts -` → complete days
// upserted into scf.onchain_daily under each tenant's context. The binaries are built from this repository and run as
// child processes, exactly as the jobs service runs them.
//
//	cd services/onchain-reader/integration && GOWORK=off go test -count=1 ./...
//
// Needs Docker (compose project scf-d1-oc-it, PostgreSQL on 127.0.0.1:26410); without it the suite fails unless
// SCF_SKIP_DOCKER_TESTS=1 is set (then it says SKIP). KEEP=1 leaves the database running.
package integration

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	project = "scf-d1-oc-it"
	superPW = "oc-test-super"
	rolePW  = "oc-test"
	jobName = "onchain_correlation"
)

var (
	testDir, moduleDir string
	pgPort             = 26410
	readerBin, lakegen string
)

func TestMain(m *testing.M) { os.Exit(runMain(m)) }

func runMain(m *testing.M) int {
	_, file, _, _ := runtime.Caller(0)
	testDir = filepath.Dir(file)
	moduleDir = filepath.Dir(testDir)
	if v, err := strconv.Atoi(os.Getenv("SCF_OC_PG_PORT")); err == nil {
		pgPort = v
	}
	if _, err := exec.LookPath("docker"); err != nil {
		if os.Getenv("SCF_SKIP_DOCKER_TESTS") == "1" {
			fmt.Println("onchain-reader/integration: SKIP — docker not found and SCF_SKIP_DOCKER_TESTS=1 (nothing was tested)")
			return 0
		}
		fmt.Fprintln(os.Stderr, "onchain-reader/integration: docker is required (PostgreSQL); set SCF_SKIP_DOCKER_TESTS=1 to skip explicitly")
		return 1
	}
	bin, err := os.MkdirTemp("", "scf-oc-it-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer os.RemoveAll(bin)
	readerBin, lakegen = filepath.Join(bin, "onchain-reader"), filepath.Join(bin, "lakegen")
	for out, pkg := range map[string]string{readerBin: "./cmd/onchain-reader", lakegen: "./internal/fixture/lakegen"} {
		cmd := exec.Command("go", "build", "-o", out, pkg)
		cmd.Dir = moduleDir
		cmd.Env = append(os.Environ(), "GOWORK=off", "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "build %s: %v\n%s", pkg, err, b)
			return 1
		}
	}
	if os.Getenv("KEEP") != "1" {
		defer func() {
			if out, err := compose("down", "-v", "--remove-orphans"); err != nil {
				fmt.Fprintf(os.Stderr, "compose down: %v\n%s", err, out)
			}
		}()
	}
	if out, err := compose("up", "-d", "--build", "--wait", "pg"); err != nil {
		fmt.Fprintf(os.Stderr, "compose up: %v\n%s", err, out)
		return 1
	}
	if out, err := compose("--profile", "tools", "build", "migrate"); err != nil {
		fmt.Fprintf(os.Stderr, "build migrate: %v\n%s", err, out)
		return 1
	}
	if err := reset(); err != nil {
		fmt.Fprintf(os.Stderr, "reset: %v\n", err)
		return 1
	}
	if out, err := compose("--profile", "tools", "run", "--rm", "-T", "migrate", "migrate"); err != nil {
		fmt.Fprintf(os.Stderr, "migrate: %v\n%s", err, out)
		return 1
	}
	return m.Run()
}

func compose(args ...string) (string, error) {
	full := append([]string{"compose", "-p", project, "-f", filepath.Join(testDir, "compose.yaml")}, args...)
	cmd := exec.Command("docker", full...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("SCF_OC_PG_PORT=%d", pgPort))
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	return buf.String(), err
}

func dsn(user, db string) string {
	pw := rolePW
	if user == "postgres" {
		pw = superPW
	}
	return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable&connect_timeout=10", user, pw, pgPort, db)
}

// reset drops what a previous KEEP=1 run left, so every run migrates from zero.
func reset() error {
	ctx := context.Background()
	su, err := pgx.Connect(ctx, dsn("postgres", "postgres"))
	if err != nil {
		return err
	}
	defer su.Close(ctx)
	for _, db := range []string{"scf", "umami"} {
		if _, err := su.Exec(ctx, "DROP DATABASE IF EXISTS "+db+" WITH (FORCE)"); err != nil {
			return err
		}
	}
	return nil
}

// ---- the synthetic store ------------------------------------------------------------------------------------

type txSpec struct {
	Source   string `json:"source"`
	Contract string `json:"contract,omitempty"`
	Success  bool   `json:"success"`
	FeeBump  bool   `json:"fee_bump,omitempty"`
}

type ledgerSpec struct {
	Seq      uint32    `json:"seq"`
	ClosedAt time.Time `json:"closed_at"`
	Txs      []txSpec  `json:"txs"`
}

// store writes a testnet lake (a ledger every 30 minutes from 2026-11-01T20:07Z to 2026-11-05T23:07Z) with
// invocations of four contracts on 2026-11-03 and 2026-11-04 and serves it over HTTPS as a Galexie store with a
// .config.json. It returns the server, a PEM file of its certificate, the contract strkeys by label and the hash of
// every ledger by sequence (the network's copy, as Horizon `/ledgers/{seq}` would serve it).
func store(t *testing.T) (*httptest.Server, string, map[string]string, map[string]string) {
	t.Helper()
	base := time.Date(2026, 11, 1, 20, 7, 0, 0, time.UTC)
	var ls []ledgerSpec
	for seq := uint32(2); seq <= 200; seq++ {
		l := ledgerSpec{Seq: seq, ClosedAt: base.Add(time.Duration(seq-2) * 30 * time.Minute)}
		switch seq {
		case 57: // 2026-11-02T23:37Z: the last ledger of 11-02, never counted for 11-03
			l.Txs = []txSpec{{Source: "alice", Contract: "verified", Success: true}}
		case 60, 100: // 2026-11-03
			l.Txs = []txSpec{{Source: "alice", Contract: "verified", Success: true}, {Source: "bob", Contract: "verified", Success: seq == 60, FeeBump: true},
				{Source: "carol", Contract: "conflict", Success: true}, {Source: "carol", Contract: "claimed", Success: true},
				{Source: "dave", Contract: "not-opted-in", Success: true}}
		case 120: // 2026-11-04T11:07Z
			l.Txs = []txSpec{{Source: "erin", Contract: "verified", Success: true}}
		}
		ls = append(ls, l)
	}
	spec, _ := json.Marshal(map[string]any{"ledgers": ls})
	root := t.TempDir()
	cmd := exec.Command(lakegen, "-network", "testnet", root)
	cmd.Stdin = bytes.NewReader(spec)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("lakegen: %v", err)
	}
	var res struct{ Contracts, Ledgers map[string]string }
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatal(err)
	}
	cfg := `{"networkPassphrase":"Test SDF Network ; September 2015","version":"1.0","compression":"zstd","ledgersPerBatch":1,"batchesPerPartition":64000}`
	if err := os.WriteFile(filepath.Join(root, ".config.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(http.FileServer(http.Dir(root)))
	t.Cleanup(srv.Close)
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	return srv, ca, res.Contracts, res.Ledgers
}

// ---- the database side of job onchain_correlation ----------------------------------------------------------

// contractListSQL is the contract list of wire-formats §p (C-137): verified, not removed, not in conflict, on the
// deployment's network, of opted-in tenants that are not removed.
const contractListSQL = `
SELECT c.tenant_id::text, c.contract_ref::text, c.contract_id
  FROM scf.declared_contracts c JOIN scf.tenants t USING (tenant_id)
 WHERE t.onchain_correlation_enabled AND t.status <> 'removed'
   AND c.status = 'verified' AND c.removed_at IS NULL AND c.conflict_since IS NULL AND c.network = $1
 ORDER BY c.tenant_id, c.contract_ref`

// upsertSQL stores one complete day; a ledger_files row replaces a hubble row of the same contract and day (D3, C-136).
const upsertSQL = `
INSERT INTO scf.onchain_daily AS o (tenant_id, contract_ref, day, invocations, successful_invocations,
                                     distinct_invokers, data_source, computed_at)
VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, 'ledger_files', now())
ON CONFLICT (tenant_id, contract_ref, day) DO UPDATE
   SET invocations = EXCLUDED.invocations, successful_invocations = EXCLUDED.successful_invocations,
       distinct_invokers = EXCLUDED.distinct_invokers, data_source = 'ledger_files', computed_at = EXCLUDED.computed_at`

func asJob(t *testing.T, conn *pgx.Conn, tenant string, fn func(pgx.Tx) error) {
	t.Helper()
	ctx := context.Background()
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tid any
	if tenant != "" {
		tid = tenant
	}
	if _, err := tx.Exec(ctx, `SELECT scf.set_tenant_ctx(p_tenant => $1::uuid, p_actor_kind => 'job', p_actor_id => $2::text, p_job => $2::text)`,
		tid, jobName); err != nil {
		t.Fatal(err)
	}
	if err := fn(tx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

type row struct {
	Contract              string  `json:"contract"`
	Day                   string  `json:"day"`
	Invocations           int64   `json:"invocations"`
	SuccessfulInvocations int64   `json:"successful_invocations"`
	DistinctInvokers      int64   `json:"distinct_invokers"`
	DataSource            string  `json:"data_source"`
	LedgersInDay          int64   `json:"ledgers_in_day"`
	LedgerFirst           uint32  `json:"ledger_first"`
	LedgerLast            uint32  `json:"ledger_last"`
	Complete              bool    `json:"complete"`
	AnchorLedger          *uint32 `json:"anchor_ledger"`
	AnchorHash            *string `json:"anchor_hash"`
}

func TestLedgerFilesLandInOnchainDaily(t *testing.T) {
	ctx := context.Background()
	srv, ca, c, network := store(t)
	su, err := pgx.Connect(ctx, dsn("postgres", "scf"))
	if err != nil {
		t.Fatal(err)
	}
	defer su.Close(ctx)

	// Tenants: T1 and T2 opted in, T3 not. T1 declares "verified" (counted), "conflict" (verified, but also verified
	// by T2: conflict_since on both), "claimed" (declared only) and "verified" again on mainnet (other network).
	const u = "0193b7e2-0000-7000-8000-00000000c001"
	t1, t2, t3 := "0193b7e2-0000-7000-8000-00000000c0a1", "0193b7e2-0000-7000-8000-00000000c0a2", "0193b7e2-0000-7000-8000-00000000c0a3"
	seed := []string{
		`INSERT INTO scf.users (user_id, display_name) VALUES ('` + u + `', 'it')`,
	}
	for i, tn := range []string{t1, t2, t3} {
		seed = append(seed,
			fmt.Sprintf(`INSERT INTO scf.tenants (tenant_id, slug, name, status, created_by, onchain_correlation_enabled)
			             VALUES ('%s', 'oc-it-%d', 'OC %d', 'active', '%s', %t)`, tn, i, i, u, tn != t3),
			fmt.Sprintf(`INSERT INTO scf.verification_evidence (tenant_id, evidence_id, kind, subject, status)
			             VALUES ('%s', '%s', 'stellar_account', 'G%s%c', 'valid')`, tn, evidence(tn), strings.Repeat("A", 54), 'B'+i))
	}
	declare := func(tenant, contract, network, status string, conflict bool) string {
		ref := ""
		verified := status == "verified"
		err := su.QueryRow(ctx, `INSERT INTO scf.declared_contracts (tenant_id, contract_id, network, created_by, status,
		    verified_role, verified_by_evidence, verified_at, conflict_since)
		  VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN 'deployer' END, CASE WHEN $6 THEN $7::uuid END,
		          CASE WHEN $6 THEN now() END, CASE WHEN $8 THEN now() END) RETURNING contract_ref::text`,
			tenant, contract, network, u, status, verified, evidence(tenant), conflict).Scan(&ref)
		if err != nil {
			t.Fatalf("declare %s: %v", contract, err)
		}
		return ref
	}
	for _, q := range seed {
		if _, err := su.Exec(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	refVerified := declare(t1, c["verified"], "testnet", "verified", false)
	declare(t1, c["verified"], "public", "verified", false) // another network: not this deployment's
	declare(t1, c["conflict"], "testnet", "verified", true)
	declare(t2, c["conflict"], "testnet", "verified", true)
	declare(t1, c["claimed"], "testnet", "declared", false)
	declare(t3, c["not-opted-in"], "testnet", "verified", false)
	// A hubble row of the same contract and day: a complete ledger_files day replaces it (D3).
	if _, err := su.Exec(ctx, `INSERT INTO scf.onchain_daily (tenant_id, contract_ref, day, invocations, successful_invocations,
	    distinct_invokers, data_source) VALUES ($1, $2, '2026-11-03', 99, 99, 9, 'hubble')`, t1, refVerified); err != nil {
		t.Fatal(err)
	}

	// 1. fetch: the store over HTTPS into the mirror (the test CA through SSL_CERT_FILE).
	mirror := t.TempDir()
	fetch := exec.Command(readerBin, "fetch", "-network", "testnet", "-source", srv.URL, "-dest", mirror,
		"-from-day", "2026-11-02", "-to-day", "2026-11-04", "-keep-days", "0")
	fetch.Env = []string{"SSL_CERT_FILE=" + ca}
	if out, err := fetch.CombinedOutput(); err != nil {
		t.Fatalf("fetch: %v\n%s", err, out)
	} else if !strings.Contains(string(out), "days=3 ") {
		t.Errorf("fetch summary %s", out)
	}

	// 2. the contract list of §p, read as the job (cross-tenant, tenant unset).
	jobs, err := pgx.Connect(ctx, dsn("scf_jobs", "scf"))
	if err != nil {
		t.Fatal(err)
	}
	defer jobs.Close(ctx)
	type target struct{ tenant, ref, contract string }
	var targets []target
	asJob(t, jobs, "", func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, contractListSQL, "testnet")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var x target
			if err := rows.Scan(&x.tenant, &x.ref, &x.contract); err != nil {
				return err
			}
			targets = append(targets, x)
		}
		return rows.Err()
	})
	if len(targets) != 1 || targets[0].contract != c["verified"] || targets[0].tenant != t1 {
		t.Fatalf("contract list = %+v, want only T1's verified testnet contract (no conflict, claimed, other network or opted-out)", targets)
	}

	// 3. the reader over the mirror, contracts on stdin.
	read := exec.Command(readerBin, "-network", "testnet", "-contracts", "-", "-from-day", "2026-11-02", "-to-day", "2026-11-04", mirror)
	read.Env = []string{}
	read.Stdin = strings.NewReader(targets[0].contract + "\n")
	var stdout, stderr bytes.Buffer
	read.Stdout, read.Stderr = &stdout, &stderr
	if err := read.Run(); err != nil {
		t.Fatalf("reader: %v\n%s", err, stderr.String())
	}
	if !strings.Contains(stderr.String(), "files=") || containsAccount(stdout.String()+stderr.String()) {
		t.Fatalf("reader output: %s / %s", stdout.String(), stderr.String())
	}
	var lines []row
	sc := bufio.NewScanner(&stdout)
	for sc.Scan() {
		var r row
		dec := json.NewDecoder(strings.NewReader(sc.Text()))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, r)
	}
	if len(lines) != 3 {
		t.Fatalf("reader lines %+v", lines)
	}

	// 3b. each complete day's anchor (the first ledger after it) matches the network's copy of that ledger's hash, the
	// comparison job onchain_correlation makes with Horizon before it uses a day (C-144).
	for _, r := range lines {
		if r.AnchorLedger == nil || r.AnchorHash == nil || *r.AnchorLedger != r.LedgerLast+1 {
			t.Fatalf("day %s without its anchor: %+v", r.Day, r)
		}
		if want := network[strconv.FormatUint(uint64(*r.AnchorLedger), 10)]; *r.AnchorHash != want {
			t.Fatalf("day %s anchor %d hash %s, network %s", r.Day, *r.AnchorLedger, *r.AnchorHash, want)
		}
	}

	// 4. complete days upserted under the tenant's context.
	asJob(t, jobs, t1, func(tx pgx.Tx) error {
		for _, r := range lines {
			if !r.Complete {
				return fmt.Errorf("day %s incomplete: %+v", r.Day, r)
			}
			if _, err := tx.Exec(ctx, upsertSQL, t1, targets[0].ref, r.Day, r.Invocations, r.SuccessfulInvocations, r.DistinctInvokers); err != nil {
				return err
			}
		}
		return nil
	})

	// 5. what landed.
	got := map[string][4]any{}
	rows, err := su.Query(ctx, `SELECT c.contract_id, o.day::text, o.invocations, o.successful_invocations, o.distinct_invokers, o.data_source
	   FROM scf.onchain_daily o JOIN scf.declared_contracts c USING (tenant_id, contract_ref) ORDER BY 1, 2`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var cid, day, src string
		var inv, ok, who int64
		if err := rows.Scan(&cid, &day, &inv, &ok, &who, &src); err != nil {
			t.Fatal(err)
		}
		if cid != c["verified"] {
			t.Errorf("a row for %s (%s): only the verified, unconflicted contract may be counted", cid, day)
		}
		got[day] = [4]any{inv, ok, who, src}
	}
	rows.Close()
	want := map[string][4]any{
		"2026-11-02": {int64(1), int64(1), int64(1), "ledger_files"},
		"2026-11-03": {int64(4), int64(3), int64(2), "ledger_files"}, // replaced the hubble row
		"2026-11-04": {int64(1), int64(1), int64(1), "ledger_files"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("onchain_daily = %v\nwant           %v", got, want)
	}
}

func evidence(tenant string) string {
	return "0193b7e2-0000-7000-8000-0000000e" + tenant[len(tenant)-4:]
}

// containsAccount reports a G… or M… strkey (an invoker identity) in the reader's output.
func containsAccount(s string) bool {
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return !(r >= 'A' && r <= 'Z' || r >= '2' && r <= '7') }) {
		if (len(f) == 56 && f[0] == 'G') || (len(f) == 69 && f[0] == 'M') {
			return true
		}
	}
	return false
}
