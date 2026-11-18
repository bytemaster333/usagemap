// SPDX-License-Identifier: Apache-2.0

package status

import (
	"fmt"
	"html/template"
	"math"
	"strings"
	"time"
)

// The page's words for each state, written from the reader's side.
var banners = map[string]struct{ class, title, band string }{
	"operational": {"ok", "All checks passing",
		"Tracking is accepting events and the dashboard is serving fresh data. If your numbers look wrong but everything here is green, check your snippet in the app's Setup page."},
	"degraded": {"warn", "Some checks are failing",
		"At least one check failed in the last few minutes. Data may arrive late or be missing until it clears. The rows below show what is affected."},
	"outage": {"bad", "Service down",
		"Recent checks of tracking or the dashboard are failing. Events sent now may not be counted. The rows below show what is affected."},
	"unknown": {"none", "No recent check results",
		"The checks have not reported in the last 10 minutes, so this page can't say whether the service is working."},
}

var chips = map[string]struct{ class, text string }{
	"operational": {"ok", "Working"},
	"degraded":    {"warn", "Some checks failed"},
	"outage":      {"bad", "Down"},
	"unknown":     {"none", "Not measured"},
}

type pageView struct {
	Banner, BannerTitle, Band string
	LastUnix                  int64
	LastText                  string
	Objective, ObjectiveOf    string
	ServiceWindow             string
	SinceDate, SinceNote      string
	MonthFigure, MonthNote    string
	Checks                    []checkView
	Incidents                 []incidentView
	EmptyTitle, EmptyNote     string
	Logo                      template.HTML
	Generated                 string
	AxisStart                 string
	MoreIncidents             int
}

type checkView struct {
	ID, Name, Desc, ChipClass, ChipText string
	Uptime, UptimeNote                  string
	Days                                []dayView
	Aria, AxisMid                       string
}

type dayView struct{ Class, Date, State, Value string }

type incidentView struct{ Check, When, Length, Failed string }

// floorPct shows a ratio as a percentage that never rounds up (99.996 % is 99.99%, not 100%).
func floorPct(a float64) string {
	if a >= 1 {
		return "100%"
	}
	return fmt.Sprintf("%.2f%%", math.Floor(a*10000)/100)
}

func dayDate(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.Format("2 Jan 2006")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// MaxIncidents listed on the page; the rest are counted.
const MaxIncidents = 20

func (p *Page) view() pageView {
	b := banners[p.Banner]
	if b.class == "" {
		b = banners["unknown"]
	}
	v := pageView{Banner: b.class, BannerTitle: b.title, Band: b.band, Logo: template.HTML(logoSVG),
		Objective: p.Opt.Objective, ObjectiveOf: p.Opt.ObjectiveOf, ServiceWindow: p.Opt.ServiceWindow, Generated: p.Generated.Format("2006-01-02 15:04 UTC"),
		AxisStart: fmt.Sprintf("%d days ago", PageDays)}
	if p.LastChecked != nil {
		v.LastUnix = p.LastChecked.Unix()
		v.LastText = "Checked " + ago(p.Generated.Sub(*p.LastChecked))
	} else {
		v.LastText = "No check results yet"
	}
	today := p.Generated.Truncate(24 * time.Hour)
	pageFrom := today.AddDate(0, 0, -(PageDays - 1))
	if p.MeasuredSince != nil {
		s := *p.MeasuredSince
		v.SinceDate = s.Format("2 Jan 2006")
		v.SinceNote = s.Format("15:04") + " UTC, when the first check result was recorded."
	} else {
		v.SinceDate = "Not yet"
		v.SinceNote = "No check result has been recorded yet."
	}
	if p.Month.Availability >= 0 {
		v.MonthFigure = floorPct(p.Month.Availability)
		v.MonthNote = "The lower of tracking and the dashboard, " + p.Generated.Format("January") + " to date."
	} else {
		v.MonthNote = fmt.Sprintf("We show a figure once %.0f%% of the month is covered; covered so far: %.0f%%.",
			p.Opt.MinCoverage*100, math.Floor(p.Month.Coverage*100))
		month := time.Date(p.Generated.Year(), p.Generated.Month(), 1, 0, 0, 0, 0, time.UTC)
		if p.MeasuredSince != nil && p.MeasuredSince.After(month) {
			v.MonthNote += " First full month: " + month.AddDate(0, 1, 0).Format("January") + "."
		}
	}
	for _, c := range p.Checks {
		ch := chips[c.State]
		cv := checkView{ID: c.ID, Name: c.Name, Desc: c.Description, ChipClass: ch.class, ChipText: ch.text}
		if c.Uptime >= 0 {
			cv.Uptime, cv.UptimeNote = floorPct(c.Uptime), "of measured time"
		} else {
			cv.Uptime, cv.UptimeNote = "—", "not measured yet"
		}
		counts := map[string]int{}
		for i, d := range c.Days {
			dv := dayView{Date: dayDate(d.Day)}
			unit := "failed checks"
			if c.SlotSeconds >= 300 {
				unit = "failed 5-minute periods"
			}
			switch d.State {
			case DayBefore:
				dv.Class, dv.State, dv.Value = "none", "Not measured", "Before measuring began"
			case DayNone:
				dv.Class, dv.State, dv.Value = "none", "Not measured", "No check results that day"
			case DayOK:
				dv.Class, dv.State, dv.Value = "", "Working", "100% · 0 "+unit
			case DayWarn:
				dv.Class, dv.State, dv.Value = "warn", "Some checks failed", floorPct(d.Availability)+" · "+fmt.Sprintf("%d %s", d.Failed, unit)
			case DayDown:
				dv.Class, dv.State, dv.Value = "bad", "Down", floorPct(d.Availability)+" · "+fmt.Sprintf("%d %s", d.Failed, unit)
			}
			if i == len(c.Days)-1 && d.State != DayBefore && d.State != DayNone {
				dv.Value += " so far today"
			}
			counts[dv.State]++
			cv.Days = append(cv.Days, dv)
		}
		var parts []string
		for _, k := range []string{"Working", "Some checks failed", "Down", "Not measured"} {
			if counts[k] > 0 {
				parts = append(parts, fmt.Sprintf("%s %s", plural(counts[k], "day", "days"), strings.ToLower(k)))
			}
		}
		cv.Aria = fmt.Sprintf("%s: last %d days, %s", c.Name, PageDays, strings.Join(parts, ", "))
		if c.Since != nil && c.Since.After(pageFrom) {
			cv.AxisMid = "Not measured before " + c.Since.Format("2 Jan")
		}
		v.Checks = append(v.Checks, cv)
	}
	for i, in := range p.Incidents {
		if i == MaxIncidents {
			v.MoreIncidents = len(p.Incidents) - MaxIncidents
			break
		}
		clock := "15:04"
		if in.Start.Second() != 0 || in.End.Second() != 0 {
			clock = "15:04:05"
		}
		when := in.Start.Format("2 Jan 2006, "+clock) + "–" + in.End.Format(clock) + " UTC"
		if in.End.Truncate(24*time.Hour) != in.Start.Truncate(24*time.Hour) {
			when = in.Start.Format("2 Jan "+clock) + " – " + in.End.Format("2 Jan 2006, "+clock) + " UTC"
		}
		failed := plural(in.Failed, "failed check", "failed checks")
		if in.Slot >= 300 {
			failed = plural(in.Failed, "failed 5-minute period", "failed 5-minute periods")
		}
		v.Incidents = append(v.Incidents, incidentView{Check: in.Check, When: when,
			Length: duration(in.End.Sub(in.Start)), Failed: failed})
	}
	if p.MeasuredSince != nil && !p.MeasuredSince.Before(pageFrom) {
		v.EmptyTitle = "No incidents since measuring began"
	} else {
		v.EmptyTitle = fmt.Sprintf("No incidents in the last %d days", PageDays)
	}
	v.EmptyNote = "When a check fails, the failed period appears here automatically from the probe results, and we publish a write-up within 5 business days of fixing it."
	return v
}

func ago(d time.Duration) string {
	switch {
	case d < 5*time.Second:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%d s ago", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d/time.Minute))
	default:
		return fmt.Sprintf("%d h ago", int(d/time.Hour))
	}
}

func duration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d s", int(d/time.Second))
	}
	m := int(d.Round(time.Minute) / time.Minute)
	if m < 60 {
		return fmt.Sprintf("%d min", m)
	}
	if m%60 == 0 {
		return fmt.Sprintf("%d h", m/60)
	}
	return fmt.Sprintf("%d h %d min", m/60, m%60)
}
