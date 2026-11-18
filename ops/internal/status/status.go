// SPDX-License-Identifier: Apache-2.0

// Package status generates the public status page from the raw probe store: a static HTML page with one small
// same-origin script (no external assets, no fonts or CDNs of anyone else, no third-party service, no cookies) and a
// machine-readable status.json, both rewritten every minute. The page shows the current state (last 10 minutes, by the
// quorum rule of C-78 with the deployment's number of voting sources), when measuring began, the month to date (shown
// only above 95 % coverage, C-146), one row per check the probe really runs with 30 days of daily bars, and the failed
// periods derived from the probe data. status.json keeps the per-component view with 90 days.
// It also receives the Alertmanager Watchdog heartbeat (dead-man's switch, monitoring plan §4.9) and publishes its
// age as heartbeat.json for the scheduled GitHub workflow.
//
// In production the generator and its web server run outside the monitored failure domain (README "Placement").
package status

import (
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"html/template"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/quorum"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

// Component is one row of the page.
type Component struct {
	Name       string     `json:"name"`
	Kind       string     `json:"kind"`
	Target     string     `json:"target"`
	State      string     `json:"state"`         // operational, degraded, outage, unknown
	MonthToDay float64    `json:"month_to_date"` // -1 when not measured (coverage < MinCoverage, C-146)
	Coverage   float64    `json:"month_to_date_coverage"`
	Days       []DayPoint `json:"days"`
}

// DayPoint is one day's availability (-1 = no judged rounds).
type DayPoint struct {
	Day          string  `json:"day"`
	Availability float64 `json:"availability"`
	Bad          int     `json:"bad"`
}

// Page is the generated content.
type Page struct {
	Generated     time.Time   `json:"generated"`
	Overall       string      `json:"overall"` // per-component view (kept for existing consumers)
	Components    []Component `json:"components"`
	Sources       []string    `json:"sources"` // probe sources that voted in the last 24 h
	Banner        string      `json:"banner"`  // operational, degraded, outage, unknown: the page's headline, from Checks
	LastChecked   *time.Time  `json:"last_checked,omitempty"`
	MeasuredSince *time.Time  `json:"measured_since,omitempty"`
	Month         Month       `json:"month"`
	Checks        []Check     `json:"checks"`
	Incidents     []Incident  `json:"incidents"` // failed periods in the page's days, newest first
	Heartbeat     *time.Time  `json:"-"`
	Opt           Options     `json:"-"`
}

// Month is the month-to-date headline: the lower of web tracking and the dashboard, shown only when both are covered
// above MinCoverage.
type Month struct {
	Availability float64 `json:"availability"` // -1 = not measured yet
	Coverage     float64 `json:"coverage"`     // the lower coverage of the two
}

// Options describe the deployment honestly: how many sources must vote, the objectives that apply, where the page is
// served. The defaults are the multi-node design's (three sources, 2-of-3, 99.99 % / 99.9 %, page off the platform).
type Options struct {
	MinVoters   int     // 2 = 2-of-3 quorum (C-78); 1 = a single probe source judges alone (v1 host)
	MinCoverage float64 // a month-to-date figure is shown only above this coverage (C-146: 0.95)
	Objective   string  // the headline objective as shown, e.g. "99.5%"
	ObjectiveOf string  // what it applies to, one short sentence after the figure
	// ServiceWindow is an optional sentence shown right after ObjectiveOf, for a host whose own objective differs from
	// the service-window commitment (the pre-funding v1 host: 99.5 % here, 99.99 % / 99.90 % in the window, C-180).
	ServiceWindow string
	Objectives    string // sentence naming the objectives (never a guarantee)
	Placement     string // sentence on where the page runs relative to what it monitors
	Reports       string // sentence on the SLO reports
}

// DefaultOptions are the multi-node design's.
func DefaultOptions() Options {
	return Options{
		MinVoters:   2,
		MinCoverage: 0.95,
		Objective:   "99.9%",
		ObjectiveOf: "per month for the dashboard, 99.99% for tracking. A target, not a guarantee.",
		Objectives:  "99.99 % (ingest) and 99.9 % (dashboard) are objectives, not guarantees.",
		Placement:   "This page is generated from our own probe data and served outside the infrastructure it monitors; it uses no third-party service and sets no cookies.",
		Reports:     "Monthly SLO reports, with every raw probe result, are published from the first full month of service.",
	}
}

// Days of history on the page.
const Days = 90

// Build computes the page at now.
func Build(dir string, now time.Time) (*Page, error) { return BuildWith(dir, now, DefaultOptions()) }

// BuildWith computes the page with the deployment's options.
func BuildWith(dir string, now time.Time, opt Options) (*Page, error) {
	if opt.MinVoters < 1 {
		opt.MinVoters = 2
	}
	now = now.UTC()
	today := now.Truncate(24 * time.Hour)
	from := today.AddDate(0, 0, -(Days - 1))
	rows, err := store.ReadRange(dir, from, now.Add(time.Minute))
	if err != nil {
		return nil, err
	}
	p := &Page{Generated: now, Opt: opt}
	seen := map[string]bool{}
	for _, r := range rows {
		if r.RoundStart.After(now.Add(-24*time.Hour)) && r.Outcome != store.Abstain && !seen[quorum.Group(r.Source)] {
			seen[quorum.Group(r.Source)] = true
			p.Sources = append(p.Sources, quorum.Group(r.Source))
		}
	}
	sort.Strings(p.Sources)
	add := func(name, kind, target string, slot time.Duration) {
		k := quorum.Key{Kind: kind, Target: target}
		var vs []quorum.Verdict
		if slot == quorum.Window {
			vs = quorum.WindowsMin(rows, k, opt.MinVoters)
		} else {
			vs = quorum.RoundsMin(rows, k, opt.MinVoters)
		}
		c := Component{Name: name, Kind: kind, Target: target, State: state(vs, now, slot)}
		for d := from; !d.After(today); d = d.AddDate(0, 0, 1) {
			end := d.Add(24 * time.Hour)
			if end.After(now) {
				end = now.Truncate(slot)
			}
			s := quorum.Summarise(vs, d, end, slot)
			a := -1.0
			if s.Good+s.Bad > 0 {
				a = s.Availability()
			}
			c.Days = append(c.Days, DayPoint{Day: d.Format("2006-01-02"), Availability: a, Bad: s.Bad})
		}
		month := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
		ms := quorum.Summarise(vs, month, now.Truncate(slot), slot)
		c.MonthToDay = -1
		if ms.Slots > 0 {
			c.Coverage = float64(ms.Good+ms.Bad) / float64(ms.Slots)
			if c.Coverage >= opt.MinCoverage && ms.Good+ms.Bad > 0 {
				c.MonthToDay = ms.Availability()
			}
		}
		p.Components = append(p.Components, c)
	}
	// Per-target components only for targets probed in the last 24 h: a check that was switched off (e.g. the
	// per-node probe on a single-node host) leaves the page instead of showing "No data" for 90 days.
	var recentRows []store.Row
	for _, r := range rows {
		if r.RoundStart.After(now.Add(-24 * time.Hour)) {
			recentRows = append(recentRows, r)
		}
	}
	add("Ingest (headline, either hostname)", store.KindRound, "ingest", quorum.Round)
	for _, t := range quorum.Targets(recentRows, store.KindHost) {
		add("Ingest hostname "+strings.TrimPrefix(t, "host-"), store.KindHost, t, quorum.Round)
	}
	for _, t := range quorum.Targets(recentRows, store.KindNode) {
		add("Edge node "+t, store.KindNode, t, quorum.Round)
	}
	for _, t := range quorum.Targets(recentRows, store.KindTracker) {
		// checked every 5 minutes: judged and covered per 5-minute window, not per 30-second round
		add("Tracker files = published SRI, hostname "+strings.TrimPrefix(t, "host-"), store.KindTracker, t, quorum.Window)
	}
	for _, t := range quorum.Targets(recentRows, store.KindOTLP) {
		add("API telemetry (OTLP metric export accepted)", store.KindOTLP, t, quorum.Round)
	}
	add("Dashboard and API (signed-in journey, data fresh)", store.KindJourney, "dashboard", quorum.Window)
	since, err := measuredSince(dir)
	if err != nil {
		return nil, err
	}
	if !since.IsZero() {
		p.MeasuredSince = &since
	}
	if last := lastChecked(rows); !last.IsZero() {
		p.LastChecked = &last
	}
	p.Checks, p.Incidents = buildChecks(rows, now, opt.MinVoters, since)
	if p.Incidents == nil {
		p.Incidents = []Incident{}
	}
	p.Banner = overall(p.Checks)
	p.Month = Month{Availability: -1, Coverage: 1}
	n := 0
	for _, c := range p.Components {
		if (c.Kind == store.KindRound && c.Target == "ingest") || c.Kind == store.KindJourney {
			n++
			p.Month.Coverage = min(p.Month.Coverage, c.Coverage)
			if c.MonthToDay < 0 {
				p.Month.Availability = -2 // one of the two is not measured: the headline is not measured
			} else if p.Month.Availability != -2 && (p.Month.Availability < 0 || c.MonthToDay < p.Month.Availability) {
				p.Month.Availability = c.MonthToDay
			}
		}
	}
	if n < 2 || p.Month.Availability < 0 {
		p.Month.Availability = -1
	}
	if n == 0 {
		p.Month.Coverage = 0
	}
	p.Overall = "operational"
	for _, c := range p.Components {
		switch {
		case c.Kind == store.KindRound || c.Kind == store.KindJourney:
			if c.State == "outage" {
				p.Overall = "outage"
			} else if c.State != "operational" && p.Overall == "operational" {
				p.Overall = c.State
			}
		case c.State == "outage" || c.State == "degraded":
			if p.Overall == "operational" {
				p.Overall = "degraded"
			}
		}
	}
	return p, nil
}

// state judges the last 10 minutes: outage when the last two judged slots were bad, degraded when any was bad,
// unknown when nothing was judged.
func state(vs []quorum.Verdict, now time.Time, slot time.Duration) string {
	since := now.Add(-10 * time.Minute)
	if slot == quorum.Window {
		since = now.Add(-15 * time.Minute)
	}
	var recent []quorum.Verdict
	for _, v := range vs {
		if !v.Start.Before(since) && v.Result != quorum.Unknown {
			recent = append(recent, v)
		}
	}
	if len(recent) == 0 {
		return "unknown"
	}
	n := len(recent)
	if recent[n-1].Result == quorum.Bad && (n == 1 || recent[n-2].Result == quorum.Bad) {
		return "outage"
	}
	for _, v := range recent {
		if v.Result == quorum.Bad {
			return "degraded"
		}
	}
	return "operational"
}

//go:embed assets/page.html.tmpl
var pageTmpl string

//go:embed assets/logo.svg
var logoSVG string

//go:embed assets/status.js
var statusJS []byte

//go:embed assets/favicon.svg
var faviconSVG []byte

var page = template.Must(template.New("p").Parse(pageTmpl))

// HTML renders the page.
func (p *Page) HTML() (string, error) {
	var html strings.Builder
	if err := page.Execute(&html, p.view()); err != nil {
		return "", err
	}
	return html.String(), nil
}

// Render writes index.html, status.json, status.js and favicon.svg into out (atomically).
func (p *Page) Render(out string) error {
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}
	html, err := p.HTML()
	if err != nil {
		return err
	}
	js, _ := json.MarshalIndent(p, "", "  ")
	for _, f := range []struct {
		name string
		b    []byte
	}{{"status.js", statusJS}, {"favicon.svg", faviconSVG}, {"status.json", js}, {"index.html", []byte(html)}} {
		if err := atomicWrite(filepath.Join(out, f.name), f.b); err != nil {
			return err
		}
	}
	return nil
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Heartbeat receives Alertmanager's Watchdog notifications (webhook) and publishes the last one.
type Heartbeat struct {
	Token string
	Out   string // directory where heartbeat.json is written
	mu    sync.Mutex
	last  time.Time
}

// ServeHTTP accepts POST with "Authorization: Bearer <token>" and an Alertmanager webhook body whose alerts include
// alertname=Watchdog.
func (h *Heartbeat) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if h.Token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(h.Token)) != 1 {
		http.Error(w, "unauthorised", http.StatusUnauthorized)
		return
	}
	var body struct {
		Alerts []struct {
			Status string            `json:"status"`
			Labels map[string]string `json:"labels"`
		} `json:"alerts"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	ok := false
	for _, a := range body.Alerts {
		ok = ok || (a.Labels["alertname"] == "Watchdog" && a.Status == "firing")
	}
	if !ok {
		http.Error(w, "no Watchdog alert", http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	h.mu.Lock()
	h.last = now
	h.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"last_heartbeat": now.Format(time.RFC3339), "source": "alertmanager-watchdog"})
	if err := atomicWrite(filepath.Join(h.Out, "heartbeat.json"), b); err != nil {
		http.Error(w, "write", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Last returns the time of the last heartbeat.
func (h *Heartbeat) Last() time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.last
}
