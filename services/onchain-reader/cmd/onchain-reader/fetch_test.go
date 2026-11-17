// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fetch"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// syntheticStore serves a testnet store (one ledger per object, a ledger every 30 min from 2026-11-01T20:07Z to
// ledger 200) with contract-a invoked on 2026-11-03 by alice (twice) and bob. withConfig=false leaves out
// .config.json (a pre-v23 store).
func syntheticStore(t *testing.T, withConfig bool) (*httptest.Server, string) {
	t.Helper()
	objects := map[string][]byte{}
	if withConfig {
		objects["/"+fetch.ConfigName] = []byte(`{"networkPassphrase":"` + fixture.Passphrase +
			`","version":"1.0","compression":"zstd","ledgersPerBatch":1,"batchesPerPartition":64000}`)
	}
	a := fixture.ID("contract-a")
	alice, bob := fixture.Account(fixture.ID("alice")), fixture.Account(fixture.ID("bob"))
	txs := map[uint32][]fixture.Tx{
		60:  {{Source: alice, Contract: &a, Function: "f", Success: true, Seq: 1}},
		70:  {{Source: alice, Contract: &a, Function: "f", Success: false, Seq: 2}},
		100: {{Source: bob, Contract: &a, Function: "f", Success: true, Seq: 3}},
	}
	base := time.Date(2026, 11, 1, 20, 7, 0, 0, time.UTC)
	ext := ".xdr.zst"
	if !withConfig {
		ext = ".xdr.zstd"
	}
	l := lake.Layout{LedgersPerBatch: 1, BatchesPerPartition: 64000, Ext: ext}
	var all []xdr.LedgerCloseMeta
	for seq := uint32(2); seq <= 200; seq++ {
		all = append(all, fixture.Ledger(seq, base.Add(time.Duration(seq-2)*30*time.Minute), false, txs[seq]))
	}
	for _, lcm := range fixture.Chain(all) {
		seq := lcm.LedgerSequence()
		var buf bytes.Buffer
		if err := lake.EncodeBatch(&buf, fixture.Batch([]xdr.LedgerCloseMeta{lcm}...)); err != nil {
			t.Fatal(err)
		}
		objects["/"+l.Key(seq)] = buf.Bytes()
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := objects[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write(b)
		}
	}))
	t.Cleanup(srv.Close)
	httpClient = srv.Client()
	t.Cleanup(func() { httpClient = nil })
	return srv, fixture.ContractStrkey(a)
}

func TestFetchThenCount(t *testing.T) {
	srv, a := syntheticStore(t, true)
	mirror := t.TempDir()
	env := map[string]string{"SCF_ONCHAIN_LEDGER_SOURCE_URL": srv.URL, "SCF_ONCHAIN_LEDGER_DIR": mirror, "SCF_ONCHAIN_LEDGER_KEEP_DAYS": "0"}
	getenv = func(k string) string { return env[k] }
	t.Cleanup(func() { getenv = os.Getenv })
	var out, errOut bytes.Buffer
	if code := run([]string{"fetch", "-network", "testnet", "-from-day", "2026-11-03", "-to-day", "2026-11-03"}, &out, &errOut); code != 0 {
		t.Fatalf("fetch exit %d: %s", code, errOut.String())
	}
	if !regexp.MustCompile(`(?m)^onchain-reader fetch: days=1 files=50 downloaded=50 present=0 bytes=\d+ probes=\d+ pruned=0$`).MatchString(errOut.String()) {
		t.Errorf("fetch summary %q", errOut.String())
	}
	// The mirror also holds files outside the day (a stray one): the reader reads only the indexed day's files.
	stray := filepath.Join(mirror, filepath.FromSlash(lake.ObjectName(5000, 64000)))
	_ = os.MkdirAll(filepath.Dir(stray), 0o755)
	_ = os.WriteFile(stray, []byte("not read"), 0o644)
	out.Reset()
	errOut.Reset()
	if code := run([]string{"-network", "testnet", "-contract", a, "-from-day", "2026-11-03", "-to-day", "2026-11-03", mirror}, &out, &errOut); code != 0 {
		t.Fatalf("reader exit %d: %s", code, errOut.String())
	}
	var r count.Row
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if r.Day != "2026-11-03" || r.Invocations != 3 || r.SuccessfulInvocations != 2 || r.DistinctInvokers != 2 || !r.Complete ||
		r.LedgerFirst != 58 || r.LedgerLast != 105 {
		t.Errorf("row %+v", r)
	}
	if !strings.Contains(errOut.String(), "files=50 ") {
		t.Errorf("reader summary %q (only the day's 50 files must be read)", errOut.String())
	}
	// A second fetch finds everything present.
	errOut.Reset()
	if code := run([]string{"fetch", "-network", "testnet", "-from-day", "2026-11-03", "-to-day", "2026-11-03"}, &out, &errOut); code != 0 ||
		!strings.Contains(errOut.String(), "downloaded=0 present=50") {
		t.Errorf("second fetch exit %d: %s", code, errOut.String())
	}
}

func TestFetchExitCodes(t *testing.T) {
	srv, _ := syntheticStore(t, false)
	getenv = func(string) string { return "" }
	t.Cleanup(func() { getenv = os.Getenv })
	dest := t.TempDir()
	day := []string{"-from-day", "2026-11-03", "-to-day", "2026-11-03"}
	cases := []struct {
		name string
		args []string
		code int
	}{
		{"no dest", append([]string{"fetch", "-source", srv.URL}, day...), 2},
		{"no days", []string{"fetch", "-source", srv.URL, "-dest", dest}, 2},
		{"bad day", []string{"fetch", "-source", srv.URL, "-dest", dest, "-from-day", "2026-13-01", "-to-day", "2026-13-01"}, 2},
		{"reversed days", []string{"fetch", "-source", srv.URL, "-dest", dest, "-from-day", "2026-11-04", "-to-day", "2026-11-03"}, 2},
		{"half a layout", append([]string{"fetch", "-source", srv.URL, "-dest", dest, "-ledgers-per-batch", "1"}, day...), 2},
		{"bad extension", append([]string{"fetch", "-source", srv.URL, "-dest", dest, "-ledgers-per-batch", "1", "-batches-per-partition", "1", "-file-ext", ".gz"}, day...), 2},
		{"stray argument", append([]string{"fetch", "-source", srv.URL, "-dest", dest, "x"}, day...), 2},
		{"plain http source", append([]string{"fetch", "-network", "testnet", "-source", "http://example.org/s", "-dest", dest}, day...), 1},
		{"missing .config.json", append([]string{"fetch", "-network", "testnet", "-source", srv.URL, "-dest", dest}, day...), 1},
		{"explicit layout", append([]string{"fetch", "-network", "testnet", "-source", srv.URL, "-dest", dest,
			"-ledgers-per-batch", "1", "-batches-per-partition", "64000", "-file-ext", ".xdr.zstd"}, day...), 0},
		{"day not in the store", []string{"fetch", "-network", "testnet", "-source", srv.URL, "-dest", t.TempDir(),
			"-ledgers-per-batch", "1", "-batches-per-partition", "64000", "-from-day", "2026-11-06", "-to-day", "2026-11-06"}, 1},
	}
	for _, tc := range cases {
		var out, errOut bytes.Buffer
		if got := run(tc.args, &out, &errOut); got != tc.code {
			t.Errorf("%s: exit %d, want %d (%s)", tc.name, got, tc.code, errOut.String())
		}
		if tc.name == "missing .config.json" && !strings.Contains(errOut.String(), ".config.json") {
			t.Errorf("missing config message: %s", errOut.String())
		}
	}
	t.Setenv("SCF_ONCHAIN_LEDGER_KEEP_DAYS", "x")
	getenv = os.Getenv
	var out, errOut bytes.Buffer
	if got := run([]string{"fetch"}, &out, &errOut); got != 2 {
		t.Errorf("bad SCF_ONCHAIN_LEDGER_KEEP_DAYS: exit %d", got)
	}
}

// TestReaderOnRecordedMainnetFiles counts the recorded AWS mainnet objects (internal/fetch/testdata): every result
// matches its envelope under the mainnet passphrase, the midnight ledger opens 2024-06-01, and a fragment of a day
// is never complete.
func TestReaderOnRecordedMainnetFiles(t *testing.T) {
	const c = "CB5OTV4GV24T5USEZHFVYGC3F4A4MPUQ3LN56E76UK2IT7MJ6QXW4TFS" // invoked in ledger 51920543
	var out, errOut bytes.Buffer
	if code := run([]string{"-network", "pubnet", "-contract", c, "../../internal/fetch/testdata/aws-pubnet"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	rows := map[string]count.Row{}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var r count.Row
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		rows[r.Day] = r
	}
	may, jun := rows["2024-05-31"], rows["2024-06-01"]
	if may.LedgersInDay != 1 || may.LedgerFirst != 51920539 || may.Invocations != 0 || may.Complete {
		t.Errorf("2024-05-31: %+v", may)
	}
	if jun.LedgersInDay != 4 || jun.LedgerFirst != 51920540 || jun.LedgerLast != 51920543 || jun.Invocations != 1 ||
		jun.DistinctInvokers != 1 || jun.Complete {
		t.Errorf("2024-06-01: %+v", jun)
	}
	if !strings.Contains(errOut.String(), "unmatched_results=0") {
		t.Errorf("summary %q", errOut.String())
	}
}
