// SPDX-License-Identifier: Apache-2.0

package quorum

import (
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/store"
)

var t0 = time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

func rows(outcomes map[string]string) []store.Row {
	var out []store.Row
	for src, o := range outcomes {
		out = append(out, store.Row{RoundStart: t0, Source: src, Kind: store.KindRound, Target: "ingest", Outcome: o})
	}
	return out
}

func TestRoundRules(t *testing.T) {
	for name, c := range map[string]struct {
		in   map[string]string
		want string
	}{
		"all good":                 {map[string]string{"mon-c": "good", "probe-d": "good", "edge-a1": "good"}, Good},
		"one bad":                  {map[string]string{"mon-c": "bad", "probe-d": "good", "edge-a1": "good"}, Good},
		"two bad":                  {map[string]string{"mon-c": "bad", "probe-d": "bad", "edge-a1": "good"}, Bad},
		"two voters one bad":       {map[string]string{"mon-c": "bad", "probe-d": "good"}, Good},
		"two voters both bad":      {map[string]string{"mon-c": "bad", "edge-b1": "bad"}, Bad},
		"one voter":                {map[string]string{"mon-c": "bad"}, Unknown},
		"abstain does not vote":    {map[string]string{"mon-c": "bad", "probe-d": "abstain"}, Unknown},
		"edges are one source":     {map[string]string{"edge-a1": "bad", "edge-b1": "bad", "edge-b2": "bad"}, Unknown},
		"edges majority bad":       {map[string]string{"edge-a1": "bad", "edge-b1": "bad", "edge-a2": "good", "mon-c": "bad"}, Bad},
		"edges tie counts as good": {map[string]string{"edge-a1": "bad", "edge-b1": "good", "mon-c": "bad"}, Good},
	} {
		v := Rounds(rows(c.in), Key{store.KindRound, "ingest"})
		if len(v) != 1 || v[0].Result != c.want {
			t.Errorf("%s: %+v, want %s", name, v, c.want)
		}
	}
}

func TestSummariseCountsMissingSlotsAsUnknown(t *testing.T) {
	v := Rounds(rows(map[string]string{"mon-c": "good", "probe-d": "good"}), Key{store.KindRound, "ingest"})
	s := Summarise(v, t0, t0.Add(time.Hour), Round)
	if s.Slots != 120 || s.Good != 1 || s.Bad != 0 || s.Unknown != 119 || s.Availability() != 1 {
		t.Fatalf("%+v", s)
	}
}

func TestWindowHalfFailedIsFailed(t *testing.T) {
	var in []store.Row
	add := func(src string, outs ...string) {
		for i, o := range outs {
			in = append(in, store.Row{RoundStart: t0.Add(time.Duration(i) * time.Minute), Source: src, Kind: store.KindJourney, Target: "dashboard", Outcome: o})
		}
	}
	add("mon-c", "bad", "bad", "good", "good")
	add("probe-d", "bad", "bad", "good", "good")
	add("edge-a1", "good", "good", "good", "good")
	v := Windows(in, Key{store.KindJourney, "dashboard"})
	if len(v) != 1 || v[0].Result != Bad || v[0].BadVotes != 2 {
		t.Fatalf("%+v", v)
	}
}
