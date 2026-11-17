// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"bytes"
	"crypto/md5" //nolint:gosec // test store: S3-style ETag
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// testStore is an S3-like HTTPS server for one or more Galexie stores: objects by path, optional object metadata
// (x-amz-meta-*, as AWS sends) and ETags, bucket listing with delimiter, request counters and fault injection.
type testStore struct {
	t       *testing.T
	srv     *httptest.Server
	mu      sync.Mutex
	objects map[string][]byte      // path without leading slash → body
	headers map[string]http.Header // extra headers per path
	gets    map[string]int
	heads   map[string]int
	// fault, when set, may answer instead of the store: it returns a status (0 = serve normally) and extra headers.
	fault func(method, path string) (int, http.Header)
	// onGet runs after a batch GET was served (tests interrupt a run from here).
	onGet func(path string)
	uas   map[string]bool
	auth  bool
}

func newTestStore(t *testing.T) *testStore {
	ts := &testStore{t: t, objects: map[string][]byte{}, headers: map[string]http.Header{}, gets: map[string]int{},
		heads: map[string]int{}, uas: map[string]bool{}}
	ts.srv = httptest.NewTLSServer(http.HandlerFunc(ts.serve))
	t.Cleanup(ts.srv.Close)
	return ts
}

func (ts *testStore) url(path string) string { return ts.srv.URL + "/" + path }

func (ts *testStore) client() *http.Client { return ts.srv.Client() }

func (ts *testStore) put(path string, body []byte, h http.Header) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.objects[path] = body
	if h != nil {
		ts.headers[path] = h
	}
}

func (ts *testStore) count(m map[string]int, suffix string) int {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	n := 0
	for p, c := range m {
		if strings.HasSuffix(p, suffix) {
			n += c
		}
	}
	return n
}

func (ts *testStore) serve(w http.ResponseWriter, r *http.Request) {
	ts.mu.Lock()
	ts.uas[r.Header.Get("User-Agent")] = true
	if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		ts.auth = true
	}
	fault := ts.fault
	ts.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/")
	if fault != nil {
		if st, h := fault(r.Method, path); st != 0 {
			for k, v := range h {
				w.Header()[k] = v
			}
			w.WriteHeader(st)
			return
		}
	}
	if path == "" && r.URL.Query().Get("list-type") == "2" {
		ts.list(w, r.URL.Query())
		return
	}
	ts.mu.Lock()
	body, ok := ts.objects[path]
	h := ts.headers[path]
	if ok {
		if r.Method == http.MethodHead {
			ts.heads[path]++
		} else {
			ts.gets[path]++
		}
	}
	onGet := ts.onGet
	ts.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	for k, v := range h {
		w.Header()[k] = v
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
	if onGet != nil && lake.IsBatchFile(path) {
		onGet(path)
	}
}

func (ts *testStore) list(w http.ResponseWriter, q url.Values) {
	prefix := q.Get("prefix")
	ts.mu.Lock()
	seen := map[string]bool{}
	for p := range ts.objects {
		if rest, ok := strings.CutPrefix(p, prefix); ok {
			if i := strings.IndexByte(rest, '/'); i >= 0 {
				seen[prefix+rest[:i+1]] = true
			}
		}
	}
	ts.mu.Unlock()
	var names []string
	for p := range seen {
		names = append(names, p)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>`)
	for _, n := range names {
		fmt.Fprintf(&b, "<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>", n)
	}
	b.WriteString("</ListBucketResult>")
	_, _ = w.Write([]byte(b.String()))
}

// synthStore describes a synthetic network: ledgers 2…last, one every step from base, with invocations.
type synthStore struct {
	base  time.Time
	step  time.Duration
	last  uint32
	txs   map[uint32][]fixture.Tx
	cfg   StoreConfig
	meta  bool // send AWS object metadata
	etag  bool
	noCfg bool
}

func (s synthStore) closeAt(seq uint32) time.Time { return s.base.Add(time.Duration(seq-2) * s.step) }

// ledgers builds ledgers 2…last, chained like a real network's (fixture.Chain).
func (s synthStore) ledgers() map[uint32]xdr.LedgerCloseMeta {
	var ls []xdr.LedgerCloseMeta
	for q := uint32(2); q <= s.last; q++ {
		ls = append(ls, fixture.Ledger(q, s.closeAt(q), q%3 == 0, s.txs[q]))
	}
	out := map[uint32]xdr.LedgerCloseMeta{}
	for _, l := range fixture.Chain(ls) {
		out[l.LedgerSequence()] = l
	}
	return out
}

// install writes the store's config and every batch under prefix ("" or "dir/") of ts.
func (s synthStore) install(t *testing.T, ts *testStore, prefix string) {
	t.Helper()
	if !s.noCfg {
		cfg := s.cfg
		cfg.FileExt = ""
		b, _ := json.Marshal(cfg)
		ts.put(prefix+ConfigName, b, nil)
	}
	l := s.cfg.Layout()
	all := s.ledgers()
	for start := uint64(l.BatchStart(2)); start <= uint64(s.last); start += uint64(l.LedgersPerBatch) {
		first := max(uint32(start), 2)
		lastSeq := l.BatchEnd(uint32(start))
		if lastSeq > s.last {
			break // Galexie writes whole batches only
		}
		var ls []xdr.LedgerCloseMeta
		for q := first; q <= lastSeq; q++ {
			ls = append(ls, all[q])
		}
		var buf bytes.Buffer
		if err := lake.EncodeBatch(&buf, fixture.Batch(ls...)); err != nil {
			t.Fatal(err)
		}
		h := http.Header{}
		if s.etag {
			sum := md5.Sum(buf.Bytes()) //nolint:gosec // test
			h.Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
		}
		if s.meta {
			h.Set("X-Amz-Meta-Start-Ledger", strconv.FormatUint(uint64(first), 10))
			h.Set("X-Amz-Meta-End-Ledger", strconv.FormatUint(uint64(lastSeq), 10))
			h.Set("X-Amz-Meta-Start-Ledger-Close-Time", strconv.FormatInt(s.closeAt(first).Unix(), 10))
			h.Set("X-Amz-Meta-End-Ledger-Close-Time", strconv.FormatInt(s.closeAt(lastSeq).Unix(), 10))
			h.Set("X-Amz-Meta-Network-Passphrase", s.cfg.NetworkPassphrase)
		}
		ts.put(prefix+l.Key(uint32(start)), buf.Bytes(), h)
	}
}

var (
	contractA = fixture.ID("contract-a")
	contractB = fixture.ID("contract-b")
	alice     = fixture.Account(fixture.ID("alice"))
	bob       = fixture.Account(fixture.ID("bob"))
)

// fourDays: a ledger every 30 minutes from 2026-11-01T20:07Z (ledger 2) to ledger 200 (2026-11-05T23:07Z), so day
// boundaries fall inside 8-ledger batches. Invocations of contract A: 2026-11-02T23:37 (ledger 57, the last of
// 11-02), 2026-11-03 (ledgers 60, 70, 100: alice ×2 incl. one failed, bob ×1), 2026-11-04T00:07 (ledger 106, first of
// 11-04).
func fourDays(perBatch uint32, meta bool) synthStore {
	inv := func(src xdr.MuxedAccount, ok bool, seq int64) fixture.Tx {
		return fixture.Tx{Source: src, Contract: &contractA, Function: "f", Success: ok, Seq: seq}
	}
	return synthStore{
		base: time.Date(2026, 11, 1, 20, 7, 0, 0, time.UTC), step: 30 * time.Minute, last: 200,
		txs: map[uint32][]fixture.Tx{
			57:  {inv(alice, true, 1)},
			60:  {inv(alice, true, 2), {Source: bob, Success: true, Seq: 3}},
			70:  {inv(alice, false, 4)},
			100: {inv(bob, true, 5), {Source: alice, Contract: &contractB, Function: "g", Success: true, Seq: 6}},
			106: {inv(bob, true, 7)},
		},
		cfg: StoreConfig{NetworkPassphrase: fixture.Passphrase, Version: "1.0", Compression: "zstd",
			LedgersPerBatch: perBatch, BatchesPerPartition: 16},
		meta: meta, etag: true,
	}
}

func readTestdataStore(t *testing.T, ts *testStore, dir, prefix string) {
	t.Helper()
	var hdrs map[string]map[string]string
	b, err := os.ReadFile(filepath.Join("testdata", dir, "headers.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &hdrs); err != nil {
		t.Fatal(err)
	}
	cfg, err := os.ReadFile(filepath.Join("testdata", dir, ConfigName))
	if err != nil {
		t.Fatal(err)
	}
	ts.put(prefix+ConfigName, cfg, nil)
	for key, hs := range hdrs {
		body, err := os.ReadFile(filepath.Join("testdata", dir, filepath.FromSlash(key)))
		if err != nil {
			t.Fatal(err)
		}
		h := http.Header{}
		for k, v := range hs {
			h.Set(k, v)
		}
		ts.put(prefix+key, body, h)
	}
}
