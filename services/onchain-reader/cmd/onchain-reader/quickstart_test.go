// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fetch"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

// quickstartStore serves what a Stellar Quickstart (`--local --enable core,rpc,galexie`) serves at
// http://localhost:8000/ledger-meta: plain HTTP, a SEP-54 .config.json with the standalone passphrase, one ledger per
// file from ledger 2, no ETag and no object metadata (Python http.server behind nginx). Ledgers 2…last close one a
// second from start; ledger 5 has app calling the Blend pool and reading the oracle; ledger 6 a direct pool call.
func quickstartStore(t *testing.T, pass string, start time.Time, last uint32) *httptest.Server {
	t.Helper()
	objects := map[string][]byte{
		"/ledger-meta/" + fetch.ConfigName: []byte(`{"networkPassphrase":"` + pass +
			`","version":"1.0","compression":"zstd","ledgersPerBatch":1,"batchesPerPartition":64000}`),
	}
	app, pool, oracle := fixture.ID("app"), fixture.ID("blend-pool"), fixture.ID("reflector")
	alice := fixture.Account(fixture.ID("alice"))
	txs := map[uint32][]fixture.Tx{
		5: {{Source: alice, Contract: &app, Function: "deposit", Success: true, Seq: 1, Footprint: [][32]byte{app, pool, oracle}}},
		6: {{Source: alice, Contract: &pool, Function: "submit", Success: true, Seq: 2, Footprint: [][32]byte{pool}}},
	}
	l := lake.Layout{LedgersPerBatch: 1, BatchesPerPartition: 64000, Ext: ".xdr.zst"}
	var all []xdr.LedgerCloseMeta
	for seq := uint32(2); seq <= last; seq++ {
		all = append(all, fixture.LedgerFor(pass, seq, start.Add(time.Duration(seq-2)*time.Second), seq%2 == 0, txs[seq]))
	}
	for _, lcm := range fixture.Chain(all) {
		var buf bytes.Buffer
		if err := lake.EncodeBatch(&buf, fixture.Batch(lcm)); err != nil {
			t.Fatal(err)
		}
		objects["/ledger-meta/"+l.Key(lcm.LedgerSequence())] = buf.Bytes()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := objects[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", "0")
			return
		}
		_, _ = w.Write(b)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestQuickstartSidecar: `fetch -network standalone -source <quickstart>` mirrors a local Quickstart over plain HTTP
// (the newest ledger is left for the next run), the mirror is marked dev, and every reader mode over it labels every
// output line "dev": true (which the jobs service's strict parsers refuse) and its summary dev=1.
func TestQuickstartSidecar(t *testing.T) {
	day := time.Now().UTC().Truncate(24 * time.Hour).Add(time.Hour)
	srv := quickstartStore(t, fetch.StandalonePassphrase, day, 40)
	httpClient = srv.Client()
	t.Cleanup(func() { httpClient = nil; stdin = os.Stdin })
	dest := t.TempDir()
	var errOut bytes.Buffer
	if code := run([]string{"fetch", "-network", "standalone", "-source", srv.URL + "/ledger-meta", "-dest", dest}, nil, &errOut); code != 0 {
		t.Fatalf("fetch exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(errOut.String(), "files=38 downloaded=38 present=0") || !strings.Contains(errOut.String(), "dev=1") {
		t.Errorf("fetch summary = %q (want ledgers 2…39: the newest is left)", errOut.String())
	}
	ix, err := fetch.ReadIndex(dest)
	if err != nil || ix == nil || !ix.Dev {
		t.Fatalf("index = %+v, %v", ix, err)
	}
	// A second run downloads nothing new but the ledger left last time.
	errOut.Reset()
	if code := run([]string{"fetch", "-network", "quickstart", "-source", srv.URL + "/ledger-meta", "-dest", dest}, nil, &errOut); code != 0 ||
		!strings.Contains(errOut.String(), "downloaded=0 present=38") {
		t.Fatalf("second fetch exit %d: %s", code, errOut.String())
	}

	d := day.Format(time.DateOnly)
	app, pool, oracle := fixture.ContractStrkey(fixture.ID("app")), fixture.ContractStrkey(fixture.ID("blend-pool")), fixture.ContractStrkey(fixture.ID("reflector"))
	stdin = strings.NewReader("group proj " + app + "\nprotocol blend " + pool + "\nprotocol reflector " + oracle + "\n")
	var out bytes.Buffer
	errOut.Reset()
	if code := run([]string{"protocols", "-network", "standalone", "-input", "-", "-from-day", d, "-to-day", d, dest}, &out, &errOut); code != 0 {
		t.Fatalf("protocols exit %d: %s", code, errOut.String())
	}
	got := map[string]float64{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatal(err)
		}
		if m["dev"] != true {
			t.Fatalf("line without the dev label: %s", line)
		}
		switch m["kind"] {
		case "protocol":
			got[m["group"].(string)+"/"+m["protocol"].(string)] = m["transactions"].(float64)
		case "network":
			got["network/"+m["protocol"].(string)] = m["transactions"].(float64)
		case "day":
			if m["complete"] != false {
				t.Errorf("a Quickstart day in progress is incomplete: %s", line)
			}
		}
	}
	if got["proj/blend"] != 1 || got["proj/reflector"] != 1 || got["network/blend"] != 2 {
		t.Errorf("figures = %v", got)
	}
	if !strings.Contains(errOut.String(), "network=standalone dev=1") {
		t.Errorf("summary = %q", errOut.String())
	}
	// The counting command and the usage map label their lines too.
	for _, args := range [][]string{
		{"-network", "standalone", "-contract", app, "-from-day", d, "-to-day", d, dest},
		{"usage", "-network", "standalone", "-groups", "-", "-from-day", d, "-to-day", d, dest},
	} {
		stdin = strings.NewReader("proj " + app + "\n")
		out.Reset()
		errOut.Reset()
		if code := run(args, &out, &errOut); code != 0 {
			t.Fatalf("%v: exit %d: %s", args, code, errOut.String())
		}
		for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
			if !strings.HasSuffix(line, `,"dev":true}`) {
				t.Fatalf("%v: line without the dev label: %s", args[0], line)
			}
		}
	}
}

// TestQuickstartRefusals: plain HTTP is accepted for the standalone network only; a store of another network is
// refused by its passphrase; a dev mirror and a network mirror are never mixed.
func TestQuickstartRefusals(t *testing.T) {
	day := time.Date(2026, 11, 3, 1, 0, 0, 0, time.UTC)
	t.Cleanup(func() { httpClient = nil })
	srv := quickstartStore(t, fixture.Passphrase, day, 10) // a testnet store over plain HTTP
	httpClient = srv.Client()
	for _, c := range []struct {
		args []string
		want int
	}{
		{[]string{"fetch", "-network", "testnet", "-source", srv.URL + "/ledger-meta", "-dest", t.TempDir(), "-from-day", "2026-11-03", "-to-day", "2026-11-03"}, 1}, // http for a real network
		{[]string{"fetch", "-network", "testnet", "-source", "quickstart", "-dest", t.TempDir(), "-from-day", "2026-11-03", "-to-day", "2026-11-03"}, 2},             // quickstart needs standalone
		{[]string{"fetch", "-network", "standalone", "-source", srv.URL + "/ledger-meta", "-dest", t.TempDir()}, 1},                                                  // passphrase mismatch
		{[]string{"fetch", "-network", "standalone", "-source", "ftp://localhost/x", "-dest", t.TempDir()}, 1},                                                       // bad scheme
		{[]string{"fetch", "-network", "standalone", "-source", srv.URL + "/ledger-meta", "-dest", t.TempDir(), "-max-ledgers", "0"}, 2},                             // bound
	} {
		var errOut bytes.Buffer
		if got := run(c.args, nil, &errOut); got != c.want {
			t.Errorf("%v: exit %d, want %d (%s)", c.args, got, c.want, errOut.String())
		}
	}
	// A mirror filled from a network store refuses the development store.
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, fetch.IndexName), []byte(`{"version":1,"source":"https://example.invalid/pubnet","config":{"networkPassphrase":"x","compression":"zstd","ledgersPerBatch":1,"batchesPerPartition":64000},"days":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	qs := quickstartStore(t, fetch.StandalonePassphrase, day, 10)
	httpClient = qs.Client()
	var errOut bytes.Buffer
	if got := run([]string{"fetch", "-network", "standalone", "-source", qs.URL + "/ledger-meta", "-dest", dest}, nil, &errOut); got != 1 ||
		!strings.Contains(errOut.String(), "the mirror holds ledgers of store") {
		t.Errorf("mixed mirror: exit %d (%s)", got, errOut.String())
	}
}
