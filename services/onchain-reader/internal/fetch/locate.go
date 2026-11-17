// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/stellar/go-stellar-sdk/xdr"
)

// NotYetError is returned when the store's newest batch closes before the wanted time: the day is not complete in
// the store yet (or the store stopped, e.g. a testnet store after a reset).
type NotYetError struct {
	Want      time.Time
	TipLedger uint32
	TipClose  time.Time
}

func (e *NotYetError) Error() string {
	return fmt.Sprintf("the store has no ledger closed at or after %s yet (newest: ledger %d, closed %s)",
		e.Want.UTC().Format(time.RFC3339), e.TipLedger, e.TipClose.UTC().Format(time.RFC3339))
}

func seqAndClose(lcm xdr.LedgerCloseMeta) (seq uint32, closeUnix int64, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("ledger: unsupported structure: %v", r)
		}
	}()
	return lcm.LedgerSequence(), lcm.ClosedAt().Unix(), nil
}

// locator finds day boundaries in a store by searching batch close times. Batches are addressed by index
// (start sequence / ledgers per batch). Probes are cached for the run, so consecutive boundaries are cheap.
type locator struct {
	store    *Store
	maxBytes int64
	mu       sync.Mutex
	probes   map[uint64]BatchInfo
	// bodyBudget bounds the probe bodies kept for reuse (stores without object metadata).
	bodyBudget int64
	// Probes counts the requests made (tests and the summary line).
	Probes int
	// default seconds per batch before two points are known (a ledger closes about every 5 s).
	defaultRate float64
}

func newLocator(s *Store, maxBytes int64) *locator {
	return &locator{store: s, maxBytes: maxBytes, probes: map[uint64]BatchInfo{}, bodyBudget: 64 << 20,
		defaultRate: 5 * float64(s.Config.LedgersPerBatch)}
}

func (l *locator) per() uint64 { return uint64(l.store.Config.LedgersPerBatch) }

func (l *locator) maxIndex() uint64 { return uint64(^uint32(0)) / l.per() }

func (l *locator) probe(ctx context.Context, i uint64) (BatchInfo, error) {
	l.mu.Lock()
	if b, ok := l.probes[i]; ok {
		l.mu.Unlock()
		return b, nil
	}
	l.mu.Unlock()
	b, err := l.store.Probe(ctx, uint32(i*l.per()), l.maxBytes)
	if err != nil {
		return b, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.Probes++
	if b.Body != nil {
		if int64(len(b.Body)) <= l.bodyBudget {
			l.bodyBudget -= int64(len(b.Body))
		} else {
			b.Body, b.Header = nil, nil
		}
	}
	l.probes[i] = b
	return b, nil
}

// takeBody returns (and forgets) a verified body a probe downloaded for batch index i.
func (l *locator) takeBody(i uint64) (BatchInfo, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.probes[i]
	if !ok || b.Body == nil {
		return BatchInfo{}, false
	}
	l.bodyBudget += int64(len(b.Body))
	out := b
	b.Body, b.Header = nil, nil
	l.probes[i] = b
	return out, true
}

func (l *locator) info(i uint64) BatchInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.probes[i]
}

// genesis returns the index of the store's first batch (Galexie exports from ledger 2).
func (l *locator) genesis() uint64 { return 2 / l.per() }

// firstAtOrAfter returns the smallest batch index whose last ledger closed at or after t (Unix seconds), searching
// from hint (a batch known to close before t, or the store's first batch). Without a bracket it extrapolates from
// the observed close rate with a small overshoot; with one it interpolates, falling back to bisection whenever an
// interpolation step does not halve the bracket, so the worst case stays logarithmic.
func (l *locator) firstAtOrAfter(ctx context.Context, t int64, hint uint64) (uint64, error) {
	anchor := l.genesis()
	a, err := l.probe(ctx, anchor)
	if err != nil {
		return 0, err
	}
	if !a.Exists {
		return 0, fmt.Errorf("the store has no first batch (%s)", l.store.Config.Layout().Key(uint32(anchor*l.per())))
	}
	if a.LastClose >= t {
		return anchor, nil
	}
	lo := anchor
	if hint > anchor {
		h, err := l.probe(ctx, hint)
		if err != nil {
			return 0, err
		}
		if h.Exists && h.LastClose < t {
			lo = hint
		}
	}
	var hi, ceil uint64 // 0 = unknown (index 0 is never a valid hi: the anchor closes before t)
	bisect := false
	for range 256 {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if hi != 0 && hi-lo <= 1 {
			return hi, nil
		}
		lb := l.info(lo)
		var g uint64
		switch {
		case hi != 0:
			hb := l.info(hi)
			if bisect || hb.LastClose <= lb.LastClose {
				g = lo + (hi-lo)/2
			} else {
				g = lo + uint64(float64(hi-lo)*float64(t-lb.LastClose)/float64(hb.LastClose-lb.LastClose))
			}
			g = min(max(g, lo+1), hi-1)
		default:
			rate := l.defaultRate
			if lo > anchor && lb.LastClose > a.LastClose {
				rate = float64(lb.LastClose-a.LastClose) / float64(lo-anchor)
			}
			est := uint64(float64(t-lb.LastClose)/rate) + 1
			est += est/64 + 1
			g = min(lo+est, l.maxIndex())
			if ceil != 0 && g >= ceil {
				g = lo + (ceil-lo)/2
			}
			if g <= lo {
				return 0, &NotYetError{Want: time.Unix(t, 0), TipLedger: lb.Last, TipClose: time.Unix(lb.LastClose, 0)}
			}
		}
		width := hi - lo
		b, err := l.probe(ctx, g)
		if err != nil {
			return 0, err
		}
		switch {
		case !b.Exists && hi != 0:
			return 0, fmt.Errorf("the store has a gap: %s is missing", l.store.Config.Layout().Key(uint32(g*l.per())))
		case !b.Exists:
			ceil = g
			if ceil == lo+1 {
				return 0, &NotYetError{Want: time.Unix(t, 0), TipLedger: lb.Last, TipClose: time.Unix(lb.LastClose, 0)}
			}
		case b.LastClose >= t:
			hi = g
		default:
			lo = g
		}
		if width != 0 {
			bisect = hi-lo > width/2
		}
	}
	return 0, errors.New("day boundary search did not converge")
}

// dayRange returns the batch indexes [from, to] that hold every ledger of the UTC day starting at dayStart plus the
// last ledger of the previous day and the first of the next (the reader needs both to call the day complete).
func (l *locator) dayRange(ctx context.Context, dayStart time.Time, hint uint64) (from, to uint64, err error) {
	t0, t1 := dayStart.Unix(), dayStart.Add(24*time.Hour).Unix()
	a, err := l.firstAtOrAfter(ctx, t0, hint)
	if err != nil {
		return 0, 0, err
	}
	from = a
	if ai := l.info(a); ai.FirstClose >= t0 && a > l.genesis() {
		from = a - 1 // the previous day's last ledger ends the batch before
	}
	to, err = l.firstAtOrAfter(ctx, t1, from)
	if err != nil {
		return 0, 0, err
	}
	return from, to, nil
}
