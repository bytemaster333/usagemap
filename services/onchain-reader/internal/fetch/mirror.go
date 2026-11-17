// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// IndexName is the mirror's index file (ignored by the reader's file walk: not a batch file name).
const IndexName = ".mirror.json"

const lockName = ".fetch.lock"

// partialMark is part of every temporary file name; such files are never batch files and are removed at start.
const partialMark = ".partial-"

// Day is one UTC day of the mirror: the batches (by start sequence) that hold its ledgers plus the previous day's
// last and the next day's first ledger.
type Day struct {
	FromBatch uint32    `json:"from_batch"`
	ToBatch   uint32    `json:"to_batch"`
	Complete  bool      `json:"complete"` // every batch of the range is in the mirror and was verified
	UpdatedAt time.Time `json:"updated_at"`
}

// Index records which store the mirror copies and which days it holds. A mirror never mixes stores: after a testnet
// reset the same sequence numbers name different ledgers.
type Index struct {
	Version int            `json:"version"`
	Source  string         `json:"source"`
	Config  StoreConfig    `json:"config"`
	Days    map[string]Day `json:"days"`
	// Dev marks a mirror of a development store (a local Quickstart, RunDev): never network figures.
	Dev bool `json:"dev,omitempty"`
}

// ReadIndex reads dir's index; (nil, nil) when there is none.
func ReadIndex(dir string) (*Index, error) {
	b, err := os.ReadFile(filepath.Join(dir, IndexName))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ix Index
	if err := json.Unmarshal(b, &ix); err != nil {
		return nil, fmt.Errorf("%s: %w", IndexName, err)
	}
	if ix.Version != 1 {
		return nil, fmt.Errorf("%s: unsupported version %d", IndexName, ix.Version)
	}
	if ix.Days == nil {
		ix.Days = map[string]Day{}
	}
	return &ix, nil
}

func (ix *Index) write(dir string) error {
	b, err := json.MarshalIndent(ix, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(dir, IndexName), append(b, '\n'))
}

// Files returns the mirror files that hold the ledgers of the days fromDay…toDay (and their neighbours' boundary
// ledgers), for a reader run that should not decode the whole mirror. ok is false when a day of the range is not a
// complete day of the index or one of its files is missing; the caller then reads every file.
func (ix *Index) Files(dir, fromDay, toDay string) (files []string, ok bool) {
	if ix == nil || fromDay == "" || toDay == "" {
		return nil, false
	}
	from, err1 := time.Parse(time.DateOnly, fromDay)
	to, err2 := time.Parse(time.DateOnly, toDay)
	if err1 != nil || err2 != nil || to.Before(from) {
		return nil, false
	}
	l := ix.Config.Layout()
	if l.Validate() != nil {
		return nil, false
	}
	seen := map[uint32]struct{}{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		day, have := ix.Days[d.Format(time.DateOnly)]
		if !have || !day.Complete {
			return nil, false
		}
		for s := uint64(day.FromBatch); s <= uint64(day.ToBatch); s += uint64(l.LedgersPerBatch) {
			if _, dup := seen[uint32(s)]; dup {
				continue
			}
			seen[uint32(s)] = struct{}{}
			f := filepath.Join(dir, filepath.FromSlash(l.Key(uint32(s))))
			if _, err := os.Stat(f); err != nil {
				return nil, false // a file went missing: read everything, the day comes out incomplete
			}
			files = append(files, f)
		}
	}
	sort.Strings(files)
	return files, true
}

// lockDir takes an exclusive lock on the mirror so two fetches never write it at once; release with the returned
// function.
func lockDir(dir string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(dir, lockName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("the mirror is locked by another fetch: %w", err)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// writeAtomic writes data under a temporary name in the target directory, fsyncs it, renames it into place and
// fsyncs the directory, so a reader or a resumed fetch only ever sees complete files.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var r [6]byte
	if _, err := rand.Read(r[:]); err != nil {
		return err
	}
	tmp := path + partialMark + hex.EncodeToString(r[:])
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(tmp, path)
	}
	if werr != nil {
		_ = os.Remove(tmp)
		return werr
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

var zstdMagic = []byte{0x28, 0xB5, 0x2F, 0xFD}

// present reports whether a complete batch file is already in the mirror. Files appear only by atomic rename after
// verification, so presence means complete; the zstd magic is checked against a file damaged on disk.
func present(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var b [4]byte
	n, _ := f.Read(b[:])
	return n == 4 && bytes.Equal(b[:], zstdMagic)
}

// removePartials deletes temporary files an interrupted run left behind.
func removePartials(dir string) error {
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() && strings.Contains(d.Name(), partialMark) {
			return os.Remove(p)
		}
		return nil
	})
}

// prune removes days before keepFrom (UTC day, "YYYY-MM-DD") that are not in protect, with their batch files unless a
// kept day also needs them, then empty partition directories. It returns the number of files removed.
func (ix *Index) prune(dir, keepFrom string, protect map[string]bool) (int, error) {
	l := ix.Config.Layout()
	keep := map[uint32]struct{}{}
	var drop []string
	for d, day := range ix.Days {
		if d < keepFrom && !protect[d] {
			drop = append(drop, d)
			continue
		}
		for s := uint64(day.FromBatch); s <= uint64(day.ToBatch); s += uint64(l.LedgersPerBatch) {
			keep[uint32(s)] = struct{}{}
		}
	}
	sort.Strings(drop)
	removed := 0
	for _, d := range drop {
		day := ix.Days[d]
		for s := uint64(day.FromBatch); s <= uint64(day.ToBatch); s += uint64(l.LedgersPerBatch) {
			if _, k := keep[uint32(s)]; k {
				continue
			}
			err := os.Remove(filepath.Join(dir, filepath.FromSlash(l.Key(uint32(s)))))
			if err == nil {
				removed++
			} else if !errors.Is(err, fs.ErrNotExist) {
				return removed, err
			}
		}
		delete(ix.Days, d)
	}
	if len(drop) > 0 {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return removed, err
		}
		for _, e := range entries {
			if e.IsDir() && strings.Contains(e.Name(), "--") {
				_ = os.Remove(filepath.Join(dir, e.Name())) // a partition directory; only succeeds when empty
			}
		}
	}
	return removed, nil
}
