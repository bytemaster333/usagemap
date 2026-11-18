// SPDX-License-Identifier: Apache-2.0

package slo

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/store"
)

// The fixture month is February 2026: 28 days = 80,640 rounds of 30 s and 8,064 windows of 5 minutes. Probe sources:
// mon-c, probe-d and two edge probers (edge-a1, edge-b1) that vote as one source. Every source records every round
// good, except for these scripted incidents (day = day of month, round = index within the day, 2,880 per day):
//
//	I1 day 3,  rounds 100–109 (10): mon-c and probe-d bad, edges good           → 2 bad votes  → 10 bad
//	I2 day 5,  rounds 0–59    (60): probe-d bad only                            → 1 bad vote   → good
//	I3 day 10, rounds 2000–2019 (20): mon-c silent, probe-d bad, edges good     → 2 voters, 1 bad → good
//	I4 day 12, rounds 500–503 (4): mon-c silent, probe-d and both edges bad     → 2 voters, 2 bad → 4 bad
//	I5 day 20, rounds 0–119  (120): only mon-c reports                          → 1 voter      → 120 unknown
//	I6 day 25, rounds 10–14   (5): edge-a1 bad, edge-b1 good (edges tie = good), mon-c bad → 1 bad vote → good
//	I7 day 26, rounds 10–12   (3): edge-a1 and edge-b1 bad, mon-c bad           → 2 bad votes  → 3 bad
//	H1 day 15, rounds 0–39   (40): host-a only, every source bad (headline unaffected)
//	N1 day 7,  rounds 0–5     (6): node edge-b2, every source bad
//	D1 day 4,  window 12: every journey of mon-c and probe-d fails              → bad window
//	D2 day 9,  window 30: mon-c 3 of 5 fail, probe-d 2 of 5 fail                → only mon-c failed → good
//	D3 day 9,  window 31: mon-c 3 of 5 fail, probe-d 3 of 5 fail                → bad window
//
// Hand calculation:
//
//	headline:  bad = 10 + 4 + 3 = 17; unknown = 120; good = 80,640 − 120 − 17 = 80,503
//	           availability = 80,503 ÷ 80,520 = 0.99978887; bad time = 17 × 0.5 = 8.5 min;
//	           budget = 0.0001 × 80,640 × 0.5 min = 4.032 min; used = 17 ÷ (0.0001 × 80,520) = 211.13 %; objective missed
//	host-a:    bad = 17 + 40 = 57; unknown 120; good 80,463; availability = 80,463 ÷ 80,520 = 0.99929210
//	host-b:    bad = 17; unknown 120; good 80,503
//	edge-b2:   bad = 6; unknown 0; good 80,634; availability = 80,634 ÷ 80,640 = 0.99992560
//	dashboard: bad = 2; unknown 0; good 8,062; availability = 8,062 ÷ 8,064 = 0.99975198; bad time 10 min;
//	           budget = 0.001 × 8,064 × 5 min = 40.32 min; used = 2 ÷ 8.064 = 24.80 %; objective met
const (
	day     = 2880
	feb2026 = "2026-02"
)

func fixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	from, _, _ := MonthRange(feb2026)
	sources := []string{"mon-c", "probe-d", "edge-a1", "edge-b1"}
	in := func(d, r, d0, r0, n int) bool { return d == d0 && r >= r0 && r < r0+n }
	for _, src := range sources {
		w := &store.Writer{Dir: dir, Source: src}
		for d := 1; d <= 28; d++ {
			var rows []store.Row
			for r := range day {
				ts := from.Add(time.Duration((d-1)*day+r) * 30 * time.Second)
				// which sources report this round at all
				if in(d, r, 10, 2000, 20) && src == "mon-c" || in(d, r, 12, 500, 4) && src == "mon-c" ||
					in(d, r, 20, 0, 120) && src != "mon-c" {
					goto node
				}
				{
					bad := false
					switch {
					case in(d, r, 3, 100, 10):
						bad = src == "mon-c" || src == "probe-d"
					case in(d, r, 5, 0, 60), in(d, r, 10, 2000, 20):
						bad = src == "probe-d"
					case in(d, r, 12, 500, 4):
						bad = src != "mon-c"
					case in(d, r, 25, 10, 5):
						bad = src == "edge-a1" || src == "mon-c"
					case in(d, r, 26, 10, 3):
						bad = src == "edge-a1" || src == "edge-b1" || src == "mon-c"
					}
					o := outcome(bad)
					hostA := o
					if in(d, r, 15, 0, 40) {
						hostA = store.Bad
					}
					rows = append(rows,
						store.Row{RoundStart: ts, Source: src, Kind: store.KindRound, Target: "ingest", Outcome: o, Status: 202, LatencyMS: 300},
						store.Row{RoundStart: ts, Source: src, Kind: store.KindHost, Target: "host-a", Outcome: hostA, Status: 202, LatencyMS: 300},
						store.Row{RoundStart: ts, Source: src, Kind: store.KindHost, Target: "host-b", Outcome: o, Status: 202, LatencyMS: 300})
				}
			node:
				rows = append(rows, store.Row{RoundStart: ts, Source: src, Kind: store.KindNode, Target: "edge-b2",
					Outcome: outcome(in(d, r, 7, 0, 6)), Status: 202, LatencyMS: 250})
				// journeys: every 60 s (even rounds), from mon-c, probe-d and edge-a1
				if r%2 == 0 && src != "edge-b1" {
					minute := r / 2
					window, k := minute/5, minute%5
					bad := false
					switch {
					case d == 4 && window == 12:
						bad = src == "mon-c" || src == "probe-d"
					case d == 9 && window == 30:
						bad = (src == "mon-c" && k < 3) || (src == "probe-d" && k < 2)
					case d == 9 && window == 31:
						bad = (src == "mon-c" || src == "probe-d") && k < 3
					}
					rows = append(rows, store.Row{RoundStart: ts, Source: src, Kind: store.KindJourney, Target: "dashboard",
						Outcome: outcome(bad), Status: 200, LatencyMS: 900})
				}
			}
			if err := w.Append(rows...); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}

func outcome(bad bool) string {
	if bad {
		return store.Bad
	}
	return store.Good
}

func find(t *testing.T, rep *Report, kind, target string) Series {
	t.Helper()
	for _, s := range rep.Series {
		if s.Kind == kind && s.Target == target {
			return s
		}
	}
	t.Fatalf("series %s/%s missing", kind, target)
	return Series{}
}

func near(a, b float64) bool { return math.Abs(a-b) < 5e-9 }

func TestFixtureMonthMatchesHandCalculation(t *testing.T) {
	dir := fixture(t)
	rep, err := Compute(dir, feb2026)
	if err != nil {
		t.Fatal(err)
	}
	type want struct {
		kind, target          string
		slots, good, bad, unk int
		avail                 float64
	}
	for _, w := range []want{
		{store.KindRound, "ingest", 80640, 80503, 17, 120, 80503.0 / 80520},
		{store.KindHost, "host-a", 80640, 80463, 57, 120, 80463.0 / 80520},
		{store.KindHost, "host-b", 80640, 80503, 17, 120, 80503.0 / 80520},
		{store.KindNode, "edge-b2", 80640, 80634, 6, 0, 80634.0 / 80640},
		{store.KindJourney, "dashboard", 8064, 8062, 2, 0, 8062.0 / 8064},
	} {
		s := find(t, rep, w.kind, w.target)
		if s.Slots != w.slots || s.Good != w.good || s.Bad != w.bad || s.Unknown != w.unk || !near(s.Availability(), w.avail) {
			t.Errorf("%s/%s: got slots=%d good=%d bad=%d unknown=%d avail=%.10f; want %+v",
				w.kind, w.target, s.Slots, s.Good, s.Bad, s.Unknown, s.Availability(), w)
		}
	}
	h := find(t, rep, store.KindRound, "ingest")
	if !near(h.Availability(), 0.9997888723) && math.Abs(h.Availability()-0.99978887) > 1e-8 {
		t.Errorf("headline %.10f", h.Availability())
	}
	if math.Abs(h.BudgetMinutes()-4.032) > 1e-9 || h.BadMinutes() != 8.5 || math.Abs(h.BudgetUsed()-17/8.052) > 1e-9 || h.Met() {
		t.Errorf("headline budget: %.4f min, bad %.1f, used %.4f, met %v", h.BudgetMinutes(), h.BadMinutes(), h.BudgetUsed(), h.Met())
	}
	d := find(t, rep, store.KindJourney, "dashboard")
	if math.Abs(d.BudgetMinutes()-40.32) > 1e-9 || d.BadMinutes() != 10 || math.Abs(d.BudgetUsed()-2/8.064) > 1e-9 || !d.Met() {
		t.Errorf("dashboard budget: %.4f min, bad %.1f, used %.4f, met %v", d.BudgetMinutes(), d.BadMinutes(), d.BudgetUsed(), d.Met())
	}

	out := t.TempDir()
	if err := rep.Write(out); err != nil {
		t.Fatal(err)
	}
	md, err := os.ReadFile(filepath.Join(out, "2026-02.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"| Ingest availability (probe rounds, headline) | 99.99 % | 99.9789 % | 80503 | 17 | 120 | 80640 | 8.5 min | 4.03 min | 211.1 % | **no** |",
		"| Dashboard availability (signed-in journeys, 5-minute windows) | 99.9 % | 99.9752 % | 8062 | 2 | 0 | 8064 | 10.0 min | 40.32 min | 24.8 % | yes |",
		"2026-02-03T00:50:00Z – 2026-02-03T00:55:00Z: 10 bad rounds",
		"Not included (no Prometheus URL given)"} {
		if !strings.Contains(string(md), s) {
			t.Errorf("report lacks %q\n%s", s, md)
		}
	}
	for _, f := range []string{"2026-02/verdicts.csv", "2026-02/raw/mon-c.csv", "2026-02/raw/edge-b1.csv", "2026-02/SHA256SUMS"} {
		if _, err := os.Stat(filepath.Join(out, f)); err != nil {
			t.Error(err)
		}
	}
}
