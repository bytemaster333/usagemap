// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Local development network: a Stellar Quickstart started with `--local --enable core,rpc,galexie` serves its
// Galexie ledger store (SEP-54: .config.json, zstd, one ledger per file, 64,000 files per partition, from ledger 2)
// over plain HTTP at http://localhost:8000/ledger-meta (stellar/quickstart README and local/nginx ledger-meta.conf at
// commit 35a3f46e, 2026-11-12; references/onchain-protocols-quickstart-2026-11-19.md).
const (
	// QuickstartRoot is the store root of a Quickstart on this machine (`-source quickstart`).
	QuickstartRoot = "http://localhost:8000/ledger-meta"
	// StandalonePassphrase is the Quickstart's local network passphrase (`--randomize-network-passphrase` appends
	// " ; <64 hex>").
	StandalonePassphrase = "Standalone Network ; February 2017"
	// DefaultDevMaxLedgers bounds one development fetch (the newest ledgers are kept; ≈ 1 day at 1 ledger/s).
	DefaultDevMaxLedgers = 100_000
)

// IsStandalone reports the standalone network's passphrase, randomised or not. Ledgers of that network are
// development data: they can never verify against mainnet or testnet hashes, and every reader output line marks them.
func IsStandalone(pass string) bool {
	return pass == StandalonePassphrase || strings.HasPrefix(pass, StandalonePassphrase+" ; ")
}

// DevOptions configures RunDev.
type DevOptions struct {
	Source        string // "", "quickstart" or an http(s):// store root of a standalone network
	Dest          string
	Passphrase    string // must be a standalone passphrase
	MaxLedgers    int    // newest ledgers kept (default DefaultDevMaxLedgers)
	Retries       int
	MaxBatchBytes int64
	Client        *http.Client
	Now           func() time.Time
}

// newDevHTTP is NewHTTP for a development store: plain HTTP is accepted (a Quickstart has no TLS), redirects stay on
// the same scheme and host.
func newDevHTTP(c *http.Client, retries int) *HTTP {
	h := NewHTTP(c, retries)
	h.allowHTTP = true
	h.Client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if req.URL.Host != via[0].URL.Host || req.URL.Scheme != via[0].URL.Scheme {
			return errors.New("redirect off the development store refused")
		}
		return nil
	}
	return h
}

// devRoot resolves the development store root.
func devRoot(source string) (string, error) {
	if source == "" || source == "quickstart" {
		return QuickstartRoot, nil
	}
	u, err := url.Parse(source)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" ||
		u.Fragment != "" || u.User != nil {
		return "", errors.New("-source must be quickstart or an http(s):// store root without credentials, query or fragment")
	}
	return strings.TrimRight(source, "/"), nil
}

// RunDev mirrors a development store (a local Quickstart): the store has no complete UTC days to speak of (it
// starts at ledger 2 when the container starts and grows by a ledger a second), so instead of days it copies the
// newest MaxLedgers ledgers, from the newest one present back, into Dest in the same layout. The mirror's index is
// marked dev; the reader walks the whole directory. Every file is verified as in Run (it decodes as its expected
// ledger range, headers and chain checked) before it lands. Refused for any passphrase but the standalone one.
func RunDev(ctx context.Context, o DevOptions) (Result, error) {
	var res Result
	if !IsStandalone(o.Passphrase) {
		return res, errors.New("a development store is accepted only with -network standalone (its ledgers are never network figures)")
	}
	if o.MaxLedgers <= 0 {
		o.MaxLedgers = DefaultDevMaxLedgers
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	root, err := devRoot(o.Source)
	if err != nil {
		return res, err
	}
	res.Source = root
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
	h := newDevHTTP(o.Client, o.Retries)
	store, err := OpenStore(ctx, h, root, o.Passphrase, nil)
	if err != nil {
		return res, fmt.Errorf("%s: %w", root, err)
	}
	store.decode = newBudget(DefaultMaxMemory)
	ix, err := ReadIndex(o.Dest)
	if err != nil {
		return res, err
	}
	if ix == nil {
		ix = &Index{Version: 1, Source: root, Config: store.Config, Days: map[string]Day{}, Dev: true}
	} else if ix.Source != root || ix.Config != store.Config || !ix.Dev {
		return res, &MovedError{From: ix.Source, To: root}
	}
	per := uint64(store.Config.LedgersPerBatch)
	exists := func(batch uint64) (bool, error) {
		res.Probes++
		_, err := h.Do(ctx, http.MethodHead, store.BatchURL(uint32(batch*per)))
		if errors.Is(err, ErrNotFound) {
			return false, nil
		}
		return err == nil, err
	}
	// The store starts at ledger 2 (the batch holding it); the newest batch is found by doubling, then bisection.
	first := uint64(2) / per
	ok, err := exists(first)
	if err != nil {
		return res, err
	}
	if !ok {
		return res, errors.New("the development store holds no ledger yet (is galexie enabled and running?)")
	}
	lo, hi := first, first+1 // lo exists; hi is probed
	for {
		if hi*per > uint64(^uint32(0)) {
			return res, errors.New("the development store reports ledgers beyond the sequence range")
		}
		ok, err := exists(hi)
		if err != nil {
			return res, err
		}
		if !ok {
			break
		}
		lo, hi = hi, hi*2
	}
	for hi-lo > 1 { // invariant: lo exists, hi does not
		mid := lo + (hi-lo)/2
		ok, err := exists(mid)
		if err != nil {
			return res, err
		}
		if ok {
			lo = mid
		} else {
			hi = mid
		}
	}
	// The newest file may still be in the making: it is left for the next run.
	newest := lo
	if newest > first {
		newest--
	}
	oldest := first
	if keep := uint64(o.MaxLedgers) / per; newest+1-first > keep {
		oldest = newest + 1 - max(keep, 1)
	}
	l := store.Config.Layout()
	for b := oldest; b <= newest; b++ {
		start := uint32(b * per)
		p := filepath.Join(o.Dest, filepath.FromSlash(l.Key(start)))
		res.Batches++
		if present(p) {
			res.Present++
			continue
		}
		if err := ctx.Err(); err != nil {
			return res, err
		}
		info, err := store.Get(ctx, start, o.MaxBatchBytes)
		if err != nil {
			return res, err
		}
		if !info.Exists {
			return res, fmt.Errorf("%s: missing in the development store", l.Key(start))
		}
		if err := writeAtomic(p, info.Body); err != nil {
			return res, err
		}
		res.Downloaded++
		res.Bytes += int64(len(info.Body))
	}
	if err := ix.write(o.Dest); err != nil {
		return res, err
	}
	return res, nil
}
