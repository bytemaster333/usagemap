// SPDX-License-Identifier: Apache-2.0

// Package conformance checks @usagemap/edge-otel against the Go code the
// platform runs: the route normaliser (packages/pathnorm) and the Collector's
// sanitise step (collector/processor/scfsanitizeprocessor). generate.ts prints
// what the middleware produces; nothing is written to disk.
//
// Run: cd packages/edge-otel/conformance && GOWORK=off go test -count=1 ./...
// (needs node ≥ 22.18 on PATH).
package conformance

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/processor/processortest"

	"github.com/bytemaster333/usagemap/collector/processor/scfsanitizeprocessor"
	"github.com/bytemaster333/usagemap/packages/pathnorm"
)

type generated struct {
	Routes []struct {
		Mode  string `json:"mode"`
		Input string `json:"input"`
		Edge  string `json:"edge"`
	} `json:"routes"`
	Export string `json:"export"`
}

var (
	genOnce sync.Once
	gen     generated
	genErr  error
)

func load(t *testing.T) generated {
	t.Helper()
	genOnce.Do(func() {
		var out, errb bytes.Buffer
		cmd := exec.Command("node", "generate.ts")
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			genErr = err
			gen.Export = errb.String()
			return
		}
		genErr = json.Unmarshal(out.Bytes(), &gen)
	})
	if genErr != nil {
		t.Fatalf("node generate.ts: %v\n%s", genErr, gen.Export)
	}
	return gen
}

// The edge route equals pathnorm's route for the same input, and the
// Collector's own pass over it (route mode, as for every metric point's
// http.route) leaves it unchanged.
func TestRoutesMatchPathnorm(t *testing.T) {
	g := load(t)
	if len(g.Routes) < 3000 {
		t.Fatalf("only %d routes generated", len(g.Routes))
	}
	bad := 0
	for _, r := range g.Routes {
		in := pathnorm.InputPath
		if r.Mode == "route" {
			in = pathnorm.InputRoute
		}
		want := pathnorm.Normalize(r.Input, pathnorm.Options{Input: in}).Route
		if r.Edge != want {
			bad++
			if bad <= 20 {
				t.Errorf("%s %q: edge %q, pathnorm %q", r.Mode, r.Input, r.Edge, want)
			}
		}
		if again := pathnorm.NormalizeSpan(pathnorm.SpanInputs{Route: r.Edge}).Route; again != r.Edge {
			t.Errorf("edge route %q is not a fixed point of the Collector (→ %q)", r.Edge, again)
		}
	}
	t.Logf("%d inputs, %d mismatches", len(g.Routes), bad)
}

// The export passes the real sanitise step with every point kept, nothing
// dropped or redacted, and the routes stored as sent.
func TestExportPassesSanitise(t *testing.T) {
	g := load(t)
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics([]byte(g.Export))
	if err != nil {
		t.Fatalf("export is not OTLP/JSON: %v", err)
	}
	if n := md.DataPointCount(); n != 9 {
		t.Fatalf("export has %d data points, want 9", n)
	}
	for _, leak := range []string{"canary", "203.0.113.9", "Mozilla", "client_domain", "lang=", "wallet.example",
		"alice@example.com", "7f8a2c1e", "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"} {
		if strings.Contains(g.Export, leak) {
			t.Errorf("export contains %q", leak)
		}
	}

	var newest int64
	forEachPoint(md, func(_ pcommon.Map, a pcommon.Map, ts pcommon.Timestamp, _ uint64) {
		newest = max(newest, int64(ts))
	})
	ctx := client.NewContext(context.Background(), client.Info{Metadata: client.NewMetadata(map[string][]string{
		scfsanitizeprocessor.MetaTenantID:        {"00000000-0000-4000-8000-00000000c0de"},
		scfsanitizeprocessor.MetaAllowedServices: {"anchor-edge"},
		scfsanitizeprocessor.MetaReceivedAt:      {strconv.FormatInt(newest, 10)},
		scfsanitizeprocessor.MetaTenantLevel:     {"L1"},
	})})
	f := scfsanitizeprocessor.NewFactory()
	sink := new(consumertest.MetricsSink)
	p, err := f.CreateMetrics(context.Background(), processortest.NewNopSettings(f.Type()), f.CreateDefaultConfig(), sink)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = p.Shutdown(context.Background()) }()
	if err := p.ConsumeMetrics(ctx, md); err != nil {
		t.Fatal(err)
	}

	var kept []string
	var keys []string
	for _, out := range sink.AllMetrics() {
		rms := out.ResourceMetrics()
		for i := 0; i < rms.Len(); i++ {
			sms := rms.At(i).ScopeMetrics()
			for j := 0; j < sms.Len(); j++ {
				sm := sms.At(j)
				for k := 0; k < sm.Metrics().Len(); k++ {
					m := sm.Metrics().At(k)
					if sm.Scope().Name() == scfsanitizeprocessor.ScopeName && m.Name() == scfsanitizeprocessor.MetricIngestDropped {
						dps := m.Sum().DataPoints()
						for d := 0; d < dps.Len(); d++ {
							reason, _ := dps.At(d).Attributes().Get(scfsanitizeprocessor.AttrReason)
							t.Errorf("dropped: %s × %d", reason.AsString(), dps.At(d).IntValue())
						}
						continue
					}
					if m.Name() != "http.server.request.duration" {
						t.Errorf("unexpected metric %q", m.Name())
					}
					dps := m.Histogram().DataPoints()
					for d := 0; d < dps.Len(); d++ {
						a := dps.At(d).Attributes()
						a.Range(func(k string, _ pcommon.Value) bool {
							if !slices.Contains(keys, k) {
								keys = append(keys, k)
							}
							return true
						})
						method, _ := a.Get("http.request.method")
						route, _ := a.Get(scfsanitizeprocessor.AttrRoute)
						status, _ := a.Get("http.response.status_code")
						kept = append(kept, method.AsString()+" "+route.AsString()+" "+status.AsString()+" ×"+
							strconv.FormatUint(dps.At(d).Count(), 10))
					}
				}
			}
		}
	}
	sort.Strings(kept)
	want := []string{
		"GET /.well-known/stellar.toml 200 ×1",
		"GET /accounts/{account} 404 ×1",
		"GET /boom 500 ×1",
		"GET /contracts/{contract}/u/{redacted} 200 ×1",
		"GET /files/{wildcard} 200 ×1",
		"GET /sep24/transactions/{id} 200 ×2",
		"POST /auth 200 ×1",
		"_OTHER /coffee 200 ×1",
		"GET /auth 200 ×1",
	}
	sort.Strings(want)
	if !slices.Equal(kept, want) {
		t.Errorf("kept\n  %s\nwant\n  %s", strings.Join(kept, "\n  "), strings.Join(want, "\n  "))
	}
	sort.Strings(keys)
	t.Logf("stored point attributes: %v", keys)
}

func forEachPoint(md pmetric.Metrics, fn func(res, attrs pcommon.Map, ts pcommon.Timestamp, count uint64)) {
	rms := md.ResourceMetrics()
	for i := 0; i < rms.Len(); i++ {
		res := rms.At(i).Resource().Attributes()
		sms := rms.At(i).ScopeMetrics()
		for j := 0; j < sms.Len(); j++ {
			ms := sms.At(j).Metrics()
			for k := 0; k < ms.Len(); k++ {
				if ms.At(k).Type() != pmetric.MetricTypeHistogram {
					continue
				}
				dps := ms.At(k).Histogram().DataPoints()
				for d := 0; d < dps.Len(); d++ {
					fn(res, dps.At(d).Attributes(), dps.At(d).Timestamp(), dps.At(d).Count())
				}
			}
		}
	}
}
