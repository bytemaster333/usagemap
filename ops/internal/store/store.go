// SPDX-License-Identifier: Apache-2.0

// Package store is the raw probe-result store (monitoring plan §4.2 "probe hygiene", ADR-0031 reporting): one
// append-only CSV file per probe source and UTC day, `<dir>/<source>/<YYYY-MM-DD>.csv`, every row fsync'd. These files
// are what the monthly SLO report and the status page are computed from, and they are published with the report so
// anyone can recompute the figures. A row holds a round start, source, kind, target, outcome, HTTP status and latency —
// never an address, a header, a token or anything from a visitor.
package store

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"time"
)

// Kinds of probe rows.
const (
	KindRound   = "round"   // availability round: hostname A, then B on failure (the SLI)
	KindHost    = "host"    // first attempt per ingest hostname, no retry; target host-a / host-b
	KindNode    = "node"    // per edge node, bypassing DNS; target = node id
	KindOTLP    = "otlp"    // OTLP/HTTP export with a probe-only token
	KindJourney = "journey" // synthetic signed-in dashboard journey (every 60 s, C-93); target dashboard
	KindTracker = "tracker" // tracker files served by an ingest hostname = the SRI the API publishes; target host-a / host-b
)

// Outcomes.
const (
	Good    = "good"
	Bad     = "bad"
	Abstain = "abstain" // the source's own self-check failed: it does not vote (monitoring plan §4.1)
)

// Header is the CSV header.
var Header = []string{"round_start_utc", "source", "kind", "target", "outcome", "status", "latency_ms"}

var (
	namePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)
	targetPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,62}$`)
)

// Row is one probe result.
type Row struct {
	RoundStart time.Time // aligned round start (UTC)
	Source     string
	Kind       string
	Target     string
	Outcome    string
	Status     int
	LatencyMS  int64
}

// Validate checks a row before it is written or after it is read.
func (r Row) Validate() error {
	switch {
	case !namePattern.MatchString(r.Source):
		return errors.New("bad source")
	case !slices.Contains([]string{KindRound, KindHost, KindNode, KindOTLP, KindJourney, KindTracker}, r.Kind):
		return errors.New("bad kind")
	case !targetPattern.MatchString(r.Target):
		return errors.New("bad target")
	case r.Outcome != Good && r.Outcome != Bad && r.Outcome != Abstain:
		return errors.New("bad outcome")
	case r.Status < 0 || r.Status > 599 || r.LatencyMS < 0:
		return errors.New("bad status or latency")
	}
	return nil
}

func (r Row) record() []string {
	return []string{r.RoundStart.UTC().Format(time.RFC3339), r.Source, r.Kind, r.Target, r.Outcome,
		strconv.Itoa(r.Status), strconv.FormatInt(r.LatencyMS, 10)}
}

// Writer appends rows for one source.
type Writer struct {
	Dir    string
	Source string
	mu     sync.Mutex
}

// Append writes rows (all of the same source) and fsyncs.
func (w *Writer) Append(rows ...Row) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	byDay := map[string][]Row{}
	for _, r := range rows {
		if r.Source != w.Source {
			return errors.New("row of another source")
		}
		if err := r.Validate(); err != nil {
			return err
		}
		byDay[r.RoundStart.UTC().Format("2006-01-02")] = append(byDay[r.RoundStart.UTC().Format("2006-01-02")], r)
	}
	for day, rs := range byDay {
		if err := w.appendDay(day, rs); err != nil {
			return err
		}
	}
	return nil
}

func (w *Writer) appendDay(day string, rows []Row) error {
	dir := filepath.Join(w.Dir, w.Source)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	path := filepath.Join(dir, day+".csv")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	cw := csv.NewWriter(f)
	if st.Size() == 0 {
		_ = cw.Write(Header)
	}
	for _, r := range rows {
		_ = cw.Write(r.record())
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		return err
	}
	return f.Sync()
}

// ReadFile parses one CSV file. A torn last line (crash during append) is skipped; any other bad row is an error.
func ReadFile(path string) ([]Row, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return Read(f)
}

// Read parses CSV rows.
func Read(r io.Reader) ([]Row, error) {
	cr := csv.NewReader(bufio.NewReader(r))
	cr.FieldsPerRecord = -1
	var out []Row
	line := 0
	var pending error
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		line++
		if pending != nil {
			return nil, pending // a bad row that was not the last one
		}
		if err != nil {
			pending = fmt.Errorf("line %d: %w", line, err)
			continue
		}
		if line == 1 && slices.Equal(rec, Header) {
			continue
		}
		row, err := parse(rec)
		if err != nil {
			pending = fmt.Errorf("line %d: %w", line, err)
			continue
		}
		out = append(out, row)
	}
	return out, nil
}

func parse(rec []string) (Row, error) {
	if len(rec) != len(Header) {
		return Row{}, errors.New("wrong number of fields")
	}
	t, err := time.Parse(time.RFC3339, rec[0])
	if err != nil {
		return Row{}, err
	}
	st, err := strconv.Atoi(rec[5])
	if err != nil {
		return Row{}, err
	}
	lat, err := strconv.ParseInt(rec[6], 10, 64)
	if err != nil {
		return Row{}, err
	}
	r := Row{RoundStart: t.UTC(), Source: rec[1], Kind: rec[2], Target: rec[3], Outcome: rec[4], Status: st, LatencyMS: lat}
	return r, r.Validate()
}

// ReadRange reads every source's rows with from ≤ round start < to.
func ReadRange(dir string, from, to time.Time) ([]Row, error) {
	var out []Row
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || filepath.Ext(path) != ".csv" {
			return nil
		}
		day, err := time.Parse("2006-01-02", stringsTrimSuffix(filepath.Base(path), ".csv"))
		if err != nil || day.Add(24*time.Hour).Before(from) || !day.Before(to) {
			return nil
		}
		rows, err := ReadFile(path)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		for _, r := range rows {
			if !r.RoundStart.Before(from) && r.RoundStart.Before(to) {
				out = append(out, r)
			}
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return out, err
}

func stringsTrimSuffix(s, suf string) string {
	if len(s) >= len(suf) && s[len(s)-len(suf):] == suf {
		return s[:len(s)-len(suf)]
	}
	return s
}
