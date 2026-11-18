// SPDX-License-Identifier: Apache-2.0

// Package slo generates the monthly SLO report (ADR-0031 "Reporting", monitoring plan §8) from the raw probe store:
// the probe-round headline (C-78), per ingest hostname, per edge node, the OTLP probe and the dashboard journeys, each
// with numerator, denominator, unknown rounds and error budget, plus — when a Prometheus URL is given — the server-side
// ratio and the 72-hour discards for the same month. It writes `<out>/<YYYY-MM>.md`, `<out>/<YYYY-MM>/verdicts.csv`
// (every judged round and window), `<out>/<YYYY-MM>/raw/<source>.csv` (every raw row of the month) and
// `<out>/<YYYY-MM>/SHA256SUMS`, so anyone can recompute every figure. Signing happens in the workflow that opens the
// pull request (cosign sign-blob over SHA256SUMS; ADR-0031).
package slo

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/quorum"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

// Objectives (ADR-0031, C-78): objectives we measure against, not guarantees.
const (
	IngestObjective    = 0.9999
	DashboardObjective = 0.999
)

// Series is one published figure.
type Series struct {
	Name      string
	Kind      string
	Target    string
	Slot      time.Duration
	Objective float64 // 0 = no separate objective (published, alerted)
	quorum.Summary
}

// BadMinutes is the bad time in minutes.
func (s Series) BadMinutes() float64 { return float64(s.Bad) * s.Slot.Minutes() }

// BudgetMinutes is the month's error budget in minutes over the whole calendar month.
func (s Series) BudgetMinutes() float64 {
	return (1 - s.Objective) * float64(s.Slots) * s.Slot.Minutes()
}

// BudgetUsed is bad rounds ÷ allowed bad rounds over the judged rounds (fraction; >1 = objective missed).
func (s Series) BudgetUsed() float64 {
	allowed := (1 - s.Objective) * float64(s.Good+s.Bad)
	if allowed == 0 {
		return 0
	}
	return float64(s.Bad) / allowed
}

// Met reports whether the objective was met.
func (s Series) Met() bool { return s.Availability() >= s.Objective }

// ServerSide holds the figures read from Prometheus.
type ServerSide struct {
	Accepted, Valid, ClientRejected, Expired72hWeb, Expired72hOTLP float64
	Available                                                      bool
	Error                                                          string
}

// Report is the computed month.
type Report struct {
	Month     time.Time
	From, To  time.Time
	Series    []Series
	Verdicts  map[string][]quorum.Verdict // by series name
	Rows      []store.Row
	Sources   []string
	Server    ServerSide
	Generated time.Time
}

// MonthRange returns [first day, first day of next month) in UTC.
func MonthRange(month string) (time.Time, time.Time, error) {
	from, err := time.Parse("2006-01", month)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("month must be YYYY-MM: %w", err)
	}
	return from, from.AddDate(0, 1, 0), nil
}

// Compute builds the report from the raw store.
func Compute(dir, month string) (*Report, error) {
	from, to, err := MonthRange(month)
	if err != nil {
		return nil, err
	}
	rows, err := store.ReadRange(dir, from, to)
	if err != nil {
		return nil, err
	}
	rep := &Report{Month: from, From: from, To: to, Rows: rows, Verdicts: map[string][]quorum.Verdict{}, Generated: time.Now().UTC()}
	src := map[string]bool{}
	for _, r := range rows {
		src[r.Source] = true
	}
	for s := range src {
		rep.Sources = append(rep.Sources, s)
	}
	sort.Strings(rep.Sources)

	add := func(name, kind, target string, slot time.Duration, obj float64) {
		k := quorum.Key{Kind: kind, Target: target}
		var vs []quorum.Verdict
		if slot == quorum.Window {
			vs = quorum.Windows(rows, k)
		} else {
			vs = quorum.Rounds(rows, k)
		}
		rep.Verdicts[name] = vs
		rep.Series = append(rep.Series, Series{Name: name, Kind: kind, Target: target, Slot: slot, Objective: obj,
			Summary: quorum.Summarise(vs, from, to, slot)})
	}
	add("Ingest availability (probe rounds, headline)", store.KindRound, "ingest", quorum.Round, IngestObjective)
	for _, t := range quorum.Targets(rows, store.KindHost) {
		add("Ingest hostname "+t+" (first attempt, no retry)", store.KindHost, t, quorum.Round, 0)
	}
	for _, t := range quorum.Targets(rows, store.KindNode) {
		add("Edge node "+t+" (direct)", store.KindNode, t, quorum.Round, 0)
	}
	for _, t := range quorum.Targets(rows, store.KindOTLP) {
		add("OTLP probe "+t, store.KindOTLP, t, quorum.Round, 0)
	}
	add("Dashboard availability (signed-in journeys, 5-minute windows)", store.KindJourney, "dashboard", quorum.Window, DashboardObjective)
	return rep, nil
}

// promQuery runs an instant query and returns the scalar sum (0 for an empty result).
func promQuery(ctx context.Context, client *http.Client, base, q string, at time.Time) (float64, error) {
	u := strings.TrimRight(base, "/") + "/api/v1/query?" + url.Values{"query": {q}, "time": {strconv.FormatInt(at.Unix(), 10)}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Result []struct {
				Value []any `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return 0, err
	}
	if body.Status != "success" {
		return 0, fmt.Errorf("prometheus: %s", body.Error)
	}
	sum := 0.0
	for _, r := range body.Data.Result {
		if len(r.Value) == 2 {
			s, _ := r.Value[1].(string)
			v, err := strconv.ParseFloat(s, 64)
			if err == nil && !math.IsNaN(v) {
				sum += v
			}
		}
	}
	return sum, nil
}

// ServerQueries are the PromQL expressions of the server-side view (ADR-0031 SLO-1; gateway metric names as built).
// Valid excludes the client-caused answers of the published exclusion list: 400 malformed/too large, 404 unknown
// site, 410 withdrawn tracker version, 413, and 429 (every gateway 429 is a site's own rate limit or quota, C-80/C-90;
// global overload answers 503, which counts as bad).
func ServerQueries(window string) map[string]string {
	ingest := `route=~"events|challenge"`
	return map[string]string{
		"accepted":        fmt.Sprintf(`sum(increase(scf_gateway_requests_total{%s,status=~"2.."}[%s]))`, ingest, window),
		"all":             fmt.Sprintf(`sum(increase(scf_gateway_requests_total{%s}[%s]))`, ingest, window),
		"client_rejected": fmt.Sprintf(`sum(increase(scf_gateway_requests_total{%s,status=~"400|404|410|413|429"}[%s]))`, ingest, window),
		"expired_web":     fmt.Sprintf(`sum(increase(scf_gateway_forward_total{outcome="expired_72h"}[%s]))`, window),
		"expired_otlp":    fmt.Sprintf(`sum(increase(scf_ingest_dropped{reason="undeliverable_72h"}[%s]))`, window),
	}
}

// FetchServerSide reads the month's server-side figures from Prometheus.
func (rep *Report) FetchServerSide(ctx context.Context, base string, client *http.Client) {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	window := fmt.Sprintf("%ds", int64(rep.To.Sub(rep.From)/time.Second))
	vals := map[string]float64{}
	for k, q := range ServerQueries(window) {
		v, err := promQuery(ctx, client, base, q, rep.To)
		if err != nil {
			rep.Server = ServerSide{Error: err.Error()}
			return
		}
		vals[k] = v
	}
	rep.Server = ServerSide{Available: true, Accepted: vals["accepted"], ClientRejected: vals["client_rejected"],
		Valid: vals["all"] - vals["client_rejected"], Expired72hWeb: vals["expired_web"], Expired72hOTLP: vals["expired_otlp"]}
}

func pct(v float64) string { return strconv.FormatFloat(v*100, 'f', 4, 64) + " %" }

// Markdown renders the report.
func (rep *Report) Markdown() string {
	var b strings.Builder
	m := rep.Month.Format("2006-01")
	fmt.Fprintf(&b, "# SLO report %s\n\n", m)
	fmt.Fprintf(&b, "Period: %s to %s (UTC, calendar month). Generated %s by `scf-ops slo-report` from the raw probe store.\n",
		rep.From.Format("2006-01-02"), rep.To.Add(-time.Second).Format("2006-01-02"), rep.Generated.Format(time.RFC3339))
	b.WriteString("99.99 % (ingest) and 99.9 % (dashboard) are **objectives** we measure and report against, not guarantees (C-78).\n\n")
	b.WriteString("## Definitions\n\n")
	b.WriteString("- **Round** (C-78): every 30 s each probe source sends a canary event like the pinned tracker; a source records the round good when one of the two ingest hostnames answers `202` within 2 s, with one retry. Sources: `mon-c`, `probe-d` and the edges' cross-provider probes, which vote as one source (C-30).\n")
	b.WriteString("- A round is **bad** when at least two sources record it bad; **unknown** when fewer than two sources voted (excluded from both counts, published below). Availability = good ÷ (good + bad).\n")
	b.WriteString("- **Dashboard**: signed-in synthetic journeys every 60 s from the same sources (C-93), judged per 5-minute window by the same 2-of-3 rule (a source records a window failed when at least half of its journeys failed).\n")
	b.WriteString("- Per-hostname and per-node figures use the same rounds without the retry; they have no separate objective and are alerted on.\n\n")

	b.WriteString("## Results\n\n")
	b.WriteString("| Figure | Objective | Availability | Good | Bad | Unknown | Slots | Bad time | Budget (month) | Budget used | Met |\n")
	b.WriteString("|---|---|---|---|---|---|---|---|---|---|---|\n")
	for _, s := range rep.Series {
		obj, budget, used, met := "—", "—", "—", "—"
		if s.Objective > 0 {
			obj = strconv.FormatFloat(s.Objective*100, 'f', -1, 64) + " %"
			budget = fmt.Sprintf("%.2f min", s.BudgetMinutes())
			used = fmt.Sprintf("%.1f %%", s.BudgetUsed()*100)
			met = "yes"
			if !s.Met() {
				met = "**no**"
			}
		}
		fmt.Fprintf(&b, "| %s | %s | %s | %d | %d | %d | %d | %.1f min | %s | %s | %s |\n",
			s.Name, obj, pct(s.Availability()), s.Good, s.Bad, s.Unknown, s.Slots, s.BadMinutes(), budget, used, met)
	}
	b.WriteString("\n## Server-side view (published next to the headline, C-43)\n\n")
	if rep.Server.Available {
		ratio := 1.0
		if rep.Server.Valid > 0 {
			ratio = rep.Server.Accepted / rep.Server.Valid
		}
		fmt.Fprintf(&b, "accepted ÷ valid = %.0f ÷ %.0f = %s. Excluded as client-caused (400/404/410/413/429): %.0f requests.\n\n",
			rep.Server.Accepted, rep.Server.Valid, pct(ratio), rep.Server.ClientRejected)
		fmt.Fprintf(&b, "Records discarded at the 72-hour cap (C-18): web %.0f, OTLP points %.0f.\n\n", rep.Server.Expired72hWeb, rep.Server.Expired72hOTLP)
		b.WriteString("Limitation: the gateway's request counter has no \"answered within 2 s\" dimension yet, so *accepted* here is every 2xx; the probe view applies the 2-second limit.\n\n")
	} else {
		msg := "no Prometheus URL given"
		if rep.Server.Error != "" {
			msg = "query failed: " + rep.Server.Error
		}
		fmt.Fprintf(&b, "Not included (%s). The maintainer completes it before merging.\n\n", msg)
	}
	b.WriteString("## Incidents\n\n")
	bad := 0
	for _, s := range rep.Series[:1] {
		for _, run := range runs(rep.Verdicts[s.Name], quorum.Round) {
			fmt.Fprintf(&b, "- %s – %s: %d bad rounds (%.1f min)\n", run.from.Format(time.RFC3339), run.to.Format(time.RFC3339), run.n, float64(run.n)/2)
			bad++
		}
	}
	if bad == 0 {
		b.WriteString("No bad ingest rounds.\n")
	}
	b.WriteString("\nPost-mortems for every missed objective are linked here within 5 business days (ADR-0031).\n\n")
	b.WriteString("## Raw data\n\n")
	fmt.Fprintf(&b, "Sources this month: %s. Raw rows: %d. Files: `%s/raw/<source>.csv` (every probe result), `%s/verdicts.csv` (every judged round and window), `%s/SHA256SUMS`.\n",
		"`"+strings.Join(rep.Sources, "`, `")+"`", len(rep.Rows), m, m, m)
	b.WriteString("\nNot covered by this generator yet and filled in by the maintainer: freshness (SLO-3), durability reconciliation per node and canary counts (C-76), support statistics and patch latency.\n")
	return b.String()
}

type run struct {
	from, to time.Time
	n        int
}

func runs(vs []quorum.Verdict, slot time.Duration) []run {
	var out []run
	for _, v := range vs {
		if v.Result != quorum.Bad {
			continue
		}
		if len(out) > 0 && out[len(out)-1].to.Equal(v.Start) {
			out[len(out)-1].to = v.Start.Add(slot)
			out[len(out)-1].n++
			continue
		}
		out = append(out, run{v.Start, v.Start.Add(slot), 1})
	}
	return out
}

// Write writes the report and its data files into out.
func (rep *Report) Write(out string) error {
	m := rep.Month.Format("2006-01")
	data := filepath.Join(out, m)
	if err := os.MkdirAll(filepath.Join(data, "raw"), 0o755); err != nil {
		return err
	}
	var files []string
	// raw rows per source
	bySource := map[string][]store.Row{}
	for _, r := range rep.Rows {
		bySource[r.Source] = append(bySource[r.Source], r)
	}
	for _, s := range rep.Sources {
		rows := bySource[s]
		sort.Slice(rows, func(i, j int) bool {
			if !rows[i].RoundStart.Equal(rows[j].RoundStart) {
				return rows[i].RoundStart.Before(rows[j].RoundStart)
			}
			return rows[i].Kind+rows[i].Target < rows[j].Kind+rows[j].Target
		})
		p := filepath.Join(data, "raw", s+".csv")
		if err := writeCSV(p, store.Header, func(w *csv.Writer) {
			for _, r := range rows {
				_ = w.Write([]string{r.RoundStart.Format(time.RFC3339), r.Source, r.Kind, r.Target, r.Outcome,
					strconv.Itoa(r.Status), strconv.FormatInt(r.LatencyMS, 10)})
			}
		}); err != nil {
			return err
		}
		files = append(files, filepath.Join("raw", s+".csv"))
	}
	vp := filepath.Join(data, "verdicts.csv")
	if err := writeCSV(vp, []string{"series", "kind", "target", "start_utc", "voters", "bad_votes", "result"}, func(w *csv.Writer) {
		for _, s := range rep.Series {
			for _, v := range rep.Verdicts[s.Name] {
				if v.Start.Before(rep.From) || !v.Start.Before(rep.To) {
					continue
				}
				_ = w.Write([]string{s.Name, s.Kind, s.Target, v.Start.Format(time.RFC3339), strconv.Itoa(v.Voters),
					strconv.Itoa(v.BadVotes), v.Result})
			}
		}
	}); err != nil {
		return err
	}
	files = append(files, "verdicts.csv")
	md := filepath.Join(out, m+".md")
	if err := os.WriteFile(md, []byte(rep.Markdown()), 0o644); err != nil {
		return err
	}
	var sums strings.Builder
	for _, f := range append(files, "../"+m+".md") {
		b, err := os.ReadFile(filepath.Join(data, f))
		if err != nil {
			return err
		}
		h := sha256.Sum256(b)
		fmt.Fprintf(&sums, "%s  %s\n", hex.EncodeToString(h[:]), f)
	}
	return os.WriteFile(filepath.Join(data, "SHA256SUMS"), []byte(sums.String()), 0o644)
}

func writeCSV(path string, header []string, fill func(*csv.Writer)) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := csv.NewWriter(f)
	_ = w.Write(header)
	fill(w)
	w.Flush()
	if err := w.Error(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
