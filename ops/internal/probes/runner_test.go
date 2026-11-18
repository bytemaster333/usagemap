// SPDX-License-Identifier: Apache-2.0

package probes

import (
	"context"
	"crypto/sha512"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/ops/internal/fakeedge"
	"github.com/bytemaster333/usagemap/ops/internal/metrics"
	"github.com/bytemaster333/usagemap/ops/internal/store"
)

func outcomes(rows []store.Row) map[string]string {
	m := map[string]string{}
	for _, r := range rows {
		m[r.Kind+"/"+r.Target] = r.Outcome
	}
	return m
}

func TestRoundRetriesOtherHostnameAndRecordsPerHostAndNode(t *testing.T) {
	a, b := &fakeedge.Edge{}, &fakeedge.Edge{}
	sa, sb := httptest.NewServer(a), httptest.NewServer(b)
	defer sa.Close()
	defer sb.Close()
	self := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	dir := t.TempDir()
	reg := metrics.New()
	Describe(reg)
	r := &Runner{
		Cfg: Config{Source: "probe-d", Hosts: map[string]string{"host-a": sa.URL, "host-b": sb.URL},
			Nodes: map[string]string{"edge-a1": sa.URL, "edge-b1": sb.URL}, SiteKey: "0123456789abcdefghijkl",
			Origin: "https://canary.test", TrackerVersion: "1.0.0", Deadline: 2 * time.Second, Interval: 30 * time.Second,
			SelfCheckURL: self.URL, IngestClient: &http.Client{Timeout: 2 * time.Second}},
		Store: &store.Writer{Dir: dir, Source: "probe-d"}, Metrics: reg,
	}
	start := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)

	a.RejectAll.Store(true) // host A and node edge-a1 refuse
	got := outcomes(r.Round(context.Background(), start))
	want := map[string]string{"round/ingest": "good", "host/host-a": "bad", "host/host-b": "good", "node/edge-a1": "bad", "node/edge-b1": "good"}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if reg.Get("scf_probe_last_bad", "source", "probe-d", "kind", "host", "target", "host-a") != 1 {
		t.Error("last_bad host-a")
	}
	if reg.Get("scf_probe_canary_accepted_total", "source", "probe-d", "path", "/canary/probe-d/round") != 1 ||
		reg.Get("scf_probe_canary_accepted_total", "source", "probe-d", "path", "/canary/probe-d/edge-b1") != 1 {
		t.Error("canary counters (wire-formats §o paths)")
	}

	b.RejectAll.Store(true)
	if got := outcomes(r.Round(context.Background(), start.Add(30*time.Second))); got["round/ingest"] != "bad" {
		t.Errorf("both hosts down: %v", got)
	}

	self.Close() // self-check fails → abstain, and the last voting result stays
	if got := outcomes(r.Round(context.Background(), start.Add(time.Minute))); got["round/ingest"] != "abstain" {
		t.Errorf("abstain: %v", got)
	}
	if reg.Get("scf_probe_self_check_ok", "source", "probe-d") != 0 ||
		reg.Get("scf_probe_last_timestamp_seconds", "source", "probe-d", "kind", "round", "target", "ingest") != float64(start.Add(30*time.Second).Unix()) {
		t.Error("abstaining source must not refresh its vote")
	}

	rows, err := store.ReadRange(dir, start, start.Add(time.Hour))
	if err != nil || len(rows) != 15 {
		t.Fatalf("stored %d rows: %v", len(rows), err)
	}
	var sb2 strings.Builder
	reg.Write(&sb2)
	if strings.Contains(sb2.String(), "127.0.0.1") {
		t.Fatal("an address leaked into metrics")
	}
}

func TestSlowAnswerIsBad(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		(&fakeedge.Edge{}).ServeHTTP(w, r)
	}))
	defer slow.Close()
	reg := metrics.New()
	r := &Runner{Cfg: Config{Source: "mon-c", Hosts: map[string]string{"host-a": slow.URL}, SiteKey: "k", Origin: "https://c.test",
		Deadline: 200 * time.Millisecond, Interval: time.Second, IngestClient: &http.Client{Timeout: time.Second}}, Metrics: reg}
	if got := outcomes(r.Round(context.Background(), time.Now().Truncate(time.Second))); got["round/ingest"] != "bad" || got["host/host-a"] != "bad" {
		t.Fatalf("%v", got)
	}
}

func TestTrackerFilesMustMatchThePublishedSRI(t *testing.T) {
	body := []byte("/* tracker 1.1.0 strict */")
	sum := sha512.Sum384(body)
	sri := "sha384-" + base64.StdEncoding.EncodeToString(sum[:])
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tracker/versions" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`[{"version":"1.0.0","files":[{"profile":"strict","integrity":"sha384-old"}]},` +
			`{"version":"1.1.0","files":[{"profile":"strict","integrity":"` + sri + `"}]}]`))
	}))
	defer api.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/lib/1.1.0/strict.js" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	defer good.Close()
	tampered := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(append(body, ' '))
	}))
	defer tampered.Close()
	reg := metrics.New()
	Describe(reg)
	r := &Runner{
		Cfg: Config{Source: "mon-c", Hosts: map[string]string{"host-a": good.URL, "host-b": tampered.URL},
			SiteKey: "0123456789abcdefghijkl", Origin: "https://canary.test", TrackerVersion: "1.1.0",
			Deadline: time.Second, Interval: 30 * time.Second, TrackerAPI: api.URL, TrackerEvery: 5 * time.Minute,
			IngestClient: &http.Client{Timeout: 2 * time.Second}},
		Store: &store.Writer{Dir: t.TempDir(), Source: "mon-c"}, Metrics: reg,
	}
	got := outcomes(r.Round(context.Background(), time.Date(2026, 11, 19, 10, 5, 0, 0, time.UTC)))
	// The round with the tracker rows must be stored (a kind the store refused once dropped the whole round).
	if reg.Get("scf_probe_store_errors_total", "source", "mon-c") != 0 {
		t.Fatal("the store refused the round with tracker rows")
	}
	if got["tracker/host-a"] != "good" || got["tracker/host-b"] != "bad" {
		t.Fatalf("tracker outcomes %v", got)
	}
	// Off the 5-minute beat the check does not run.
	if got := outcomes(r.Round(context.Background(), time.Date(2026, 11, 19, 10, 5, 30, 0, time.UTC))); got["tracker/host-a"] != "" {
		t.Fatalf("tracker check ran off its cadence: %v", got)
	}
	// A version the API does not publish is never "good".
	r.Cfg.TrackerVersion = "9.9.9"
	if got := outcomes(r.Round(context.Background(), time.Date(2026, 11, 19, 10, 10, 0, 0, time.UTC))); got["tracker/host-a"] != "bad" {
		t.Fatalf("unknown version: %v", got)
	}
	// The status page says "Checks run every minute": at a 1-minute cadence the check runs on every minute and still
	// skips the half-minute rounds of the 30-second ingest cadence.
	r.Cfg.TrackerVersion, r.Cfg.TrackerEvery = "1.1.0", time.Minute
	if got := outcomes(r.Round(context.Background(), time.Date(2026, 11, 19, 10, 11, 0, 0, time.UTC))); got["tracker/host-a"] != "good" {
		t.Fatalf("tracker check did not run on the minute: %v", got)
	}
	if got := outcomes(r.Round(context.Background(), time.Date(2026, 11, 19, 10, 11, 30, 0, time.UTC))); got["tracker/host-a"] != "" {
		t.Fatalf("tracker check ran on the half minute: %v", got)
	}
}
