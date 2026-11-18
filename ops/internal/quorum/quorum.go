// SPDX-License-Identifier: Apache-2.0

// Package quorum turns raw probe rows into round verdicts by the one availability definition (C-78, ADR-0022,
// monitoring plan §4.1):
//
//   - three probe sources vote: `mon-c`, `probe-d`, and the edges' cross-provider probes. The edge probers (`edge-*`)
//     are one source together (C-30); that source records a round bad when more than half of its reporting edge
//     probers record it bad;
//   - a source whose self-check failed (`abstain`) or that sent nothing for the round does not vote;
//   - a round with fewer than two voting sources is "unknown": excluded from both counts and published;
//   - otherwise the round is bad when at least two sources record it bad (with two voters: both), else good.
//
// Dashboard journeys run every 60 s (C-93) and are judged per 5-minute window: a source records a window failed when
// at least half of its journeys in the window failed; the window is bad when at least two sources record it failed,
// unknown with fewer than two voting sources (the same 2-of-3 rule, ADR-0031 SLO-4).
package quorum

import (
	"sort"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/store"
)

// Results.
const (
	Good    = "good"
	Bad     = "bad"
	Unknown = "unknown"
)

// Round is ingest probes' cadence (C-78).
const Round = 30 * time.Second

// Window is the dashboard SLI window (ADR-0031 SLO-4).
const Window = 5 * time.Minute

// Group maps a probe source to its voting source.
func Group(source string) string {
	if strings.HasPrefix(source, "edge-") {
		return "edges"
	}
	return source
}

// Verdict of one round or window.
type Verdict struct {
	Start    time.Time
	Voters   int
	BadVotes int
	Result   string
}

// Key selects a series.
type Key struct{ Kind, Target string }

type tally struct{ good, bad int }

// Rounds judges every round of the given kind and target that has at least one row. Rounds without any row are not
// returned (the caller counts them as unknown against the calendar).
func Rounds(rows []store.Row, k Key) []Verdict { return RoundsMin(rows, k, 2) }

// RoundsMin is Rounds with another minimum number of voting sources: 2 = the 2-of-3 rule (C-78); 1 = a deployment
// with a single probe source (v1 host), where a round is judged by the majority of the sources that voted.
func RoundsMin(rows []store.Row, k Key, minVoters int) []Verdict {
	per := map[time.Time]map[string]*tally{}
	for _, r := range rows {
		if r.Kind != k.Kind || r.Target != k.Target || r.Outcome == store.Abstain {
			continue
		}
		t := r.RoundStart.Truncate(Round)
		if per[t] == nil {
			per[t] = map[string]*tally{}
		}
		g := Group(r.Source)
		if per[t][g] == nil {
			per[t][g] = &tally{}
		}
		if r.Outcome == store.Bad {
			per[t][g].bad++
		} else {
			per[t][g].good++
		}
	}
	return judge(per, func(t *tally) bool { return t.bad*2 > t.good+t.bad }, minVoters)
}

// Windows judges dashboard journeys per 5-minute window.
func Windows(rows []store.Row, k Key) []Verdict { return WindowsMin(rows, k, 2) }

// WindowsMin is Windows with another minimum number of voting sources (see RoundsMin).
func WindowsMin(rows []store.Row, k Key, minVoters int) []Verdict {
	per := map[time.Time]map[string]*tally{}
	for _, r := range rows {
		if r.Kind != k.Kind || r.Target != k.Target || r.Outcome == store.Abstain {
			continue
		}
		t := r.RoundStart.Truncate(Window)
		if per[t] == nil {
			per[t] = map[string]*tally{}
		}
		g := Group(r.Source)
		if per[t][g] == nil {
			per[t][g] = &tally{}
		}
		if r.Outcome == store.Bad {
			per[t][g].bad++
		} else {
			per[t][g].good++
		}
	}
	return judge(per, func(t *tally) bool { return t.bad*2 >= t.good+t.bad }, minVoters)
}

func judge(per map[time.Time]map[string]*tally, failed func(*tally) bool, minVoters int) []Verdict {
	if minVoters < 1 {
		minVoters = 1
	}
	out := make([]Verdict, 0, len(per))
	for t, groups := range per {
		v := Verdict{Start: t}
		for _, g := range groups {
			if g.good+g.bad == 0 {
				continue
			}
			v.Voters++
			if failed(g) {
				v.BadVotes++
			}
		}
		switch {
		case v.Voters < minVoters:
			v.Result = Unknown
		case minVoters >= 2 && v.BadVotes >= 2, minVoters < 2 && v.BadVotes*2 > v.Voters:
			v.Result = Bad
		default:
			v.Result = Good
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}

// Summary counts verdicts over a calendar period.
type Summary struct {
	Slots   int // rounds (or windows) in the period
	Good    int
	Bad     int
	Unknown int // includes slots without any row
}

// Availability is good ÷ (good + bad); 1 when nothing was judged.
func (s Summary) Availability() float64 {
	if s.Good+s.Bad == 0 {
		return 1
	}
	return float64(s.Good) / float64(s.Good+s.Bad)
}

// Summarise counts verdicts in [from, to) with the given slot length.
func Summarise(vs []Verdict, from, to time.Time, slot time.Duration) Summary {
	s := Summary{Slots: int(to.Sub(from) / slot)}
	for _, v := range vs {
		if v.Start.Before(from) || !v.Start.Before(to) {
			continue
		}
		switch v.Result {
		case Good:
			s.Good++
		case Bad:
			s.Bad++
		}
	}
	s.Unknown = s.Slots - s.Good - s.Bad
	return s
}

// Targets lists the targets present for a kind, sorted.
func Targets(rows []store.Row, kind string) []string {
	seen := map[string]bool{}
	for _, r := range rows {
		if r.Kind == kind {
			seen[r.Target] = true
		}
	}
	out := make([]string, 0, len(seen))
	for t := range seen {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}
