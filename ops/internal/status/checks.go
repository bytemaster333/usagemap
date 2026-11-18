// SPDX-License-Identifier: Apache-2.0

package status

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/quorum"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

// PageDays is the history the page shows per check (status.json's components keep Days).
const PageDays = 30

// Day states of a check's bar.
const (
	DayOK     = "ok"     // judged, nothing failed
	DayWarn   = "warn"   // some checks failed, availability ≥ DayDownBelow
	DayDown   = "down"   // availability below DayDownBelow
	DayNone   = "none"   // after measuring began, but nothing was judged that day
	DayBefore = "before" // before the first probe result in the store
)

// DayDownBelow: a day with less than this availability is drawn as down, else as "some checks failed".
const DayDownBelow = 0.95

// Check is one row of the page: one thing the probe really does, in user words.
type Check struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	State       string     `json:"state"`  // operational, degraded, outage, unknown (last 10 minutes; 15 for windowed checks)
	Uptime      float64    `json:"uptime"` // good ÷ judged over the page's days; -1 = nothing judged
	SlotSeconds int        `json:"slot_seconds"`
	Since       *time.Time `json:"since,omitempty"` // this check's first result (later than the store's when it was added later)
	Days        []CheckDay `json:"days"`
}

// CheckDay is one bar.
type CheckDay struct {
	Day          string  `json:"day"`
	State        string  `json:"state"`
	Availability float64 `json:"availability"` // -1 when nothing was judged
	Judged       int     `json:"judged"`
	Failed       int     `json:"failed"`
}

// Incident is a run of consecutive failed slots of one check, derived from probe data (there is no hand-written
// incident source).
type Incident struct {
	Check  string    `json:"check"`
	Start  time.Time `json:"start"`
	End    time.Time `json:"end"`
	Failed int       `json:"failed"`
	Slot   int       `json:"slot_seconds"`
}

// Minutes is the incident's length.
func (i Incident) Minutes() int { return int(i.End.Sub(i.Start).Round(time.Minute) / time.Minute) }

type checkSpec struct {
	id, name, desc string
	kind, target   string // target "" = every target of the kind, judged together
	slot           time.Duration
	always         bool // shown even before it has any data (core checks)
}

var checkSpecs = []checkSpec{
	{"web", "Web tracking", "A real page-view event is sent and accepted, like a visitor's browser would.", store.KindRound, "ingest", quorum.Round, true},
	{"tracker", "Tracker script", "The script your site loads matches its published integrity hash.", store.KindTracker, "", quorum.Window, false},
	{"api", "API telemetry", "An OpenTelemetry metric export is sent and accepted, like your backend would.", store.KindOTLP, "", quorum.Round, false},
	{"dashboard", "Dashboard & API", "A signed-in visit loads the dashboard and finds fresh data.", store.KindJourney, "dashboard", quorum.Window, true},
}

// buildChecks judges the page's checks from raw rows (which must cover at least the page's days).
func buildChecks(rows []store.Row, now time.Time, minVoters int, since time.Time) ([]Check, []Incident) {
	today := now.Truncate(24 * time.Hour)
	from := today.AddDate(0, 0, -(PageDays - 1))
	var checks []Check
	var incidents []Incident
	for _, sp := range checkSpecs {
		var sel []store.Row
		for _, r := range rows {
			if r.Kind != sp.kind || (sp.target != "" && r.Target != sp.target) || r.RoundStart.Before(from) {
				continue
			}
			if sp.target == "" { // judge every target of the kind together: a slot fails when the targets mostly fail
				r.Target = "all"
			}
			sel = append(sel, r)
		}
		if len(sel) == 0 && !sp.always {
			continue
		}
		k := quorum.Key{Kind: sp.kind, Target: sp.target}
		if sp.target == "" {
			k.Target = "all"
		}
		var vs []quorum.Verdict
		if sp.slot == quorum.Window {
			vs = quorum.WindowsMin(sel, k, minVoters)
		} else {
			vs = quorum.RoundsMin(sel, k, minVoters)
		}
		c := Check{ID: sp.id, Name: sp.name, Description: sp.desc, State: state(vs, now, sp.slot), SlotSeconds: int(sp.slot / time.Second)}
		// A check added after measuring began (e.g. the tracker check) is "not measured" before its own first result.
		first := since
		if len(sel) > 0 {
			var f time.Time
			for _, r := range sel {
				if r.Outcome != store.Abstain && (f.IsZero() || r.RoundStart.Before(f)) {
					f = r.RoundStart.UTC()
				}
			}
			if !f.IsZero() && (first.IsZero() || f.After(first)) && f.After(from) {
				first = f
			}
		}
		if !first.IsZero() {
			c.Since = &first
		}
		for d := from; !d.After(today); d = d.AddDate(0, 0, 1) {
			end := d.Add(24 * time.Hour)
			if end.After(now) {
				end = now.Truncate(sp.slot)
			}
			s := quorum.Summarise(vs, d, end, sp.slot)
			cd := CheckDay{Day: d.Format("2006-01-02"), Availability: -1, Judged: s.Good + s.Bad, Failed: s.Bad}
			switch {
			case first.IsZero() || !d.Add(24*time.Hour).After(first):
				cd.State = DayBefore
			case cd.Judged == 0:
				cd.State = DayNone
			default:
				cd.Availability = s.Availability()
				switch {
				case s.Bad == 0:
					cd.State = DayOK
				case cd.Availability >= DayDownBelow:
					cd.State = DayWarn
				default:
					cd.State = DayDown
				}
			}
			c.Days = append(c.Days, cd)
		}
		total := quorum.Summarise(vs, from, now.Truncate(sp.slot), sp.slot)
		c.Uptime = -1
		if total.Good+total.Bad > 0 {
			c.Uptime = total.Availability()
		}
		checks = append(checks, c)
		incidents = append(incidents, runs(sp.name, vs, sp.slot)...)
	}
	sort.Slice(incidents, func(i, j int) bool { return incidents[i].Start.After(incidents[j].Start) })
	return checks, incidents
}

// runs merges failed slots into incidents. A good slot ends a run; one unjudged slot between two failed ones does not
// split them (a missed probe round inside an outage is not a recovery). vs must be sorted by start.
func runs(name string, vs []quorum.Verdict, slot time.Duration) []Incident {
	var out []Incident
	open := false
	for _, v := range vs {
		switch v.Result {
		case quorum.Good:
			open = false
		case quorum.Bad:
			if n := len(out); open && v.Start.Sub(out[n-1].End) <= slot {
				out[n-1].End = v.Start.Add(slot)
				out[n-1].Failed++
				continue
			}
			out = append(out, Incident{Check: name, Start: v.Start, End: v.Start.Add(slot), Failed: 1, Slot: int(slot / time.Second)})
			open = true
		}
	}
	return out
}

// overall is the banner state: an outage of a core check (web tracking, dashboard) is an outage; any failing check is
// degraded; nothing judged recently is unknown.
func overall(checks []Check) string {
	out, judged := "operational", false
	for _, c := range checks {
		core := c.ID == "web" || c.ID == "dashboard"
		switch c.State {
		case "unknown":
			continue
		case "outage":
			if core {
				return "outage"
			}
			out = "degraded"
		case "degraded":
			out = "degraded"
		}
		judged = true
	}
	if !judged {
		return "unknown"
	}
	return out
}

var dayFile = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}\.csv$`)

// measuredSince is the round start of the earliest voting row in the store (zero when the store is empty).
func measuredSince(dir string) (time.Time, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return time.Time{}, nil
		}
		return time.Time{}, err
	}
	first := ""
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		days, err := os.ReadDir(filepath.Join(dir, e.Name()))
		if err != nil {
			return time.Time{}, err
		}
		for _, d := range days {
			if dayFile.MatchString(d.Name()) && (first == "" || d.Name() < first) {
				first = d.Name()
			}
		}
	}
	if first == "" {
		return time.Time{}, nil
	}
	day, err := time.Parse("2006-01-02", first[:10])
	if err != nil {
		return time.Time{}, err
	}
	rows, err := store.ReadRange(dir, day, day.Add(24*time.Hour))
	if err != nil {
		return time.Time{}, err
	}
	var min time.Time
	for _, r := range rows {
		if r.Outcome != store.Abstain && (min.IsZero() || r.RoundStart.Before(min)) {
			min = r.RoundStart
		}
	}
	return min.UTC(), nil
}

// lastChecked is the newest voting round start in rows.
func lastChecked(rows []store.Row) time.Time {
	var max time.Time
	for _, r := range rows {
		if r.Outcome != store.Abstain && r.RoundStart.After(max) {
			max = r.RoundStart
		}
	}
	return max.UTC()
}
