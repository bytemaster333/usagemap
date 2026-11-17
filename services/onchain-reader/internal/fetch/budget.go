// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"sync"
)

// budget is a byte semaphore shared by every worker of a run: a batch is decompressed only after
// its decompressed size (the zstd frame's declared content size, or the per-batch bound when the frame does not
// declare one) has been reserved, so the decoded batches in memory at once never exceed the run's MaxMemory, however
// many workers download in parallel. A reservation larger than the whole budget takes the whole budget.
type budget struct {
	mu    sync.Mutex
	total int64
	free  int64
	peak  int64
	wake  chan struct{}
}

func newBudget(total int64) *budget { return &budget{total: total, free: total} }

// acquire reserves n bytes, waiting until they are free; the returned function gives them back.
func (b *budget) acquire(ctx context.Context, n int64) (func(), error) {
	n = max(min(n, b.total), 1)
	for {
		b.mu.Lock()
		if b.free >= n {
			b.free -= n
			b.peak = max(b.peak, b.total-b.free)
			b.mu.Unlock()
			var once sync.Once
			return func() { once.Do(func() { b.release(n) }) }, nil
		}
		if b.wake == nil {
			b.wake = make(chan struct{})
		}
		w := b.wake
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-w:
		}
	}
}

func (b *budget) release(n int64) {
	b.mu.Lock()
	b.free += n
	if b.wake != nil {
		close(b.wake)
		b.wake = nil
	}
	b.mu.Unlock()
}

// Peak is the largest number of bytes reserved at once (for tests and the run summary).
func (b *budget) Peak() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.peak
}
