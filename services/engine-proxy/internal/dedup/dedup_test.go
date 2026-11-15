// SPDX-License-Identifier: Apache-2.0

package dedup

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func k(b byte) [16]byte { var x [16]byte; x[0] = b; return x }

func TestFirstForwardsLaterAnswered(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	d := New(Config{Window: time.Hour, Now: func() time.Time { return now }})
	if _, dup, _ := d.Begin(context.Background(), k(1)); dup {
		t.Fatal("first copy must be forwarded")
	}
	d.Finish(k(1), Bot)
	if out, dup, _ := d.Begin(context.Background(), k(1)); !dup || out != Bot {
		t.Fatalf("second copy: %v %v", out, dup)
	}
	now = now.Add(time.Hour + time.Second)
	if _, dup, _ := d.Begin(context.Background(), k(1)); dup {
		t.Fatal("window is bounded")
	}
}

func TestFailedForwardReleasesTheKey(t *testing.T) {
	d := New(Config{})
	_, _, _ = d.Begin(context.Background(), k(2))
	d.Finish(k(2), 0)
	if _, dup, _ := d.Begin(context.Background(), k(2)); dup {
		t.Fatal("a failed forward must not suppress the retry")
	}
}

// Concurrent copies: exactly one is forwarded, the others wait and get its outcome.
func TestConcurrentCopies(t *testing.T) {
	d := New(Config{})
	var owners, dups atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			out, dup, err := d.Begin(context.Background(), k(3))
			if err != nil {
				t.Error(err)
				return
			}
			if dup {
				if out != Stored {
					t.Errorf("dup outcome %v", out)
				}
				dups.Add(1)
				return
			}
			owners.Add(1)
			time.Sleep(10 * time.Millisecond)
			d.Finish(k(3), Stored)
		}()
	}
	close(start)
	wg.Wait()
	if owners.Load() != 1 || dups.Load() != 19 {
		t.Fatalf("owners %d dups %d", owners.Load(), dups.Load())
	}
}

func TestBoundedEntries(t *testing.T) {
	d := New(Config{MaxEntries: 3})
	for i := byte(0); i < 5; i++ {
		_, _, _ = d.Begin(context.Background(), k(i))
		d.Finish(k(i), Stored)
	}
	size, ev, _ := d.Stats()
	if size != 3 || ev != 2 {
		t.Fatalf("size %d evicted %d", size, ev)
	}
	if _, dup, _ := d.Begin(context.Background(), k(0)); dup {
		t.Fatal("evicted key still remembered")
	}
}

func TestWaitHonoursContext(t *testing.T) {
	d := New(Config{})
	_, _, _ = d.Begin(context.Background(), k(9))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, _, err := d.Begin(ctx, k(9)); err == nil {
		t.Fatal("must give up with the request")
	}
}
