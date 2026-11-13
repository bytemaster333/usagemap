// SPDX-License-Identifier: Apache-2.0
package pathnorm

import "testing"

// BenchmarkNormalize measures typical inputs of both call sites.
func BenchmarkNormalize(b *testing.B) {
	g1 := sep23Valid[0].key
	cases := []struct {
		name string
		in   string
		o    Options
	}{
		{"root", "/", Options{}},
		{"static_route", "/fee_stats", Options{}},
		{"account_payments", "/accounts/" + g1 + "/payments?cursor=now&order=asc", Options{}},
		{"ledger_int", "/ledgers/61283012/transactions", Options{}},
		{"tx_hash", "/transactions/0e6bc30f2b2f50ca0ecedef5a527309c74964e7daa6018976cd2c686c5df4be3", Options{}},
		{"asset", "/explorer/public/asset/USDC-" + g1 + "-1/holders", Options{}},
		{"uuid", "/disbursements/5e1e3a83-1b19-4b5d-9c8c-7f5a6a2b3c4d/receivers", Options{}},
		{"api_v1_users", "/api/v1/users/42", Options{}},
		{"route_template", "/users/:userId/posts/:postId", Options{Input: InputRoute}},
		{"web_page_relaxed", "/blog/my-post-12345?utm_source=x", Options{Input: InputWebPage, Folding: FoldingRelaxed}},
		{"web_static", "/static/js/main.8e2f1a7c.chunk.js", Options{Input: InputWebPage}},
	}
	for _, c := range cases {
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				Normalize(c.in, c.o)
			}
		})
	}
}

// BenchmarkNormalizeCorpus runs the whole 451-vector corpus per iteration.
func BenchmarkNormalizeCorpus(b *testing.B) {
	vs := loadVectors(b, "testdata/vectors.json")
	opts := make([]Options, len(vs))
	for i, v := range vs {
		opts[i] = modeOptions(b, v.Mode)
	}
	b.ReportAllocs()
	for b.Loop() {
		for i, v := range vs {
			Normalize(v.Input, opts[i])
		}
	}
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*len(vs)), "ns/path")
}

func BenchmarkDecodeStrKey(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		_, _, _ = DecodeStrKey(sep23Valid[0].key)
	}
}
