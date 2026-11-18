// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The processor's real SDK fixtures (recorded from real OTel SDKs in spikes
// s06a/s06b); they carry CANARY-* values that must never survive.
const sdkFixtures = "../../../collector/processor/scfsanitizeprocessor/testdata/sdk"

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSampleMetrics(t *testing.T) {
	rep, err := Check(mustRead(t, "testdata/sample.metrics.json"), Options{Services: "anchor-api"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.InputItems != 6 || rep.KeptItems != 3 || rep.DroppedItems() != 3 {
		t.Fatalf("input/kept/dropped = %d/%d/%d", rep.InputItems, rep.KeptItems, rep.DroppedItems())
	}
	reasons := map[string]int64{}
	for _, d := range rep.Dropped {
		reasons[d.Reason] += d.Count
	}
	for _, r := range []string{"client_metric_ignored", "metric_not_allowed", "service_not_allowed"} {
		if reasons[r] != 1 {
			t.Errorf("reason %s = %d, want 1 (all: %v)", r, reasons[r], reasons)
		}
	}
	routes := []string{}
	for _, s := range rep.Kept {
		routes = append(routes, s.Route)
	}
	for _, want := range []string{"/sep24/transactions/{id}", "/auth", "{unknown}"} {
		if !slices.Contains(routes, want) {
			t.Errorf("route %q not kept; got %v", want, routes)
		}
	}
	for _, k := range []string{"client.address", "user_agent.original", "url.full", "url.path", "host.name", "process.command_args"} {
		if !slices.Contains(rep.RemovedAttributes, k) {
			t.Errorf("attribute %s should be reported as never stored; got %v", k, rep.RemovedAttributes)
		}
	}
	if slices.Contains(rep.RemovedAttributes, "http.route") {
		t.Errorf("http.route is re-normalised into scf.route, not removed")
	}
	if len(rep.Hints) != 4 {
		t.Errorf("want 3 drop hints and 1 unknown-route hint, got %d: %v", len(rep.Hints), rep.Hints)
	}
}

// Nothing secret, personal or identifying from the input may appear in the
// report: values of removed attributes are never echoed.
func TestReportNeverEchoesSensitiveValues(t *testing.T) {
	for _, f := range []string{"testdata/sample.metrics.json",
		filepath.Join(sdkFixtures, "node-express.metrics.json"), filepath.Join(sdkFixtures, "node-express.traces.json"),
		filepath.Join(sdkFixtures, "go-otelhttp.traces.json"), filepath.Join(sdkFixtures, "python-default.traces.json")} {
		var out, errb bytes.Buffer
		if code := run([]string{"check", "-f", f, "--json"}, nil, &out, &errb); code != exitOK {
			t.Fatalf("%s: exit %d: %s", f, code, errb.String())
		}
		for _, bad := range []string{"CANARY-RES-", "CANARY-PATH", "203.0.113.9", "Mozilla", "token=", "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ", "build-host-7"} {
			if strings.Contains(out.String(), bad) {
				t.Errorf("%s: report contains %q", f, bad)
			}
		}
	}
}

func TestSDKTracesRoutesNormalised(t *testing.T) {
	rep, err := Check(mustRead(t, filepath.Join(sdkFixtures, "node-express.traces.json")), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Signal != "traces" || rep.KeptItems == 0 {
		t.Fatalf("signal %s kept %d", rep.Signal, rep.KeptItems)
	}
	var sawID bool
	for _, s := range rep.Kept {
		if s.Route == "/accounts/{id}" {
			sawID = true
		}
	}
	if !sawID {
		t.Errorf("expected /accounts/{id} among kept routes: %+v", rep.Kept)
	}
	if rep.KeptItems+int(rep.DroppedItems()) != rep.InputItems {
		t.Errorf("kept %d + dropped %d != input %d", rep.KeptItems, rep.DroppedItems(), rep.InputItems)
	}
}

func TestReceivedAtNowMakesOldSampleTooOld(t *testing.T) {
	// The sample is from 2026-11-12; checked against the wall clock (≥ 7 days
	// later) every point is older than the 48 h bound.
	rep, err := Check(mustRead(t, "testdata/sample.metrics.json"), Options{Services: "*", ReceivedAt: "now"})
	if err != nil {
		t.Fatal(err)
	}
	if rep.KeptItems != 0 {
		t.Fatalf("kept %d, want 0", rep.KeptItems)
	}
	var tooOld int64
	for _, d := range rep.Dropped {
		if d.Reason == "too_old" {
			tooOld += d.Count
		}
	}
	if tooOld == 0 {
		t.Fatalf("no too_old drops: %+v", rep.Dropped)
	}
}

func TestExitCodes(t *testing.T) {
	var out, errb bytes.Buffer
	if c := run([]string{"check", "-f", "testdata/sample.metrics.json", "--services", "anchor-api", "--fail-on-drop"}, nil, &out, &errb); c != exitDropped {
		t.Errorf("fail-on-drop exit = %d, want %d", c, exitDropped)
	}
	if c := run([]string{"check"}, strings.NewReader(`{"hello":1}`), &out, &errb); c != exitUsage {
		t.Errorf("non-OTLP exit = %d, want %d", c, exitUsage)
	}
	if c := run([]string{"bogus"}, nil, &out, &errb); c != exitUsage {
		t.Errorf("unknown command exit = %d", c)
	}
	out.Reset()
	if c := run([]string{"check", "--json"}, bytes.NewReader(mustRead(t, "testdata/sample.metrics.json")), &out, &errb); c != exitOK {
		t.Fatalf("stdin exit = %d: %s", c, errb.String())
	}
	var rep Report
	if err := json.Unmarshal(out.Bytes(), &rep); err != nil || rep.InputItems != 6 {
		t.Fatalf("json report: %v %+v", err, rep)
	}
}
