// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// Without the fence, a service-scope erasure deleted the tenant's series in
// _1m, _1h, _1d order while the writer upserted them in _1d, _1h, _1m order; PostgreSQL aborted one side (40P01) and
// the erasure only completed with the writer paused. The fix is the API erasure fence (internal/store/fence.go,
// services/control-plane/src/erasure/fence.ts). These tests run the real writer through PgBouncer.

// retryCounter counts the writer's in-transaction retries (deadlock / serialisation conflicts).
type retryCounter struct{ retried atomic.Int64 }

func (r *retryCounter) Outcome(o string) {
	if o == "retried" {
		r.retried.Add(1)
	}
}
func (*retryCounter) Reason(string, int64)            {}
func (*retryCounter) Points(string, int64)            {}
func (*retryCounter) TxSeconds(time.Duration, string) {}

// fencePayload is one OTLP request of one service over several routes and status codes (the rows the erasure deletes).
func fencePayload(tenant string, now time.Time, i int) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := resource(md, rsrc{tenant: tenant, service: "orders", recv: now})
	ts := now.Add(-30 * time.Second).Add(time.Duration(i) * time.Microsecond) // a distinct request per i
	for r := range 6 {
		for _, status := range []int64{200, 500} {
			explicit(rm, "s", rules.MetricStable, false, ts.Add(-time.Minute), ts, bounds15,
				[]uint64{1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}, 0.02,
				pointAttrs(fmt.Sprintf("/r%d", r), map[string]any{"http.response.status_code": status}))
		}
	}
	return md
}

// eraseOnce is job erasure's scf delete for a service-scope request without a selector: the fence exclusive, then
// the metric deletes — in the order that deadlocked live (_1m first), to show the fence alone prevents the cycle.
func eraseOnce(ctx context.Context, conn *pgx.Conn, tenant string) error {
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, store.APIFenceExclusiveSQL, tenant); err != nil {
			return err
		}
		for _, tbl := range []string{"api_metrics_1m", "api_metrics_1h", "api_metrics_1d"} {
			if _, err := tx.Exec(ctx, `DELETE FROM scf.`+tbl+` WHERE tenant_id = $1`, tenant); err != nil {
				return err
			}
		}
		return nil
	})
}

// The erasure and the writer run concurrently on the same series for a few seconds: no 40P01 on either side, and the
// writer never has to retry a transaction.
func TestErasureFenceNoDeadlockUnderLoad(t *testing.T) {
	tenant := newTenant(t)
	obs := &retryCounter{}
	st := store.New(writerPool(t, 8), store.Options{Observer: obs})
	now := time.Now().UTC()
	conn, err := pgx.Connect(context.Background(), dsn("postgres", "scf", false))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	var applied, writeErrs atomic.Int64
	var seq atomic.Int64
	for range 4 {
		wg.Go(func() {
			for ctx.Err() == nil {
				i := int(seq.Add(1))
				res, err := applyErr(st, fencePayload(tenant, now, i), now)
				if err != nil {
					writeErrs.Add(1)
					t.Errorf("writer: %v", err)
					return
				}
				for _, r := range res {
					applied.Add(int64(r.Applied))
				}
			}
		})
	}
	var erasures, deadlocks int64
	var eraseErr error
	wg.Go(func() {
		for ctx.Err() == nil {
			err := eraseOnce(context.Background(), conn, tenant)
			var pgErr *pgconn.PgError
			switch {
			case errors.As(err, &pgErr) && pgErr.Code == "40P01":
				deadlocks++
			case err != nil:
				eraseErr = err
				return
			default:
				erasures++
			}
			time.Sleep(5 * time.Millisecond)
		}
	})
	wg.Wait()
	if eraseErr != nil {
		t.Fatalf("erasure: %v", eraseErr)
	}
	t.Logf("erasures %d, deadlocks %d, writer points %d, writer retries %d", erasures, deadlocks, applied.Load(),
		obs.retried.Load())
	if deadlocks != 0 || obs.retried.Load() != 0 {
		t.Fatalf("lock conflicts: erasure 40P01 %d, writer retries %d", deadlocks, obs.retried.Load())
	}
	if erasures < 10 || applied.Load() == 0 || writeErrs.Load() != 0 {
		t.Fatalf("too little contention to mean anything: %d erasures, %d points", erasures, applied.Load())
	}
}

// While an erasure holds the fence, a writer transaction of that tenant waits and then commits; another tenant's
// writer is not held back.
func TestErasureFenceHoldsWriterBack(t *testing.T) {
	tenant, other := newTenant(t), newTenant(t)
	st := newStore(t, store.Options{})
	now := time.Now().UTC()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn("postgres", "scf", false))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, store.APIFenceExclusiveSQL, tenant); err != nil {
		t.Fatal(err)
	}
	if res := apply(t, st, fencePayload(other, now, 1), now); res[0].Applied == 0 {
		t.Fatal("another tenant's writer was held back")
	}
	done := make(chan []store.Result, 1)
	go func() {
		res, err := applyErr(st, fencePayload(tenant, now, 1), now)
		if err != nil {
			t.Errorf("writer: %v", err)
		}
		done <- res
	}()
	select {
	case <-done:
		t.Fatal("the writer did not wait for the erasure's fence")
	case <-time.After(500 * time.Millisecond):
	}
	if _, err := tx.Exec(ctx, `DELETE FROM scf.api_metrics_1d WHERE tenant_id = $1`, tenant); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case res := <-done:
		if len(res) != 1 || res[0].Applied != 12 {
			t.Fatalf("after the erasure: %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the writer did not resume after the erasure committed")
	}
}

// applyErr is apply without failing the test from a goroutine.
func applyErr(st *store.Store, md pmetric.Metrics, now time.Time) ([]store.Result, error) {
	body, err := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	if err != nil {
		return nil, err
	}
	b, err := batch.Decode(body, now)
	if err != nil {
		return nil, err
	}
	var out []store.Result
	for _, p := range b.Parts {
		r, err := st.Apply(context.Background(), b.Key, p)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}
