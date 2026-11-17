// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Options of one fetch run.
type Options struct {
	Source         string // alias (aws-pubnet, aws-testnet, lightsail) or https:// store root; "" = network default
	Dest           string // the mirror directory
	FromDay, ToDay string // inclusive UTC days, YYYY-MM-DD
	Passphrase     string // network passphrase; the store's config must name the same
	Testnet        bool   // the default source is the newest AWS testnet store
	Parallel       int    // concurrent downloads (default 8)
	Retries        int    // retries per request (default 6)
	KeepDays       int    // days kept before today (UTC); older days are pruned; 0 keeps everything
	MaxBatchBytes  int64  // decompressed size bound of one batch
	// MaxMemory bounds the decompressed batches held at once by all workers together (default 1 GiB); compressed
	// bodies add at most Parallel × DefaultMaxBody. (The bounds do not multiply by the workers.)
	MaxMemory int64
	Override  *StoreConfig
	Client    *http.Client
	Now       func() time.Time
}

// Result counts what a run did (no ledger content, no tenant data).
type Result struct {
	Source     string
	Days       int
	Batches    int
	Downloaded int
	Present    int
	Bytes      int64
	Probes     int
	Pruned     int
	// PeakDecodeBytes is the largest decompressed size reserved at once (≤ MaxMemory).
	PeakDecodeBytes int64
}

// DefaultMaxMemory is the default of Options.MaxMemory.
const DefaultMaxMemory int64 = 1 << 30

// MovedError is returned when the mirror holds another store than the one resolved now (a testnet reset, a changed
// -source or a changed store config). The mirror is never mixed: the operator empties it or points -dest elsewhere.
type MovedError struct{ From, To string }

func (e *MovedError) Error() string {
	if testnetParent(e.From) != "" && testnetParent(e.To) != "" && e.From != e.To {
		return fmt.Sprintf("the testnet store moved from %s to %s (testnet was reset): the mirror holds the old network's ledgers; empty it or use another -dest", e.From, e.To)
	}
	return fmt.Sprintf("the mirror holds ledgers of store %s, not %s (source or store config changed): empty it or use another -dest", e.From, e.To)
}

func days(from, to string) ([]time.Time, error) {
	f, err := time.Parse(time.DateOnly, from)
	if err != nil {
		return nil, fmt.Errorf("invalid -from-day %q", from)
	}
	t, err := time.Parse(time.DateOnly, to)
	if err != nil {
		return nil, fmt.Errorf("invalid -to-day %q", to)
	}
	if t.Before(f) {
		return nil, errors.New("-to-day is before -from-day")
	}
	if t.Sub(f) > 366*24*time.Hour {
		return nil, errors.New("at most 366 days per run")
	}
	var out []time.Time
	for d := f; !d.After(t); d = d.AddDate(0, 0, 1) {
		out = append(out, d)
	}
	return out, nil
}

// ValidateDays checks a day range the way Run does (for usage errors before any I/O).
func ValidateDays(from, to string) error {
	_, err := days(from, to)
	return err
}

// Run fills o.Dest with the batches of the requested days. It is resumable: day ranges are recorded in the index as
// soon as they are known, files appear only by atomic rename after verification, and a later run downloads only what
// is missing. An error means at least one requested day is not complete in the mirror.
func Run(ctx context.Context, o Options) (Result, error) {
	var res Result
	want, err := days(o.FromDay, o.ToDay)
	if err != nil {
		return res, err
	}
	if o.Parallel <= 0 {
		o.Parallel = 8
	}
	if o.Retries < 0 {
		o.Retries = 0
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.MaxMemory <= 0 {
		o.MaxMemory = DefaultMaxMemory
	}
	if err := os.MkdirAll(o.Dest, 0o755); err != nil {
		return res, err
	}
	unlock, err := lockDir(o.Dest)
	if err != nil {
		return res, err
	}
	defer unlock()
	if err := removePartials(o.Dest); err != nil {
		return res, err
	}

	h := NewHTTP(o.Client, o.Retries)
	root, err := ResolveSource(ctx, h, o.Source, o.Testnet)
	if err != nil {
		return res, err
	}
	res.Source = root
	store, err := OpenStore(ctx, h, root, o.Passphrase, o.Override)
	if err != nil {
		return res, fmt.Errorf("%s: %w", root, err)
	}
	store.decode = newBudget(o.MaxMemory)
	ix, err := ReadIndex(o.Dest)
	if err != nil {
		return res, err
	}
	if ix == nil {
		ix = &Index{Version: 1, Source: root, Config: store.Config, Days: map[string]Day{}}
	} else if ix.Source != root || ix.Config != store.Config {
		return res, &MovedError{From: ix.Source, To: root}
	}

	loc := newLocator(store, o.MaxBatchBytes)
	l := store.Config.Layout()
	per := uint64(l.LedgersPerBatch)
	var hint uint64
	requested := map[string]bool{}
	for _, d := range want {
		requested[d.Format(time.DateOnly)] = true
	}
	// Locate the days in order. A day that cannot be located (not in the store yet, a reset) ends the search, but the
	// days located before it are still fetched: the run then reports the rest incomplete (exit 1).
	located := want
	var locErr error
	for i, d := range want {
		key := d.Format(time.DateOnly)
		if day, ok := ix.Days[key]; ok {
			hint = uint64(day.ToBatch)/per - min(uint64(day.ToBatch)/per, 1)
			continue
		}
		from, to, err := loc.dayRange(ctx, d, hint)
		res.Probes = loc.Probes
		if err != nil {
			var ny *NotYetError
			if errors.As(err, &ny) {
				err = notYet(ctx, h, root, key, ny)
			}
			located, locErr = want[:i], fmt.Errorf("day %s: %w", key, err)
			break
		}
		hint = to - min(to, 1)
		ix.Days[key] = Day{FromBatch: uint32(from * per), ToBatch: uint32(to * per), UpdatedAt: o.Now().UTC()}
		if err := ix.write(o.Dest); err != nil {
			return res, err
		}
	}
	res.Probes = loc.Probes
	res.Days = len(want)

	// The batches of every requested day, each once.
	need := map[uint32]struct{}{}
	for _, d := range located {
		day := ix.Days[d.Format(time.DateOnly)]
		for s := uint64(day.FromBatch); s <= uint64(day.ToBatch); s += per {
			need[uint32(s)] = struct{}{}
		}
	}
	starts := make([]uint32, 0, len(need))
	for s := range need {
		starts = append(starts, s)
	}
	sort.Slice(starts, func(i, j int) bool { return starts[i] < starts[j] })
	res.Batches = len(starts)

	path := func(s uint32) string { return filepath.Join(o.Dest, filepath.FromSlash(l.Key(s))) }
	jobs := make(chan uint32)
	var mu sync.Mutex
	firstErr := locErr
	failed := map[uint32]bool{}
	var wg sync.WaitGroup
	for range o.Parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for s := range jobs {
				n, err := download(ctx, store, loc, s, path(s), o.MaxBatchBytes)
				mu.Lock()
				if err != nil {
					failed[s] = true
					if firstErr == nil {
						firstErr = err
					}
				} else {
					res.Downloaded++
					res.Bytes += n
				}
				mu.Unlock()
			}
		}()
	}
	for _, s := range starts {
		if present(path(s)) {
			res.Present++
			continue
		}
		if ctx.Err() != nil {
			mu.Lock()
			failed[s] = true
			if firstErr == nil {
				firstErr = ctx.Err()
			}
			mu.Unlock()
			continue
		}
		jobs <- s
	}
	close(jobs)
	wg.Wait()
	res.PeakDecodeBytes = store.decode.Peak()

	incomplete := len(want) - len(located)
	for _, d := range located {
		key := d.Format(time.DateOnly)
		day := ix.Days[key]
		complete := true
		for s := uint64(day.FromBatch); s <= uint64(day.ToBatch); s += per {
			if failed[uint32(s)] {
				complete = false
				break
			}
		}
		if complete != day.Complete {
			day.Complete, day.UpdatedAt = complete, o.Now().UTC()
			ix.Days[key] = day
		}
		if !complete {
			incomplete++
		}
	}
	if o.KeepDays > 0 {
		keepFrom := o.Now().UTC().AddDate(0, 0, -o.KeepDays).Format(time.DateOnly)
		n, err := ix.prune(o.Dest, keepFrom, requested)
		res.Pruned = n
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if err := ix.write(o.Dest); err != nil && firstErr == nil {
		firstErr = err
	}
	if firstErr != nil {
		return res, fmt.Errorf("%d of %d days incomplete: %w", incomplete, len(want), firstErr)
	}
	return res, nil
}

func download(ctx context.Context, store *Store, loc *locator, start uint32, path string, maxBytes int64) (int64, error) {
	info, ok := loc.takeBody(uint64(start) / uint64(store.Config.LedgersPerBatch))
	if !ok {
		var err error
		info, err = store.Get(ctx, start, maxBytes)
		if err != nil {
			return 0, err
		}
		if !info.Exists {
			return 0, fmt.Errorf("%s: missing in the store", store.Config.Layout().Key(start))
		}
	}
	if err := writeAtomic(path, info.Body); err != nil {
		return 0, err
	}
	return int64(len(info.Body)), nil
}

// notYet explains a day that the store cannot complete: for a dated testnet store it checks whether the network was
// reset (a newer store exists), which would otherwise look like a store that merely lags.
func notYet(ctx context.Context, h *HTTP, root, day string, ny *NotYetError) error {
	parent := testnetParent(root)
	if parent == "" {
		return fmt.Errorf("not complete in the store yet: %w", ny)
	}
	stores, err := TestnetStores(ctx, h, parent)
	if err == nil && len(stores) > 0 && stores[0] != root {
		return fmt.Errorf("testnet store %s ends before %s: testnet was reset, the current store is %s — use -source %s (or aws-testnet) with an empty mirror: %w",
			root, day, stores[0], stores[0], ny)
	}
	return fmt.Errorf("not complete in the store yet: %w", ny)
}
