// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/network"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

var nov6 = func() time.Time { return time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC) }

func opts(ts *testStore, root, dest, from, to string) Options {
	return Options{Source: root, Dest: dest, FromDay: from, ToDay: to, Passphrase: fixture.Passphrase, Parallel: 4,
		Retries: 2, Client: ts.client(), Now: nov6}
}

// countMirror runs the reader's counting over the files the index names for the days (as the reader binary does).
func countMirror(t *testing.T, dir, from, to string) map[string]count.Row {
	t.Helper()
	ix, err := ReadIndex(dir)
	if err != nil || ix == nil {
		t.Fatalf("index: %v", err)
	}
	files, ok := ix.Files(dir, from, to)
	if !ok {
		t.Fatalf("index does not cover %s…%s completely: %+v", from, to, ix.Days)
	}
	c, err := count.New(fixture.Passphrase, []string{fixture.ContractStrkey(contractA)}, from, to)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		b, err := lake.ReadBatchFile(f, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, l := range b.LedgerCloseMetas {
			if err := c.AddLedger(l); err != nil {
				t.Fatal(err)
			}
		}
	}
	if s := c.Stats(); s.UnmatchedResults != 0 {
		t.Fatalf("unmatched results: %d", s.UnmatchedResults)
	}
	out := map[string]count.Row{}
	for _, r := range c.Rows() {
		out[r.Day] = r
	}
	return out
}

func wantDay(t *testing.T, rows map[string]count.Row, day string, inv, ok, who int64, first, last uint32) {
	t.Helper()
	r, have := rows[day]
	if !have {
		t.Fatalf("no row for %s: %+v", day, rows)
	}
	if r.Invocations != inv || r.SuccessfulInvocations != ok || r.DistinctInvokers != who || !r.Complete ||
		r.LedgerFirst != first || r.LedgerLast != last || r.LedgersInDay != int64(last-first+1) {
		t.Errorf("%s: got %+v, want inv %d ok %d who %d ledgers %d-%d complete", day, r, inv, ok, who, first, last)
	}
}

// TestFetchBothLayouts fetches one UTC day from a store with one ledger per object and AWS object metadata (probes
// are HEADs) and from one with eight ledgers per object and none (probes download and decode), and counts it.
func TestFetchBothLayouts(t *testing.T) {
	for _, tc := range []struct {
		name     string
		perBatch uint32
		meta     bool
		from, to uint32 // batch starts of 2026-11-03 incl. the neighbours' boundary ledgers
	}{
		{"aws-1-ledger-metadata", 1, true, 57, 106},
		{"lightsail-8-ledgers-decoded", 8, false, 56, 104},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts := newTestStore(t)
			s := fourDays(tc.perBatch, tc.meta)
			s.install(t, ts, "store/")
			dest := t.TempDir()
			res, err := Run(context.Background(), opts(ts, ts.url("store"), dest, "2026-11-03", "2026-11-03"))
			if err != nil {
				t.Fatal(err)
			}
			ix, _ := ReadIndex(dest)
			d := ix.Days["2026-11-03"]
			if d.FromBatch != tc.from || d.ToBatch != tc.to || !d.Complete {
				t.Fatalf("day range %+v, want %d-%d complete", d, tc.from, tc.to)
			}
			wantBatches := int((tc.to-tc.from)/tc.perBatch) + 1
			if res.Batches != wantBatches || res.Downloaded+res.Present != wantBatches {
				t.Errorf("result %+v, want %d batches", res, wantBatches)
			}
			gets := ts.count(ts.gets, s.cfg.Layout().Ext)
			if tc.meta {
				if gets != wantBatches {
					t.Errorf("GETs %d, want exactly the %d needed batches (probes are HEADs)", gets, wantBatches)
				}
				if ts.count(ts.heads, s.cfg.Layout().Ext) == 0 {
					t.Error("no HEAD probes")
				}
			} else if gets > wantBatches+res.Probes {
				t.Errorf("GETs %d > needed %d + probes %d (probe bodies are reused)", gets, wantBatches, res.Probes)
			}
			wantDay(t, countMirror(t, dest, "2026-11-03", "2026-11-03"), "2026-11-03", 3, 2, 2, 58, 105)
			if ts.auth || len(ts.uas) != 1 || !ts.uas[UserAgent] {
				t.Errorf("requests carried credentials (%v) or another User-Agent (%v)", ts.auth, ts.uas)
			}
		})
	}
}

// TestDayBoundaries fetches three consecutive days in one run: each day's range holds the previous day's last and
// the next day's first ledger, ledgers are assigned to their UTC day of close, and an invocation one ledger either
// side of midnight lands on its own day.
func TestDayBoundaries(t *testing.T) {
	for _, per := range []uint32{1, 8} {
		ts := newTestStore(t)
		fourDays(per, per == 1).install(t, ts, "")
		dest := t.TempDir()
		if _, err := Run(context.Background(), opts(ts, ts.srv.URL, dest, "2026-11-02", "2026-11-04")); err != nil {
			t.Fatal(err)
		}
		rows := countMirror(t, dest, "2026-11-02", "2026-11-04")
		wantDay(t, rows, "2026-11-02", 1, 1, 1, 10, 57)  // ledger 57 closes 23:37 on 11-02
		wantDay(t, rows, "2026-11-03", 3, 2, 2, 58, 105) // 58 closes 00:07 on 11-03
		wantDay(t, rows, "2026-11-04", 1, 1, 1, 106, 153)
		ix, _ := ReadIndex(dest)
		for day, d := range ix.Days {
			l := fourDays(per, false).cfg.Layout()
			first, _, _ := lake.ParseName(l.Key(d.FromBatch))
			_, last, _ := lake.ParseName(l.Key(d.ToBatch))
			s := fourDays(per, false)
			if s.closeAt(first).Format(time.DateOnly) >= day || s.closeAt(last).Format(time.DateOnly) <= day {
				t.Errorf("L=%d %s: range %d-%d does not reach into both neighbouring days", per, day, first, last)
			}
		}
	}
}

// TestResumeAfterInterrupt interrupts a run after a few downloads; the next run locates nothing again (the range is
// in the index), downloads only the missing files, removes stale temporary files and completes the day.
func TestResumeAfterInterrupt(t *testing.T) {
	ts := newTestStore(t)
	s := fourDays(1, true)
	s.install(t, ts, "")
	dest := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	var served atomic.Int32
	ts.onGet = func(string) {
		if served.Add(1) == 10 {
			cancel()
		}
	}
	o := opts(ts, ts.srv.URL, dest, "2026-11-03", "2026-11-03")
	o.Parallel = 2
	if _, err := Run(ctx, o); err == nil {
		t.Fatal("interrupted run reported success")
	}
	ix, _ := ReadIndex(dest)
	if d, ok := ix.Days["2026-11-03"]; !ok || d.Complete {
		t.Fatalf("after the interrupt the day must be recorded and incomplete: %+v", ix.Days)
	}
	have := 0
	_ = filepath.WalkDir(dest, func(p string, d fs.DirEntry, err error) error {
		if err == nil && lake.IsBatchFile(d.Name()) {
			have++
		}
		return nil
	})
	if have == 0 || have >= 50 {
		t.Fatalf("%d files after the interrupt, want some of 50", have)
	}
	stale := filepath.Join(dest, filepath.FromSlash(s.cfg.Layout().Key(80))+partialMark+"dead")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("half"), 0o644); err != nil {
		t.Fatal(err)
	}

	ts.onGet = nil
	headsBefore, getsBefore := ts.count(ts.heads, ".xdr.zst"), ts.count(ts.gets, ".xdr.zst")
	res, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if res.Present != have || res.Downloaded != 50-have {
		t.Errorf("resume: present %d downloaded %d, want %d and %d", res.Present, res.Downloaded, have, 50-have)
	}
	if n := ts.count(ts.heads, ".xdr.zst") - headsBefore; n != 0 {
		t.Errorf("resume probed %d batches again (the range is in the index)", n)
	}
	if n := ts.count(ts.gets, ".xdr.zst") - getsBefore; n != 50-have {
		t.Errorf("resume downloaded %d objects, want %d", n, 50-have)
	}
	if _, err := os.Stat(stale); !errors.Is(err, fs.ErrNotExist) {
		t.Error("stale temporary file left behind")
	}
	wantDay(t, countMirror(t, dest, "2026-11-03", "2026-11-03"), "2026-11-03", 3, 2, 2, 58, 105)
}

// TestMissingConfig: a store without .config.json (pre-v23) is an error unless the layout is given explicitly; an
// explicit layout is refused for a store that has a config.
func TestMissingConfig(t *testing.T) {
	ts := newTestStore(t)
	s := fourDays(1, false)
	s.noCfg = true
	s.cfg.FileExt = ".xdr.zstd"
	s.install(t, ts, "old/")
	dest := t.TempDir()
	o := opts(ts, ts.url("old"), dest, "2026-11-03", "2026-11-03")
	if _, err := Run(context.Background(), o); !errors.Is(err, ErrNoConfig) {
		t.Fatalf("want ErrNoConfig, got %v", err)
	}
	if ix, _ := ReadIndex(dest); ix != nil {
		t.Error("a failed config read must not create an index")
	}
	o.Override = &StoreConfig{Compression: "zstd", LedgersPerBatch: 1, BatchesPerPartition: 16, FileExt: ".xdr.zstd"}
	if _, err := Run(context.Background(), o); err != nil {
		t.Fatalf("explicit layout: %v", err)
	}
	wantDay(t, countMirror(t, dest, "2026-11-03", "2026-11-03"), "2026-11-03", 3, 2, 2, 58, 105)

	fourDays(1, false).install(t, ts, "new/")
	o2 := opts(ts, ts.url("new"), t.TempDir(), "2026-11-03", "2026-11-03")
	o2.Override = o.Override
	if _, err := Run(context.Background(), o2); err == nil || !strings.Contains(err.Error(), "only for stores without") {
		t.Fatalf("explicit layout on a store with a config: %v", err)
	}
}

func TestNetworkMismatchAndBadConfig(t *testing.T) {
	ts := newTestStore(t)
	fourDays(1, true).install(t, ts, "")
	o := opts(ts, ts.srv.URL, t.TempDir(), "2026-11-03", "2026-11-03")
	o.Passphrase = network.PublicNetworkPassphrase
	if _, err := Run(context.Background(), o); err == nil || !strings.Contains(err.Error(), "does not match -network") {
		t.Fatalf("want network mismatch, got %v", err)
	}
	ts.put(ConfigName, []byte(`{"networkPassphrase":"Test SDF Network ; September 2015","compression":"gzip","ledgersPerBatch":1,"batchesPerPartition":1}`), nil)
	if _, err := Run(context.Background(), opts(ts, ts.srv.URL, t.TempDir(), "2026-11-03", "2026-11-03")); err == nil ||
		!strings.Contains(err.Error(), "compression") {
		t.Fatalf("want compression error, got %v", err)
	}
	if _, err := Run(context.Background(), opts(ts, strings.Replace(ts.srv.URL, "https", "http", 1), t.TempDir(), "2026-11-03", "2026-11-03")); err == nil {
		t.Fatal("plain HTTP source accepted")
	}
}

// TestDayNotInStoreYet: the day after the store's newest ledger is not complete, and nothing is marked complete.
func TestDayNotInStoreYet(t *testing.T) {
	ts := newTestStore(t)
	fourDays(8, false).install(t, ts, "")
	dest := t.TempDir()
	_, err := Run(context.Background(), opts(ts, ts.srv.URL, dest, "2026-11-05", "2026-11-05"))
	var ny *NotYetError
	if !errors.As(err, &ny) || !strings.Contains(err.Error(), "not complete in the store yet") {
		t.Fatalf("want NotYetError, got %v", err)
	}
	if ix, _ := ReadIndex(dest); ix != nil && len(ix.Days) != 0 {
		t.Errorf("index records %v", ix.Days)
	}
}

// TestTestnetDiscoveryAndReset: aws-testnet picks the newest reset directory that has a config; after a reset the
// pinned mirror refuses the new store loudly, and an explicit old store explains the reset when a day is missing.
func TestTestnetDiscoveryAndReset(t *testing.T) {
	ts := newTestStore(t)
	old := testnetParentURL
	testnetParentURL = ts.url("ledgers/testnet")
	t.Cleanup(func() { testnetParentURL = old })
	fourDays(1, true).install(t, ts, "ledgers/testnet/2025-06-18/")
	noCfg := fourDays(1, true)
	noCfg.noCfg = true
	noCfg.install(t, ts, "ledgers/testnet/2025-12-17/")
	fourDays(1, true).install(t, ts, "ledgers/testnet/2025-12-18/")

	dest := t.TempDir()
	o := opts(ts, "aws-testnet", dest, "2026-11-03", "2026-11-03")
	res, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != ts.url("ledgers/testnet/2025-12-18") {
		t.Fatalf("discovered %s", res.Source)
	}
	// The parent URL as a configured source (what SCF_ONCHAIN_LEDGER_SOURCE_URL holds) resolves the same way.
	if root, err := ResolveSource(context.Background(), NewHTTP(ts.client(), 0), ts.url("ledgers/testnet/"), true); err != nil ||
		root != ts.url("ledgers/testnet/2025-12-18") {
		t.Fatalf("parent URL resolved to %q, %v", root, err)
	}

	// Reset: a newer store appears.
	reset := fourDays(1, true)
	reset.base = time.Date(2026, 11, 2, 17, 0, 0, 0, time.UTC)
	reset.install(t, ts, "ledgers/testnet/2026-11-02/")
	_, err = Run(context.Background(), opts(ts, "aws-testnet", dest, "2026-11-04", "2026-11-04"))
	var moved *MovedError
	if !errors.As(err, &moved) || !strings.Contains(err.Error(), "testnet was reset") {
		t.Fatalf("want a loud MovedError, got %v", err)
	}
	// The old store pinned explicitly: a day after its end names the reset and the new store.
	_, err = Run(context.Background(), opts(ts, ts.url("ledgers/testnet/2025-12-18"), dest, "2026-11-06", "2026-11-06"))
	if err == nil || !strings.Contains(err.Error(), "testnet was reset, the current store is "+ts.url("ledgers/testnet/2026-11-02")) {
		t.Fatalf("want a reset explanation, got %v", err)
	}
}

func TestRetriesBackoffAndVerification(t *testing.T) {
	ts := newTestStore(t)
	s := fourDays(1, true)
	s.install(t, ts, "")
	var fails atomic.Int32
	key := s.cfg.Layout().Key(80)
	ts.fault = func(method, path string) (int, http.Header) {
		if path == key && method == http.MethodGet {
			switch fails.Add(1) {
			case 1:
				return http.StatusServiceUnavailable, nil
			case 2:
				return http.StatusTooManyRequests, http.Header{"Retry-After": {"2"}}
			}
		}
		return 0, nil
	}
	h := NewHTTP(ts.client(), 3)
	var waits []time.Duration
	h.sleep = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	st, err := OpenStore(context.Background(), h, ts.srv.URL, fixture.Passphrase, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := st.Get(context.Background(), 80, 0)
	if err != nil || !b.Exists || b.First != 80 {
		t.Fatalf("get after 503 and 429: %+v %v", b, err)
	}
	if len(waits) != 2 || waits[1] < 2*time.Second {
		t.Errorf("backoff waits %v, want two with the second honouring Retry-After", waits)
	}
	// 404 is final; a persistent 500 gives up after the retries.
	if b, err := st.Get(context.Background(), 5000, 0); err != nil || b.Exists {
		t.Errorf("missing object: %+v %v", b, err)
	}
	ts.fault = func(string, string) (int, http.Header) { return http.StatusInternalServerError, nil }
	waits = nil
	if _, err := st.Get(context.Background(), 81, 0); err == nil || len(waits) != 3 {
		t.Errorf("persistent 500: err %v after %d waits", err, len(waits))
	}
	ts.fault = nil

	body := ts.objects[s.cfg.Layout().Key(81)]
	hdr := ts.headers[s.cfg.Layout().Key(81)]
	if _, err := st.Verify(context.Background(), 81, body, hdr, 0); err != nil {
		t.Fatalf("good batch: %v", err)
	}
	bad := append([]byte(nil), body...)
	bad[len(bad)-1] ^= 0xff
	if _, err := st.Verify(context.Background(), 81, bad, hdr, 0); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Errorf("corrupt body: %v", err)
	}
	if _, err := st.Verify(context.Background(), 82, body, http.Header{}, 0); err == nil || !strings.Contains(err.Error(), "want 82-82") {
		t.Errorf("batch served under another key: %v", err)
	}
	h2 := hdr.Clone()
	h2.Set("X-Amz-Meta-End-Ledger-Close-Time", "1")
	h2.Del("ETag")
	if _, err := st.Verify(context.Background(), 81, body, h2, 0); err == nil || !strings.Contains(err.Error(), "metadata") {
		t.Errorf("metadata mismatch: %v", err)
	}
	h3 := http.Header{"X-Amz-Meta-Network-Passphrase": {network.PublicNetworkPassphrase}}
	if _, err := st.Verify(context.Background(), 81, body, h3, 0); err == nil {
		t.Error("object of another network accepted")
	}
}

// TestRetention keeps the configured number of days before today and every file a kept day still needs.
func TestRetention(t *testing.T) {
	ts := newTestStore(t)
	fourDays(8, false).install(t, ts, "")
	dest := t.TempDir()
	if _, err := Run(context.Background(), opts(ts, ts.srv.URL, dest, "2026-11-02", "2026-11-03")); err != nil {
		t.Fatal(err)
	}
	o := opts(ts, ts.srv.URL, dest, "2026-11-04", "2026-11-04")
	o.KeepDays = 3 // today 2026-11-06 → keep from 2026-11-03
	res, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	ix, _ := ReadIndex(dest)
	if _, ok := ix.Days["2026-11-02"]; ok {
		t.Error("2026-11-02 not pruned")
	}
	if res.Pruned == 0 {
		t.Error("no file pruned")
	}
	l := fourDays(8, false).cfg.Layout()
	if !present(filepath.Join(dest, filepath.FromSlash(l.Key(56)))) {
		t.Error("the boundary batch shared with the kept day 2026-11-03 was deleted")
	}
	if present(filepath.Join(dest, filepath.FromSlash(l.Key(8)))) {
		t.Error("a batch only 2026-11-02 needed was kept")
	}
	wantDay(t, countMirror(t, dest, "2026-11-03", "2026-11-04"), "2026-11-03", 3, 2, 2, 58, 105)
}

func TestLockRefusesConcurrentFetch(t *testing.T) {
	dest := t.TempDir()
	unlock, err := lockDir(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ts := newTestStore(t)
	fourDays(1, true).install(t, ts, "")
	if _, err := Run(context.Background(), opts(ts, ts.srv.URL, dest, "2026-11-03", "2026-11-03")); err == nil ||
		!strings.Contains(err.Error(), "locked") {
		t.Fatalf("want lock error, got %v", err)
	}
}

func TestResolveSource(t *testing.T) {
	h := NewHTTP(nil, 0)
	for in, want := range map[string]string{"": AWSPubnet, "aws": AWSPubnet, "aws-pubnet": AWSPubnet, "lightsail": Lightsail,
		"https://example.org/store/": "https://example.org/store"} {
		got, err := ResolveSource(context.Background(), h, in, false)
		if err != nil || got != want {
			t.Errorf("%q → %q %v, want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"http://example.org/s", "https://u:p@example.org/s", "https://example.org/s?x=1", "s3://b/k", "ftp://x"} {
		if _, err := ResolveSource(context.Background(), h, bad, false); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// TestLocatedDaysFetchedBeforeAMissingDay: when a later day is not in the store yet, the earlier days are still
// fetched and complete; the run reports the missing day (exit 1).
func TestLocatedDaysFetchedBeforeAMissingDay(t *testing.T) {
	ts := newTestStore(t)
	fourDays(1, true).install(t, ts, "")
	dest := t.TempDir()
	res, err := Run(context.Background(), opts(ts, ts.srv.URL, dest, "2026-11-04", "2026-11-05"))
	var ny *NotYetError
	if !errors.As(err, &ny) || !strings.Contains(err.Error(), "1 of 2 days incomplete") || !strings.Contains(err.Error(), "day 2026-11-05") {
		t.Fatalf("want day 2026-11-05 not yet, got %v", err)
	}
	ix, _ := ReadIndex(dest)
	if d := ix.Days["2026-11-04"]; !d.Complete || res.Downloaded == 0 {
		t.Fatalf("2026-11-04 must be fetched and complete: %+v, %+v", d, res)
	}
	if _, ok := ix.Days["2026-11-05"]; ok {
		t.Error("the missing day is recorded")
	}
}
