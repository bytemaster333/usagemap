// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"bytes"
	"context"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/xdr"

	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/count"
	"github.com/bytemaster333/usagemap/services/onchain-reader/internal/lake"
)

// Real batch files recorded from the two public mainnet stores (testdata/SOURCE.md): the UTC midnight of 2024-06-01.
// Ledger 51920539 closed at 2024-05-31T23:59:55Z and 51920540 at 2024-06-01T00:00:01Z; the AWS store holds 51920539-43
// as five one-ledger objects with close-time metadata (51920542-43 carry three contract invocations), Lightsail as
// part of the eight-ledger object 51920536-43.
const (
	realLast  = 51920539 // last ledger of 2024-05-31
	realFirst = 51920540 // first ledger of 2024-06-01
	lsStart   = 51920536
	midnight  = 1717200000
)

func realStore(t *testing.T, dir string) *Store {
	t.Helper()
	ts := newTestStore(t)
	readTestdataStore(t, ts, dir, "")
	st, err := OpenStore(context.Background(), NewHTTP(ts.client(), 0), ts.srv.URL, network.PublicNetworkPassphrase, nil)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func invokedContracts(ls []xdr.LedgerCloseMeta) []string {
	set := map[string]bool{}
	for _, l := range ls {
		for _, env := range l.TransactionEnvelopes() {
			for _, op := range env.Operations() {
				if f := op.Body.InvokeHostFunctionOp; f != nil && f.HostFunction.InvokeContract != nil {
					if id := f.HostFunction.InvokeContract.ContractAddress.ContractId; id != nil {
						s, _ := strkey.Encode(strkey.VersionByteContract, id[:])
						set[s] = true
					}
				}
			}
		}
	}
	var out []string
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func countLedgers(t *testing.T, contracts []string, ls []xdr.LedgerCloseMeta) []count.Row {
	t.Helper()
	c, err := count.New(network.PublicNetworkPassphrase, contracts, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range ls {
		if err := c.AddLedger(l); err != nil {
			t.Fatal(err)
		}
	}
	if s := c.Stats(); s.UnmatchedResults != 0 || s.Transactions == 0 {
		t.Fatalf("stats %+v: every result must match an envelope under the mainnet passphrase", s)
	}
	return c.Rows()
}

func TestRealFilesBothLayouts(t *testing.T) {
	aws := realStore(t, "aws-pubnet")
	if aws.Config.LedgersPerBatch != 1 || aws.Config.BatchesPerPartition != 64000 {
		t.Fatalf("AWS config %+v", aws.Config)
	}
	ls := realStore(t, "lightsail")
	if ls.Config.LedgersPerBatch != 8 || ls.Config.BatchesPerPartition != 64000 {
		t.Fatalf("Lightsail config %+v", ls.Config)
	}
	ctx := context.Background()

	// AWS: a probe is a HEAD answered from the object metadata; the download is checked against ETag (MD5),
	// metadata and content.
	p, err := aws.Probe(ctx, realFirst, 0)
	if err != nil || !p.Exists || p.Body != nil || p.FirstClose != midnight+1 || p.First != realFirst {
		t.Fatalf("AWS probe %+v %v", p, err)
	}
	var awsLedgers []xdr.LedgerCloseMeta
	for seq := uint32(realLast); seq <= lsStart+7; seq++ {
		b, err := aws.Get(ctx, seq, 0)
		if err != nil || !b.Exists {
			t.Fatalf("AWS %d: %v", seq, err)
		}
		batch, err := decode(b.Body)
		if err != nil {
			t.Fatal(err)
		}
		awsLedgers = append(awsLedgers, batch.LedgerCloseMetas...)
	}
	// Lightsail: no metadata, so the probe downloads and decodes; ETag (MD5) still checked.
	lp, err := ls.Probe(ctx, lsStart, 0)
	if err != nil || !lp.Exists || lp.Body == nil || lp.First != lsStart || lp.Last != lsStart+7 {
		t.Fatalf("Lightsail probe %+v %v", lp, err)
	}
	if lp.FirstClose >= midnight || lp.LastClose < midnight {
		t.Fatalf("the Lightsail batch must straddle midnight: %d…%d", lp.FirstClose, lp.LastClose)
	}
	lsBatch, err := decode(lp.Body)
	if err != nil {
		t.Fatal(err)
	}

	// Day boundary: midnight exactly belongs to the new day, for the counter and for the search alike.
	days := map[string][]uint32{}
	for _, l := range lsBatch.LedgerCloseMetas {
		d := l.ClosedAt().UTC().Format(time.DateOnly)
		days[d] = append(days[d], l.LedgerSequence())
	}
	if !reflect.DeepEqual(days, map[string][]uint32{
		"2024-05-31": {lsStart, lsStart + 1, lsStart + 2, realLast},
		"2024-06-01": {realFirst, lsStart + 5, lsStart + 6, lsStart + 7},
	}) {
		t.Fatalf("ledgers by day %v", days)
	}

	// The same ledgers from both layouts count the same.
	var overlap []xdr.LedgerCloseMeta
	for _, l := range lsBatch.LedgerCloseMetas {
		if l.LedgerSequence() >= realLast {
			overlap = append(overlap, l)
		}
	}
	contracts := invokedContracts(lsBatch.LedgerCloseMetas)
	if len(contracts) == 0 {
		t.Fatal("no contract invocation in the recorded ledgers")
	}
	fromAWS := countLedgers(t, contracts, awsLedgers)
	fromLS := countLedgers(t, contracts, overlap)
	if !reflect.DeepEqual(fromAWS, fromLS) {
		t.Fatalf("layouts disagree:\nAWS       %+v\nLightsail %+v", fromAWS, fromLS)
	}
	var overlapInv int64
	for _, r := range fromAWS {
		overlapInv += r.Invocations
	}
	var inv int64
	for _, r := range countLedgers(t, contracts, lsBatch.LedgerCloseMetas) {
		inv += r.Invocations
		if r.Complete {
			t.Errorf("%s: a fragment of a day must not be complete", r.Day)
		}
	}
	if inv == 0 {
		t.Error("no invocation counted in the eight recorded ledgers")
	}
	if overlapInv == 0 {
		t.Error("the ledgers both stores hold carry no invocation: the cross-layout comparison would be vacuous")
	}
	t.Logf("%d contracts invoked in ledgers 51920536-43, %d invocations (%d in the ledgers both stores hold)", len(contracts), inv, overlapInv)
}

func decode(b []byte) (xdr.LedgerCloseMetaBatch, error) {
	return lake.DecodeBatch(bytes.NewReader(b), 0)
}
