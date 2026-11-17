// SPDX-License-Identifier: Apache-2.0

package lake_test

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/fixture"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

func sampleBatch() []byte {
	c := fixture.ID("contract-a")
	l := fixture.Ledger(5, time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC), true, []fixture.Tx{
		{Source: fixture.Account(fixture.ID("alice")), Contract: &c, Function: "f", Success: true, Seq: 1},
	})
	var buf bytes.Buffer
	if err := lake.EncodeBatch(&buf, fixture.Batch(l)); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func TestRoundTrip(t *testing.T) {
	b, err := lake.DecodeBatch(bytes.NewReader(sampleBatch()), 0)
	if err != nil {
		t.Fatal(err)
	}
	if b.StartSequence != 5 || b.EndSequence != 5 || len(b.LedgerCloseMetas) != 1 || b.LedgerCloseMetas[0].LedgerSequence() != 5 {
		t.Fatalf("batch = %+v", b)
	}
}

func TestSizeBound(t *testing.T) {
	if _, err := lake.DecodeBatch(bytes.NewReader(sampleBatch()), 64); !errors.Is(err, lake.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

func TestRejectsCorruptInput(t *testing.T) {
	if _, err := lake.DecodeBatch(bytes.NewReader([]byte("not zstd")), 0); err == nil {
		t.Error("plain bytes accepted")
	}
	enc, _ := zstd.NewWriter(nil)
	junk := enc.EncodeAll([]byte{0, 0, 0, 1, 0, 0, 0, 2, 0xff, 0xff, 0xff, 0xff}, nil)
	if _, err := lake.DecodeBatch(bytes.NewReader(junk), 0); err == nil {
		t.Error("truncated XDR accepted")
	}
	full := sampleBatch()
	raw, _ := zstd.NewReader(nil)
	plain, err := raw.DecodeAll(full, nil)
	if err != nil {
		t.Fatal(err)
	}
	trailing := enc.EncodeAll(append(plain, 0, 0, 0, 0), nil)
	if _, err := lake.DecodeBatch(bytes.NewReader(trailing), 0); err == nil {
		t.Error("trailing bytes accepted")
	}
}

func TestObjectNameMatchesGalexieLayout(t *testing.T) {
	cases := map[string]string{
		lake.ObjectName(0, 64000):     "FFFFFFFF--0-63999/FFFFFFFF--0.xdr.zst",
		lake.ObjectName(64001, 64000): "FFFF05FF--64000-127999/FFFF05FE--64001.xdr.zst",
		lake.ObjectName(10, 1):        "FFFFFFF5--10.xdr.zst",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("ObjectName = %q, want %q", got, want)
		}
	}
}

func TestListFilesWalksAndSorts(t *testing.T) {
	dir := t.TempDir()
	data := sampleBatch()
	for _, seq := range []uint32{3, 1, 64002} {
		p := filepath.Join(dir, filepath.FromSlash(lake.ObjectName(seq, 64000)))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	legacy := filepath.Join(dir, "legacy.xdr.zstd")
	_ = os.WriteFile(legacy, data, 0o600)
	_ = os.WriteFile(filepath.Join(dir, ".config.json"), []byte("{}"), 0o600)
	files, err := lake.ListFiles([]string{dir, legacy})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 4 {
		t.Fatalf("files = %v", files)
	}
	for i := 1; i < len(files); i++ {
		if files[i-1] >= files[i] {
			t.Fatalf("not sorted/unique: %v", files)
		}
	}
	if _, err := lake.ListFiles([]string{filepath.Join(dir, "missing")}); err == nil {
		t.Error("missing path accepted")
	}
	b, err := lake.ReadBatchFile(files[0], 0)
	if err != nil || len(b.LedgerCloseMetas) != 1 {
		t.Fatalf("ReadBatchFile: %v", err)
	}
}

// TestLayoutKeys pins the SEP-54 key scheme for both public mainnet layouts against keys verified on 2026-11-16
// (references/stellar-facts-check-2026-11-16.md F4) and the parser against them.
func TestLayoutKeys(t *testing.T) {
	aws := lake.Layout{LedgersPerBatch: 1, BatchesPerPartition: 64000, Ext: ".xdr.zst"}
	ls := lake.Layout{LedgersPerBatch: 8, BatchesPerPartition: 64000, Ext: ".xdr.zst"}
	old := lake.Layout{LedgersPerBatch: 1, BatchesPerPartition: 1, Ext: ".xdr.zstd"}
	for _, tc := range []struct {
		l          lake.Layout
		seq        uint32
		key        string
		start, end uint32
	}{
		{aws, 2, "FFFFFFFF--0-63999/FFFFFFFD--2.xdr.zst", 2, 2},
		{aws, 65482950, "FC18F9FF--65472000-65535999/FC18CF39--65482950.xdr.zst", 65482950, 65482950},
		{ls, 2, "FFFFFFFF--0-511999/FFFFFFFF--0-7.xdr.zst", 0, 7},
		{ls, 65482955, "FC1FCFFF--65024000-65535999/FC18CF37--65482952-65482959.xdr.zst", 65482952, 65482959},
		{old, 10, "FFFFFFF5--10.xdr.zstd", 10, 10},
	} {
		got := tc.l.Key(tc.seq)
		if got != tc.key {
			t.Errorf("Key(%d) = %q, want %q", tc.seq, got, tc.key)
		}
		s, e, ok := lake.ParseName(got)
		if !ok || s != tc.start || e != tc.end {
			t.Errorf("ParseName(%q) = %d %d %v, want %d %d", got, s, e, ok, tc.start, tc.end)
		}
	}
	for _, bad := range []string{"x.xdr.zst", "FFFFFFFF--1.xdr.zst", "FFFFFFFD--2-1.xdr.zst", "FFFFFFFD--2.json",
		"FFFFFFFD--+2.xdr.zst", "FFFFFFFD--99999999999.xdr.zst", ".config.json"} {
		if _, _, ok := lake.ParseName(bad); ok {
			t.Errorf("ParseName(%q) accepted", bad)
		}
	}
	for _, l := range []lake.Layout{{0, 1, ".xdr.zst"}, {1, 0, ".xdr.zst"}, {1, 1, ".gz"}, {1 << 31, 4, ".xdr.zst"}} {
		if l.Validate() == nil {
			t.Errorf("%+v valid", l)
		}
	}
}

func TestChainHashOfARecordedLedger(t *testing.T) {
	var c lake.Chain
	l := fixture.Ledger(7, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), false, nil)
	if err := c.Add(l); err != nil {
		t.Fatal(err)
	}
	if h, ok := c.Hash(7); !ok || h != [32]byte(l.LedgerHash()) {
		t.Fatalf("Hash(7) = %x, %v", h, ok)
	}
	if _, ok := c.Hash(8); ok {
		t.Fatal("Hash of a ledger never added")
	}
}
