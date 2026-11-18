// SPDX-License-Identifier: Apache-2.0

package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAppendReadRoundTripAndTornLine(t *testing.T) {
	dir := t.TempDir()
	w := &Writer{Dir: dir, Source: "mon-c"}
	t0 := time.Date(2026, 3, 31, 23, 59, 30, 0, time.UTC)
	rows := []Row{
		{RoundStart: t0, Source: "mon-c", Kind: KindRound, Target: "ingest", Outcome: Good, Status: 202, LatencyMS: 310},
		{RoundStart: t0.Add(30 * time.Second), Source: "mon-c", Kind: KindNode, Target: "edge-a1", Outcome: Bad, Status: 0, LatencyMS: 2000},
	}
	if err := w.Append(rows...); err != nil {
		t.Fatal(err)
	}
	// two days → two files
	if _, err := os.Stat(filepath.Join(dir, "mon-c", "2026-04-01.csv")); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(filepath.Join(dir, "mon-c", "2026-03-31.csv"), os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString("2026-03-31T23:59:30Z,mon-c,rou") // crash mid-append
	f.Close()
	got, err := ReadRange(dir, t0.Add(-time.Hour), t0.Add(time.Hour))
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
}

func TestBadRowsRejected(t *testing.T) {
	w := &Writer{Dir: t.TempDir(), Source: "mon-c"}
	for _, r := range []Row{
		{Source: "probe-d", Kind: KindRound, Target: "ingest", Outcome: Good},
		{Source: "mon-c", Kind: "x", Target: "ingest", Outcome: Good},
		{Source: "mon-c", Kind: KindRound, Target: "203.0.113.9:443", Outcome: Good},
		{Source: "mon-c", Kind: KindRound, Target: "ingest", Outcome: "maybe"},
	} {
		if err := w.Append(r); err == nil {
			t.Errorf("accepted %+v", r)
		}
	}
	if _, err := Read(strings.NewReader("a,b\nx,y,z,1,2,3,4\n2026-01-01T00:00:00Z,mon-c,round,ingest,good,202,1\n")); err == nil {
		t.Fatal("bad middle row accepted")
	}
}
