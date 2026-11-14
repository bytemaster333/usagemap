// SPDX-License-Identifier: Apache-2.0

package batch

import (
	"os"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pmetric"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
)

// The Collector's output for the partner-otel recorded scenario (client_metric_sets: [partner]) decodes into
// integration points only — never API points, never Stellar client points — with migration 0085's dimensions.
func TestPartnerGoldenDecodes(t *testing.T) {
	raw, err := os.ReadFile("../../../../collector/processor/scfsanitizeprocessor/testdata/golden/partner-otel.enabled.metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(raw)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Decode(marshal(t, md), time.Unix(0, 1795097854295000000))
	if err != nil {
		t.Fatal(err)
	}
	p := b.Parts[0]
	if len(p.Points) != 0 || len(p.Stellar) != 0 {
		t.Fatalf("partner metrics became API (%d) or Stellar client (%d) points", len(p.Points), len(p.Stellar))
	}
	for k, n := range p.Drops {
		t.Errorf("unexpected drop %v × %d", k, n)
	}
	if len(p.Integration) == 0 {
		t.Fatal("no integration points")
	}
	for _, s := range p.Integration {
		if s.Metric != rules.MetricPartnerDuration || !s.Histogram || s.Long || s.Dims[0] == "" || s.Dims[1] == "" ||
			s.Dims[2] == "" || s.Dims[3] != "" || !networks[s.Network] {
			t.Errorf("point %+v", s)
		}
		c, err := ConvertExplicit15(s.Snap, s.Min, s.Max)
		if err != nil || uint64(c.Count) != s.Snap.Count {
			t.Errorf("convert %v: %+v %v", s.Dims, c, err)
		}
	}
}

func intMetrics(build func(sm pmetric.ScopeMetrics)) pmetric.Metrics {
	md := pmetric.NewMetrics()
	rm := newRes(md, res{tenant: tA, service: "backend", instance: "_", received: now})
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("@usagemap/payments-otel")
	sm.Scope().SetVersion("0.1.0")
	build(sm)
	return md
}

func TestIntegrationDecodeRules(t *testing.T) {
	x402 := func(extra map[string]any) map[string]any {
		a := map[string]any{"payment.protocol": "x402", "payment.stage": "settled", "payment.network": "stellar:pubnet"}
		for k, v := range extra {
			if v == nil {
				delete(a, k)
			} else {
				a[k] = v
			}
		}
		return a
	}
	cases := []struct {
		name      string
		build     func(sm pmetric.ScopeMetrics)
		malformed int64
		check     func(t *testing.T, p []IntegrationPoint)
	}{
		{"payments x402 settled: scheme, asset, amount bucket", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(4), x402(map[string]any{"payment.scheme": "exact",
				"payment.asset": "USDC", "payment.amount_bucket": "0.01_0.1"}))
		}, 0, func(t *testing.T, p []IntegrationPoint) {
			want := [7]string{"x402", "settled", "exact", "", "USDC", "0.01_0.1", ""}
			if len(p) != 1 || p[0].Dims != want || p[0].Network != "stellar:pubnet" || p[0].Snap.Count != 4 || p[0].Histogram {
				t.Errorf("%+v", p)
			}
		}},
		{"payments mpp failed: method, intent, reason class, error type", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), map[string]any{"payment.protocol": "mpp",
				"payment.stage": "failed", "payment.network": "stellar:testnet", "payment.method": "stellar",
				"payment.intent": "session", "payment.reason_class": "wrong_amount", "error.type": "session/amount-exceeds-deposit"})
		}, 0, func(t *testing.T, p []IntegrationPoint) {
			want := [7]string{"mpp", "failed", "stellar", "session", "", "wrong_amount", "session/amount-exceeds-deposit"}
			if len(p) != 1 || p[0].Dims != want {
				t.Errorf("%+v", p)
			}
		}},
		{"payments: a Stellar network name, both scheme and method, both bucket and reason, no stage refused", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.network": "mainnet"}))
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.scheme": "exact", "payment.method": "stellar"}))
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.amount_bucket": "1_10", "payment.reason_class": "other"}))
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.stage": nil}))
		}, 4, nil},
		{"payments: an address or free text never passes", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.asset": "USDC:G" + strings.Repeat("A", 55)}))
			stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), x402(map[string]any{"payment.stage": "failed", "error.type": "boom: tx failed"}))
		}, 2, nil},
		{"partner: histogram in ms, required dims", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricPartnerDuration, "ms", map[string]any{"stellar.partner": "soroswap",
				"stellar.partner.operation": "/quote", "stellar.partner.outcome": "success", "stellar.network": "mainnet"})
			stellarHist(sm, rules.MetricPartnerDuration, "s", map[string]any{"stellar.partner": "soroswap",
				"stellar.partner.outcome": "success", "stellar.network": "mainnet"})
			stellarHist(sm, rules.MetricPartnerDuration, "s", map[string]any{"stellar.partner": "soroswap",
				"stellar.partner.operation": "/quote", "stellar.partner.outcome": "success", "stellar.network": "stellar:pubnet"})
		}, 2, func(t *testing.T, p []IntegrationPoint) {
			if len(p) != 1 || p[0].Snap.Bounds[0] != 0.005 || p[0].Dims[1] != "/quote" || !p[0].Histogram || p[0].Long {
				t.Errorf("%+v", p)
			}
		}},
		{"partner: a counter under a duration name refused", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricPartnerDuration, true, int64(1), map[string]any{"stellar.partner": "soroswap",
				"stellar.partner.operation": "/quote", "stellar.partner.outcome": "success", "stellar.network": "mainnet"})
		}, 1, nil},
		{"anchor request and event: home domain in its column", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricAnchorRequestDuration, "s", map[string]any{"stellar.sep": "24",
				"stellar.anchor.step": "deposit_interactive", "stellar.anchor.outcome": "ok",
				"stellar.anchor.home_domain": "testanchor.stellar.org", "stellar.network": "testnet"})
			stellarSum(sm, rules.MetricAnchorEvents, true, int64(2), map[string]any{"stellar.anchor.event": "deposit_completed",
				"stellar.sep": "24", "stellar.anchor.home_domain": "testanchor.stellar.org", "stellar.network": "testnet"})
		}, 0, func(t *testing.T, p []IntegrationPoint) {
			if len(p) != 2 || p[0].Dims != [7]string{"24", "deposit_interactive", "ok", "testanchor.stellar.org"} ||
				p[1].Dims != [7]string{"deposit_completed", "24", "testanchor.stellar.org"} {
				t.Errorf("%+v", p)
			}
		}},
		{"anchor platform: transfer duration is long (count and sum), transitions and quotes", func(sm pmetric.ScopeMetrics) {
			stellarHist(sm, rules.MetricAnchorTransferDuration, "s", map[string]any{"stellar.sep": "24",
				"stellar.anchor.kind": "deposit", "stellar.anchor.status": "completed", "stellar.network": "mainnet"})
			stellarSum(sm, rules.MetricAnchorTransitions, true, int64(1), map[string]any{"stellar.sep": "24",
				"stellar.anchor.kind": "deposit", "stellar.anchor.status_from": "_new", "stellar.anchor.status": "incomplete",
				"stellar.network": "mainnet"})
			stellarSum(sm, rules.MetricAnchorQuotesCreated, true, int64(1), map[string]any{"stellar.anchor.client": "_none",
				"stellar.network": "mainnet"})
		}, 0, func(t *testing.T, p []IntegrationPoint) {
			if len(p) != 3 || !p[0].Long || !p[0].Histogram || p[0].Dims != [7]string{"24", "deposit", "", "completed"} ||
				p[1].Dims != [7]string{"24", "deposit", "_new", "incomplete"} || p[2].Dims != [7]string{"", "", "", "", "_none"} {
				t.Errorf("%+v", p)
			}
		}},
		{"anchor: a key-like client or a URL home domain never passes", func(sm pmetric.ScopeMetrics) {
			stellarSum(sm, rules.MetricAnchorQuotesCreated, true, int64(1), map[string]any{
				"stellar.anchor.client": "g" + strings.Repeat("a", 55), "stellar.network": "mainnet"})
			stellarSum(sm, rules.MetricAnchorEvents, true, int64(1), map[string]any{"stellar.anchor.event": "toml_resolved",
				"stellar.anchor.home_domain": "https://anchor.example.org/x?y", "stellar.network": "mainnet"})
			stellarSum(sm, rules.MetricAnchorTransitions, true, int64(1), map[string]any{"stellar.sep": "24",
				"stellar.anchor.kind": "deposit", "stellar.network": "mainnet"}) // statuses missing
		}, 3, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := decode(t, intMetrics(c.build)).Parts[0]
			if n := p.Drops[DropKey{"backend", rules.ReasonMalformedPoint}]; n != c.malformed {
				t.Errorf("malformed %d, want %d (drops %v)", n, c.malformed, p.Drops)
			}
			if len(p.Points) != 0 || len(p.Stellar) != 0 {
				t.Errorf("API points %d, Stellar points %d", len(p.Points), len(p.Stellar))
			}
			if c.check != nil {
				c.check(t, p.Integration)
			}
		})
	}
}

// Integration stream keys differ per series and process and from the Stellar client stream's keys of the same
// service; the source is the service (and explicit instance).
func TestIntegrationStreamKeys(t *testing.T) {
	key := func(instance string, stage string) IntegrationPoint {
		md := pmetric.NewMetrics()
		rm := newRes(md, res{tenant: tA, service: "backend", instance: instance, received: now})
		sm := rm.ScopeMetrics().AppendEmpty()
		stellarSum(sm, rules.MetricPaymentEvents, true, int64(1), map[string]any{"payment.protocol": "x402",
			"payment.stage": stage, "payment.network": "stellar:pubnet"})
		return decode(t, md).Parts[0].Integration[0]
	}
	a, b, d := key("_", "settled"), key("_", "required"), key("pod-1", "settled")
	if a.StreamKey == b.StreamKey || a.StreamKey == d.StreamKey || a.SourceKey != b.SourceKey || a.SourceKey == d.SourceKey ||
		a.SourceKey == a.StreamKey {
		t.Errorf("keys: %x %x %x / %x %x %x", a.StreamKey[:4], b.StreamKey[:4], d.StreamKey[:4], a.SourceKey[:4], b.SourceKey[:4], d.SourceKey[:4])
	}
}
