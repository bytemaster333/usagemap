// SPDX-License-Identifier: Apache-2.0

package status

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/quorum"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

var update = flag.Bool("update", false, "rewrite testdata/page.golden.html")

// gen writes one source's rows: ingest rounds every 30 s, OTLP every 30 s, journeys and tracker checks every minute,
// from `from` to `to`; bad(kind, ts) marks failures, skip(ts) leaves a gap (probe not running).
func gen(t *testing.T, dir, src string, from, to time.Time, bad func(kind string, ts time.Time) bool, skip func(time.Time) bool) {
	t.Helper()
	w := &store.Writer{Dir: dir, Source: src}
	var rows []store.Row
	o := func(kind string, ts time.Time) string {
		if bad != nil && bad(kind, ts) {
			return store.Bad
		}
		return store.Good
	}
	for ts := from; ts.Before(to); ts = ts.Add(30 * time.Second) {
		if skip != nil && skip(ts) {
			continue
		}
		rows = append(rows,
			store.Row{RoundStart: ts, Source: src, Kind: store.KindRound, Target: "ingest", Outcome: o(store.KindRound, ts), Status: 202},
			store.Row{RoundStart: ts, Source: src, Kind: store.KindOTLP, Target: "otlp-http", Outcome: o(store.KindOTLP, ts), Status: 200})
		if ts.Second() == 0 {
			rows = append(rows,
				store.Row{RoundStart: ts, Source: src, Kind: store.KindJourney, Target: "dashboard", Outcome: o(store.KindJourney, ts), Status: 200},
				store.Row{RoundStart: ts, Source: src, Kind: store.KindTracker, Target: "host-1", Outcome: o(store.KindTracker, ts), Status: 200},
				store.Row{RoundStart: ts, Source: src, Kind: store.KindTracker, Target: "host-2", Outcome: o(store.KindTracker, ts), Status: 200})
		}
	}
	if err := w.Append(rows...); err != nil {
		t.Fatal(err)
	}
}

// v1ServiceWindow is the sentence the v1 host shows after its objective (infra/ansible compose_stack defaults,
// scf_status_service_window; docs/sla.md §1, C-180).
const v1ServiceWindow = "This pre-funding launch host targets 99.5 %; during the funded 12-month service window the service runs on the scale-out profile with a commitment of 99.99 % ingestion and 99.90 % dashboard availability (docs/sla.md §1, register C-180)."

func v1() Options {
	o := DefaultOptions()
	o.MinVoters, o.Objective, o.ObjectiveOf = 1, "99.5%", "per month for tracking and the dashboard. A target, not a guarantee."
	o.ServiceWindow = v1ServiceWindow
	return o
}

func check(t *testing.T, p *Page, id string) Check {
	t.Helper()
	for _, c := range p.Checks {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("check %s missing: %+v", id, p.Checks)
	return Check{}
}

// Days before the first probe result are "before" (drawn not measured), a day after it with no result is "none",
// measured days are judged; the four real checks appear, with the tracker hostnames and OTLP judged as one row each.
func TestDaysBeforeAndAfterMeasuringBegan(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 10, 0, time.UTC)
	start := time.Date(2026, 11, 16, 22, 12, 0, 0, time.UTC)
	dir := t.TempDir()
	gap := func(ts time.Time) bool { return ts.Day() == 17 } // probe off the whole of 17 Nov
	gen(t, dir, "vm-1", start, now, nil, gap)
	p, err := BuildWith(dir, now, v1())
	if err != nil {
		t.Fatal(err)
	}
	if p.MeasuredSince == nil || !p.MeasuredSince.Equal(start) {
		t.Fatalf("measured since %v, want %v", p.MeasuredSince, start)
	}
	if p.LastChecked == nil || !p.LastChecked.Equal(time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("last checked %v", p.LastChecked)
	}
	var ids []string
	for _, c := range p.Checks {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "web,tracker,api,dashboard" {
		t.Fatalf("checks %v", ids)
	}
	web := check(t, p, "web")
	if len(web.Days) != PageDays {
		t.Fatalf("%d days", len(web.Days))
	}
	want := map[string]string{"2026-11-15": DayBefore, "2026-11-16": DayOK, "2026-11-17": DayNone, "2026-11-18": DayOK, "2026-11-19": DayOK}
	for _, d := range web.Days {
		if w, ok := want[d.Day]; ok && d.State != w {
			t.Errorf("%s: %s, want %s", d.Day, d.State, w)
		}
		if d.Day < "2026-11-16" && d.State != DayBefore {
			t.Errorf("%s before measuring: %s", d.Day, d.State)
		}
	}
	if web.Uptime != 1 || web.State != "operational" || p.Banner != "operational" || len(p.Incidents) != 0 {
		t.Fatalf("web %+v banner %s incidents %v", web.State, p.Banner, p.Incidents)
	}
	// The 1-minute tracker cadence fills every 5-minute window: the day is fully judged.
	tr := check(t, p, "tracker")
	if d := tr.Days[len(tr.Days)-2]; d.Judged != 288 || d.State != DayOK {
		t.Fatalf("tracker 18 Nov: %+v", d)
	}
}

// A check without any row is left out unless it is a core check, which then reads "not measured" honestly.
func TestEmptyStoreIsNotMeasured(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	p, err := BuildWith(t.TempDir(), now, v1())
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Checks) != 2 || p.Banner != "unknown" || p.MeasuredSince != nil || p.LastChecked != nil || p.Month.Availability != -1 {
		t.Fatalf("%+v", p)
	}
	for _, c := range p.Checks {
		if c.Uptime != -1 || c.State != "unknown" || c.Days[len(c.Days)-1].State != DayBefore {
			t.Fatalf("%+v", c)
		}
	}
	html, err := p.HTML()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"No recent check results", "No check results yet", "not measured yet", "Not yet"} {
		if !strings.Contains(html, s) {
			t.Errorf("empty page lacks %q", s)
		}
	}
}

// The month figure appears only at ≥ 95 % coverage of both tracking and the dashboard, and is the lower of the two.
func TestMonthNeedsCoverage(t *testing.T) {
	now := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	month := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	// dashboard: 10 failed journeys on 2 Nov 10:00–10:09 → 2 bad of the 564 judged 5-minute windows (47 h)
	bad := func(kind string, ts time.Time) bool {
		return kind == store.KindJourney && ts.Day() == 2 && ts.Hour() == 10 && ts.Minute() < 10
	}
	gen(t, dir, "vm-1", month.Add(time.Hour), now, bad, nil) // the first hour missing: 1/48 uncovered
	p, err := BuildWith(dir, now, v1())
	if err != nil {
		t.Fatal(err)
	}
	if p.Month.Availability != 562.0/564 || p.Month.Coverage < 0.95 {
		t.Fatalf("month %+v", p.Month)
	}
	html, _ := p.HTML()
	if !strings.Contains(html, "99.64%") || strings.Contains(html, "Not measured yet") {
		t.Error("month figure missing or rounded up (562/564 = 99.645…%)")
	}
	// Less than 95 % covered → "not measured yet", even with a perfect record.
	dir2 := t.TempDir()
	gen(t, dir2, "vm-1", month.Add(36*time.Hour), now, nil, nil)
	p2, _ := BuildWith(dir2, now, v1())
	if p2.Month.Availability != -1 || p2.Month.Coverage > 0.26 {
		t.Fatalf("month %+v", p2.Month)
	}
	html2, _ := p2.HTML()
	if !strings.Contains(html2, "Not measured yet") || !strings.Contains(html2, "covered so far: 25%") {
		t.Errorf("under-covered month: %s", html2[strings.Index(html2, "This month"):strings.Index(html2, "This month")+300])
	}
}

// Failed periods come from the probe data: consecutive failed slots are one incident, one missing round inside does not
// split it, a good round does.
func TestIncidentsFromProbeData(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	from := now.Add(-6 * time.Hour)
	at := func(h, m, s int) time.Time { return time.Date(2026, 11, 19, h, m, s, 0, time.UTC) }
	in := func(ts, a, b time.Time) bool { return !ts.Before(a) && ts.Before(b) }
	bad := func(kind string, ts time.Time) bool {
		if kind != store.KindRound {
			return false
		}
		return in(ts, at(8, 0, 0), at(8, 5, 0)) || // 10 bad rounds…
			in(ts, at(9, 0, 0), at(9, 1, 0)) || in(ts, at(9, 1, 30), at(9, 2, 0)) // 2 bad, a good one, 1 bad
	}
	skip := func(ts time.Time) bool { return ts.Equal(at(8, 2, 0)) } // a missed round inside the first outage
	dir := t.TempDir()
	gen(t, dir, "vm-1", from, now, bad, skip)
	p, err := BuildWith(dir, now, v1())
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Incidents) != 3 {
		t.Fatalf("incidents %+v", p.Incidents)
	}
	first := p.Incidents[2] // newest first
	if first.Check != "Web tracking" || !first.Start.Equal(at(8, 0, 0)) || !first.End.Equal(at(8, 5, 0)) || first.Failed != 9 || first.Minutes() != 5 {
		t.Fatalf("first incident %+v", first)
	}
	if !p.Incidents[1].Start.Equal(at(9, 0, 0)) || p.Incidents[1].Failed != 2 || !p.Incidents[0].Start.Equal(at(9, 1, 30)) {
		t.Fatalf("split by a good round: %+v", p.Incidents)
	}
	web := check(t, p, "web")
	if d := web.Days[len(web.Days)-1]; d.State != DayWarn || d.Failed != 12 {
		t.Fatalf("today %+v", d)
	}
	html, _ := p.HTML()
	for _, s := range []string{"19 Nov 2026, 08:00–08:05 UTC", "5 min · 9 failed checks", "Some checks failed"} {
		if !strings.Contains(html, s) {
			t.Errorf("page lacks %q", s)
		}
	}
	if strings.Contains(html, "No incidents") {
		t.Error("empty state shown although checks failed")
	}
}

// Runs: unit-level edge cases.
func TestRuns(t *testing.T) {
	t0 := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	v := func(i int, r string) quorum.Verdict {
		return quorum.Verdict{Start: t0.Add(time.Duration(i) * quorum.Round), Result: r}
	}
	got := runs("x", []quorum.Verdict{v(0, quorum.Bad), v(1, quorum.Bad), v(3, quorum.Bad), v(6, quorum.Bad), v(7, quorum.Good), v(8, quorum.Bad)}, quorum.Round)
	// 0,1 then a one-slot gap → 3 joins; 6 is two slots after 3's end → new; 8 after a good → new
	if len(got) != 3 || got[0].Failed != 3 || !got[0].End.Equal(t0.Add(4*quorum.Round)) || got[1].Failed != 1 || got[2].Failed != 1 {
		t.Fatalf("%+v", got)
	}
}

// A down day: less than 95 % of the day judged good.
func TestDownDay(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	bad := func(kind string, ts time.Time) bool { return kind == store.KindJourney && ts.Hour() >= 9 } // 3 h of 12 → 75 %
	gen(t, dir, "vm-1", time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC), now, bad, nil)
	p, _ := BuildWith(dir, now, v1())
	d := check(t, p, "dashboard")
	if d.State != "outage" || p.Banner != "outage" || d.Days[len(d.Days)-1].State != DayDown {
		t.Fatalf("dashboard %s banner %s today %+v", d.State, p.Banner, d.Days[len(d.Days)-1])
	}
}

// The rendered page, byte for byte (go test -run TestGolden -update rewrites it).
func TestGolden(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 10, 0, time.UTC)
	dir := t.TempDir()
	bad := func(kind string, ts time.Time) bool {
		return kind == store.KindJourney && ts.Day() == 19 && ts.Hour() == 3 && ts.Minute() < 7
	}
	gen(t, dir, "vm-1", time.Date(2026, 11, 18, 22, 12, 0, 0, time.UTC), now, bad, nil)
	p, err := BuildWith(dir, now, v1())
	if err != nil {
		t.Fatal(err)
	}
	html, err := p.HTML()
	if err != nil {
		t.Fatal(err)
	}
	assertNoThirdParty(t, html)
	golden := filepath.Join("testdata", "page.golden.html")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, []byte(html), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != html {
		t.Fatal("rendered page differs from testdata/page.golden.html (run with -update after checking the change)")
	}
}

// A check added after measuring began is "not measured" until its own first result, not since the store's first row.
func TestCheckAddedLater(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	gen(t, dir, "vm-1", time.Date(2026, 11, 18, 22, 0, 0, 0, time.UTC), time.Date(2026, 11, 19, 1, 0, 0, 0, time.UTC), nil, nil)
	w := &store.Writer{Dir: dir, Source: "vm-1"}
	var rows []store.Row
	for ts := time.Date(2026, 11, 19, 1, 0, 0, 0, time.UTC); ts.Before(now); ts = ts.Add(time.Minute) {
		rows = append(rows, store.Row{RoundStart: ts, Source: "vm-1", Kind: store.KindRound, Target: "ingest", Outcome: store.Good, Status: 202})
	}
	if err := w.Append(rows...); err != nil {
		t.Fatal(err)
	}
	p, _ := BuildWith(dir, now, v1())
	web := check(t, p, "web")
	if web.Days[len(web.Days)-2].State != DayOK || web.Since == nil || web.Since.Day() != 18 {
		t.Fatalf("web: %+v since %v", web.Days[len(web.Days)-2], web.Since)
	}
	html, _ := p.HTML()
	if !strings.Contains(html, "Not measured before 18 Nov") {
		t.Error("axis note for the store's start missing")
	}
	// the tracker check (rows only 18 Nov 22:00–19 Nov 01:00 here) starts with the store, so it is measured on 18 Nov too
	if tr := check(t, p, "tracker"); tr.Days[len(tr.Days)-2].State != DayOK {
		t.Fatalf("tracker 18 Nov %+v", tr.Days[len(tr.Days)-2])
	}
}
