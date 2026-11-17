// SPDX-License-Identifier: Apache-2.0

// Package lake reads the public Stellar ledger data files written by Galexie (the ledger exporter): each object is one
// XDR-encoded LedgerCloseMetaBatch, compressed with zstd, named `<hex>--<start>[-<end>].xdr.zst` (older exports use
// `.xdr.zstd`) and grouped in partition directories `<hex>--<start>-<end>/`. The reader works on a local copy (a
// directory tree or single files); package fetch fills that copy from a public store.
package lake

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/klauspost/compress/zstd"
	"github.com/stellar/go-stellar-sdk/xdr"
)

// DefaultMaxDecompressed bounds one decompressed batch. Mainnet batches of one ledger are a few MiB; a batch larger
// than this is refused rather than allowed to exhaust memory (zip-bomb guard).
const DefaultMaxDecompressed int64 = 512 << 20

// ErrTooLarge is returned when a file decompresses to more than the configured bound.
var ErrTooLarge = errors.New("lake: decompressed batch exceeds the size bound")

// IsBatchFile reports whether a file name looks like a ledger data file.
func IsBatchFile(name string) bool {
	return strings.HasSuffix(name, ".xdr.zst") || strings.HasSuffix(name, ".xdr.zstd")
}

// ListFiles expands the given paths: a file is taken as is, a directory is walked for ledger data files. The result is
// sorted and free of duplicates so a run is deterministic.
func ListFiles(paths []string) ([]string, error) {
	seen := map[string]struct{}{}
	var out []string
	add := func(p string) {
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			add(filepath.Clean(p))
			continue
		}
		err = filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type().IsRegular() && IsBatchFile(d.Name()) {
				add(filepath.Clean(path))
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Strings(out)
	return out, nil
}

// FrameContentSize returns the decompressed size a zstd stream declares in its first frame header, when it does.
func FrameContentSize(b []byte) (uint64, bool) {
	var h zstd.Header
	if err := h.Decode(b); err != nil || !h.HasFCS {
		return 0, false
	}
	return h.FrameContentSize, true
}

// DecodeBatch decompresses and decodes one batch. maxDecompressed ≤ 0 means DefaultMaxDecompressed.
func DecodeBatch(r io.Reader, maxDecompressed int64) (xdr.LedgerCloseMetaBatch, error) {
	return DecodeBatchSized(r, maxDecompressed, 0)
}

// DecodeBatchSized is DecodeBatch with the expected decompressed size (0: unknown), so the buffer is allocated once
// instead of growing by doubling (which can hold twice the batch at its peak).
func DecodeBatchSized(r io.Reader, maxDecompressed int64, sizeHint int64) (xdr.LedgerCloseMetaBatch, error) {
	var batch xdr.LedgerCloseMetaBatch
	if maxDecompressed <= 0 {
		maxDecompressed = DefaultMaxDecompressed
	}
	if sizeHint > maxDecompressed {
		return batch, ErrTooLarge
	}
	dec, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(uint64(maxDecompressed)))
	if err != nil {
		return batch, fmt.Errorf("lake: zstd: %w", err)
	}
	defer dec.Close()
	var buf bytes.Buffer
	if sizeHint > 0 {
		buf.Grow(int(sizeHint) + bytes.MinRead)
	}
	n, err := io.Copy(&buf, io.LimitReader(dec, maxDecompressed+1))
	if errors.Is(err, zstd.ErrWindowSizeExceeded) || errors.Is(err, zstd.ErrDecoderSizeExceeded) {
		return batch, ErrTooLarge
	}
	if err != nil {
		return batch, fmt.Errorf("lake: zstd: %w", err)
	}
	if n > maxDecompressed {
		return batch, ErrTooLarge
	}
	if err := xdr.SafeUnmarshal(buf.Bytes(), &batch); err != nil {
		return batch, fmt.Errorf("lake: xdr: %w", err)
	}
	if uint32(batch.EndSequence) < uint32(batch.StartSequence) {
		return batch, fmt.Errorf("lake: batch end %d before start %d", batch.EndSequence, batch.StartSequence)
	}
	return batch, nil
}

// ReadBatchFile opens and decodes one file.
func ReadBatchFile(path string, maxDecompressed int64) (xdr.LedgerCloseMetaBatch, error) {
	f, err := os.Open(path)
	if err != nil {
		return xdr.LedgerCloseMetaBatch{}, err
	}
	defer f.Close()
	b, err := DecodeBatch(f, maxDecompressed)
	if err != nil {
		return b, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return b, nil
}

// EncodeBatch writes a batch in the same format (used by tests and the fixture generator).
func EncodeBatch(w io.Writer, batch xdr.LedgerCloseMetaBatch) error {
	raw, err := batch.MarshalBinary()
	if err != nil {
		return err
	}
	enc, err := zstd.NewWriter(w)
	if err != nil {
		return err
	}
	if _, err := enc.Write(raw); err != nil {
		_ = enc.Close()
		return err
	}
	return enc.Close()
}

// Layout is the key scheme of a Galexie ledger-data store (SEP-54), as declared by its `.config.json`: LedgersPerBatch
// ledgers per object, BatchesPerPartition objects per partition directory, file extension Ext (`.xdr.zst`; stores
// written before Galexie v23 use `.xdr.zstd`). Every key of a store is derived from it.
type Layout struct {
	LedgersPerBatch     uint32
	BatchesPerPartition uint32
	Ext                 string
}

// Validate reports whether the layout can derive keys.
func (l Layout) Validate() error {
	if l.LedgersPerBatch == 0 || l.BatchesPerPartition == 0 {
		return errors.New("lake: ledgersPerBatch and batchesPerPartition must be at least 1")
	}
	if uint64(l.LedgersPerBatch)*uint64(l.BatchesPerPartition) > 1<<32 {
		return errors.New("lake: partition larger than the ledger sequence space")
	}
	if l.Ext != ".xdr.zst" && l.Ext != ".xdr.zstd" {
		return fmt.Errorf("lake: unsupported file extension %q", l.Ext)
	}
	return nil
}

// BatchStart returns the first sequence of the batch that holds seq.
func (l Layout) BatchStart(seq uint32) uint32 { return seq - seq%l.LedgersPerBatch }

// BatchEnd returns the last sequence of the batch that starts at start.
func (l Layout) BatchEnd(start uint32) uint32 {
	if e := uint64(start) + uint64(l.LedgersPerBatch) - 1; e <= uint64(^uint32(0)) {
		return uint32(e)
	}
	return ^uint32(0)
}

// Key returns the object key (relative to the store root, `/`-separated) of the batch that holds seq:
// `<%08X of MaxUint32−partitionStart>--<partitionStart>-<partitionEnd>/<%08X of MaxUint32−batchStart>--<batchStart>[-<batchEnd>]<ext>`;
// one-ledger batches carry only their start; a store of one batch per partition has no partition directory.
func (l Layout) Key(seq uint32) string {
	const maxU32 = ^uint32(0)
	start := l.BatchStart(seq)
	prefix := ""
	if l.BatchesPerPartition > 1 {
		size := uint64(l.LedgersPerBatch) * uint64(l.BatchesPerPartition)
		ps := uint64(seq) / size * size
		pe := min(ps+size-1, uint64(maxU32))
		prefix = fmt.Sprintf("%08X--%d-%d/", maxU32-uint32(ps), ps, pe)
	}
	name := fmt.Sprintf("%08X--%d", maxU32-start, start)
	if l.LedgersPerBatch > 1 {
		name += fmt.Sprintf("-%d", l.BatchEnd(start))
	}
	return prefix + name + l.Ext
}

// ParseName returns the ledger range a batch file name declares (`<hex>--<start>[-<end>].xdr.zst[d]`); ok is false
// for any other name or when the hex prefix does not match the start.
func ParseName(name string) (start, end uint32, ok bool) {
	base := name
	if i := strings.LastIndexByte(base, '/'); i >= 0 {
		base = base[i+1:]
	}
	if i := strings.LastIndexByte(base, filepath.Separator); i >= 0 {
		base = base[i+1:]
	}
	switch {
	case strings.HasSuffix(base, ".xdr.zst"):
		base = strings.TrimSuffix(base, ".xdr.zst")
	case strings.HasSuffix(base, ".xdr.zstd"):
		base = strings.TrimSuffix(base, ".xdr.zstd")
	default:
		return 0, 0, false
	}
	hexPart, rng, found := strings.Cut(base, "--")
	if !found || len(hexPart) != 8 {
		return 0, 0, false
	}
	var h, s, e uint64
	if _, err := fmt.Sscanf(hexPart, "%08X", &h); err != nil {
		return 0, 0, false
	}
	a, b, two := strings.Cut(rng, "-")
	var err error
	if s, err = parseUint32(a); err != nil {
		return 0, 0, false
	}
	e = s
	if two {
		if e, err = parseUint32(b); err != nil || e < s {
			return 0, 0, false
		}
	}
	if uint32(h) != ^uint32(0)-uint32(s) {
		return 0, 0, false
	}
	return uint32(s), uint32(e), true
}

func parseUint32(s string) (uint64, error) {
	if s == "" || len(s) > 10 {
		return 0, errors.New("bad number")
	}
	var v uint64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errors.New("bad number")
		}
		v = v*10 + uint64(c-'0')
	}
	if v > uint64(^uint32(0)) {
		return 0, errors.New("bad number")
	}
	return v, nil
}

// ObjectName returns the Galexie object key of a one-ledger-per-file batch inside a partition of partitionSize
// ledgers, e.g. `FFFFFFFF--0-63999/FFFFFFFE--1.xdr.zst`. Documented so operators can lay out a local mirror.
func ObjectName(seq, partitionSize uint32) string {
	return Layout{LedgersPerBatch: 1, BatchesPerPartition: max(partitionSize, 1), Ext: ".xdr.zst"}.Key(seq)
}
