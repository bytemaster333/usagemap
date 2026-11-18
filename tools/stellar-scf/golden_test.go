// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/bytemaster333/usagemap/collector/processor/scfsanitizeprocessor"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
)

var update = flag.Bool("update", false, "rewrite testdata/golden from the current output")

// The Collector processor's own goldens (testdata/golden) are its output for
// the SDK fixtures with received_at = newest timestamp + 1 min, level L1, any
// service (fixtures_test.go fixtureRecv). The CLI must report exactly what
// those goldens contain: same kept series, same drop and redaction tallies.
const collectorGoldens = "../../collector/processor/scfsanitizeprocessor/testdata/golden"

const minute = int64(60e9)

func newestMetricTS(t *testing.T, b []byte) int64 {
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(b)
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	forEachMetricPoint(md, func(_ pcommon.Map, _ pmetric.Metric, _ pcommon.Map, ts pcommon.Timestamp) { n = max(n, int64(ts)) })
	return n
}

func newestSpanEnd(t *testing.T, b []byte) int64 {
	td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(b)
	if err != nil {
		t.Fatal(err)
	}
	var n int64
	forEachSpan(td, func(_ pcommon.Map, sp ptrace.Span) { n = max(n, int64(sp.EndTimestamp())) })
	return n
}

// summary is the comparable content of a report or a Collector golden.
type summary struct {
	Kept     []string
	Tallies  []string
	Redacted []string
}

func (s *summary) sort() {
	slices.Sort(s.Kept)
	slices.Sort(s.Tallies)
	slices.Sort(s.Redacted)
}

func seriesKey(name, service, method, route string, status int64, count uint64) string {
	return fmt.Sprintf("%s|%s|%s|%s|%d", name, service, method, route, status) + "|" + strconv.FormatUint(count, 10)
}

func fromReport(r *Report) summary {
	var s summary
	for _, k := range r.Kept {
		s.Kept = append(s.Kept, seriesKey(k.Name, k.Service, k.Method, k.Route, k.Status, k.Count))
	}
	for _, d := range r.Dropped {
		s.Tallies = append(s.Tallies, fmt.Sprintf("%s|%s|%d", d.Reason, d.Service, d.Count))
	}
	for _, d := range r.Redacted {
		s.Redacted = append(s.Redacted, fmt.Sprintf("%s|%s|%d", d.Reason, d.Service, d.Count))
	}
	s.sort()
	return s
}

// merge sums counts of identical series, like Report.finish.
func merge(keys map[string]uint64) []string {
	out := make([]string, 0, len(keys))
	for k, n := range keys {
		out = append(out, k+"|"+strconv.FormatUint(n, 10))
	}
	return out
}

func tallyRow(reason, service string, n int64, s *summary) {
	row := fmt.Sprintf("%s|%s|%d", reason, service, n)
	if reason == scfsanitizeprocessor.ReasonRouteRedacted || reason == scfsanitizeprocessor.ReasonRouteSeedRedacted {
		s.Redacted = append(s.Redacted, row)
	} else {
		s.Tallies = append(s.Tallies, row)
	}
}

func fromMetricsGolden(t *testing.T, b []byte) summary {
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(b)
	if err != nil {
		t.Fatal(err)
	}
	var s summary
	kept := map[string]uint64{}
	for _, r := range md.ResourceMetrics().All() {
		service := strAttr(r.Resource().Attributes(), "service.name")
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if sm.Scope().Name() == scfsanitizeprocessor.ScopeName && m.Name() == scfsanitizeprocessor.MetricIngestDropped {
					for _, dp := range m.Sum().DataPoints().All() {
						a := dp.Attributes()
						tallyRow(strAttr(a, scfsanitizeprocessor.AttrReason), strAttr(a, "service.name"), dp.IntValue(), &s)
					}
					continue
				}
				forEachPointOf(m, func(a pcommon.Map, count uint64) {
					k := fmt.Sprintf("%s|%s|%s|%s|%d", m.Name(), service, strAttr(a, "http.request.method"),
						strAttr(a, scfsanitizeprocessor.AttrRoute), intAttr(a, "http.response.status_code"))
					kept[k] += count
				})
			}
		}
	}
	s.Kept = merge(kept)
	s.sort()
	return s
}

func fromTracesGolden(t *testing.T, b []byte) summary {
	td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(b)
	if err != nil {
		t.Fatal(err)
	}
	var s summary
	kept := map[string]uint64{}
	forEachSpan(td, func(res pcommon.Map, sp ptrace.Span) {
		a := sp.Attributes()
		if strAttr(a, scfsanitizeprocessor.AttrMarker) == scfsanitizeprocessor.MarkerDropped {
			tallyRow(strAttr(a, scfsanitizeprocessor.AttrReason), strAttr(a, "service.name"), intAttr(a, scfsanitizeprocessor.AttrDroppedCount), &s)
			return
		}
		k := fmt.Sprintf("span (SERVER)|%s|%s|%s|%d", strAttr(res, "service.name"), strAttr(a, "http.request.method"),
			strAttr(a, scfsanitizeprocessor.AttrRoute), intAttr(a, "http.response.status_code"))
		kept[k]++
	})
	s.Kept = merge(kept)
	s.sort()
	return s
}

func TestReportsMatchCollectorGoldens(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(sdkFixtures, "*.json"))
	if len(files) < 18 {
		t.Fatalf("expected the processor's SDK fixtures, found %d", len(files))
	}
	for _, f := range files {
		name := filepath.Base(f)
		t.Run(name, func(t *testing.T) {
			in := mustRead(t, f)
			golden, err := os.ReadFile(filepath.Join(collectorGoldens, name))
			if err != nil {
				// A fixture without a Collector golden fails the Collector's own fixture test too.
				t.Fatalf("the Collector has no golden for %s: %v", name, err)
			}
			var recv int64
			var want summary
			if strings.HasSuffix(name, ".metrics.json") {
				recv = newestMetricTS(t, in) + minute
				want = fromMetricsGolden(t, golden)
			} else {
				recv = newestSpanEnd(t, in) + minute
				want = fromTracesGolden(t, golden)
			}
			rep, err := Check(in, Options{Services: "*", Level: "L1", ReceivedAt: strconv.FormatInt(recv, 10)})
			if err != nil {
				t.Fatal(err)
			}
			got := fromReport(rep)
			if !slices.Equal(got.Kept, want.Kept) {
				t.Errorf("kept differs from the Collector golden\n got: %v\nwant: %v", got.Kept, want.Kept)
			}
			if !slices.Equal(got.Tallies, want.Tallies) {
				t.Errorf("drops differ\n got: %v\nwant: %v", got.Tallies, want.Tallies)
			}
			if !slices.Equal(got.Redacted, want.Redacted) {
				t.Errorf("redactions differ\n got: %v\nwant: %v", got.Redacted, want.Redacted)
			}
			if rep.KeptItems+int(rep.DroppedItems()) != rep.InputItems {
				t.Errorf("kept %d + dropped %d != input %d", rep.KeptItems, rep.DroppedItems(), rep.InputItems)
			}

			// The CLI's own golden: the whole JSON report, so wording or
			// hint changes are reviewed.
			b, _ := json.MarshalIndent(rep, "", "  ")
			b = append(b, '\n')
			gp := filepath.Join("testdata", "golden", strings.TrimSuffix(name, ".json")+".report.json")
			if *update {
				if err := os.MkdirAll(filepath.Dir(gp), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(gp, b, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			wantB, err := os.ReadFile(gp)
			if errors.Is(err, os.ErrNotExist) {
				t.Fatalf("%s missing: run go test -run 'TestReportsMatchCollectorGoldens/%s' -update and review it", gp, name)
			}
			if err != nil || !bytes.Equal(wantB, b) {
				t.Errorf("%s differs from the current report (rerun with -update and review the diff)", gp)
			}
		})
	}
}
