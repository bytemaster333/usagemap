// SPDX-License-Identifier: Apache-2.0

package fetch

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stellar/go-stellar-sdk/network"
)

// TestLiveDayBoundary is the one optional check against the real public stores (SCF_ONCHAIN_LIVE=1; a few HEAD
// requests and at most two batch downloads per store, a few MB). It finds the start of a UTC day (yesterday, or
// SCF_ONCHAIN_LIVE_DAY) in the AWS mainnet store (object metadata) and in the Lightsail store (decoding), downloads
// the boundary batch and checks that the previous day's last ledger and the day's first ledger are where the search
// says.
func TestLiveDayBoundary(t *testing.T) {
	if os.Getenv("SCF_ONCHAIN_LIVE") != "1" {
		t.Skip("SCF_ONCHAIN_LIVE=1 not set (live check against the public ledger stores)")
	}
	day := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, -1)
	if v := os.Getenv("SCF_ONCHAIN_LIVE_DAY"); v != "" {
		var err error
		if day, err = time.Parse(time.DateOnly, v); err != nil {
			t.Fatal(err)
		}
	}
	for _, root := range []string{AWSPubnet, Lightsail} {
		t.Run(root, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			h := NewHTTP(nil, 4)
			s, err := OpenStore(ctx, h, root, network.PublicNetworkPassphrase, nil)
			if err != nil {
				t.Fatal(err)
			}
			loc := newLocator(s, 0)
			i, err := loc.firstAtOrAfter(ctx, day.Unix(), 0)
			if err != nil {
				t.Fatal(err)
			}
			start := uint32(i * uint64(s.Config.LedgersPerBatch))
			b, err := s.Get(ctx, start, 0)
			if err != nil || !b.Exists {
				t.Fatalf("get %s: %v (exists %v)", s.Config.Layout().Key(start), err, b.Exists)
			}
			if b.LastClose < day.Unix() {
				t.Fatalf("batch %d-%d closes at %d, before the day", b.First, b.Last, b.LastClose)
			}
			if i > loc.genesis() {
				p, err := loc.probe(ctx, i-1)
				if err != nil || p.LastClose >= day.Unix() {
					t.Fatalf("previous batch closes at %d (err %v), want before %d", p.LastClose, err, day.Unix())
				}
			}
			t.Logf("%s: day %s starts in %s (ledgers %d-%d, closes %s…%s, %d bytes) after %d probes",
				root, day.Format(time.DateOnly), s.Config.Layout().Key(start), b.First, b.Last,
				time.Unix(b.FirstClose, 0).UTC().Format(time.RFC3339), time.Unix(b.LastClose, 0).UTC().Format(time.RFC3339),
				len(b.Body), loc.Probes)
		})
	}
}
