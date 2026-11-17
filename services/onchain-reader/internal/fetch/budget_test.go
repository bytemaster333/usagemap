// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The memory bounds of a fetch run no longer multiply by the number of workers.

func TestBudgetNeverExceedsItsTotal(t *testing.T) {
	b := newBudget(100)
	var inUse, worst atomic.Int64
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := int64(10 + i%5*20) // 10…90
			release, err := b.acquire(context.Background(), n)
			if err != nil {
				t.Error(err)
				return
			}
			v := inUse.Add(n)
			for {
				w := worst.Load()
				if v <= w || worst.CompareAndSwap(w, v) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			inUse.Add(-n)
			release()
			release() // idempotent
		}()
	}
	wg.Wait()
	if worst.Load() > 100 || b.Peak() > 100 {
		t.Fatalf("in use at once %d, peak %d > 100", worst.Load(), b.Peak())
	}
	// larger than the whole budget: takes all of it; a waiter gives up with its context
	all, err := b.acquire(context.Background(), 1_000)
	if err != nil || b.Peak() != 100 {
		t.Fatal(err, b.Peak())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := b.acquire(ctx, 1); err == nil {
		t.Fatal("acquired from an exhausted budget")
	}
	all()
}

func TestRunWithEightWorkersStaysWithinMaxMemory(t *testing.T) {
	ts := newTestStore(t)
	s := fourDays(8, false)
	s.install(t, ts, "store/")
	o := opts(ts, ts.url("store"), t.TempDir(), "2026-11-02", "2026-11-04")
	o.Parallel = 8
	o.MaxMemory = 64 << 10 // a few decoded synthetic batches at most
	res, err := Run(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if res.PeakDecodeBytes == 0 || res.PeakDecodeBytes > o.MaxMemory {
		t.Fatalf("peak %d, bound %d", res.PeakDecodeBytes, o.MaxMemory)
	}
}

func TestDeclaredBodyAboveTheBoundIsRefusedUnreadAndNotRetried(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Length", "999999999")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("x")) // never the rest
	}))
	defer srv.Close()
	h := NewHTTP(srv.Client(), 3)
	h.MaxBody = 1 << 20
	_, err := h.Do(context.Background(), http.MethodGet, srv.URL+"/big")
	if err == nil || !strings.Contains(err.Error(), "larger than the bound") {
		t.Fatalf("err %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("%d requests: a too-large body must not be retried", calls.Load())
	}
}
