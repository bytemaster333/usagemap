// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"encoding/json"
	"testing"
	"time"
)

// Dev origins, debug mode and the optional C-136/C-137 snapshot fields (wire-formats §a.8, §e.3).

func TestDevOriginMatching(t *testing.T) {
	v, err := NewView(Payload{Sequence: 1, Sites: []Site{{SiteID: "s", SiteKey: "Q4mZ8bS1pTn0aR7cLx2VwE", UmamiWebsiteID: "w",
		Domains:    []Domain{{Host: "app.example.org"}, {Host: "example.net", IncludeSubdomains: true}},
		DevOrigins: []string{"localhost", "127.0.0.1", "staging.example.com", "myapp-*.vercel.app", "*-myteam.example.org", "*.preview.example.org", "pr-*.example.net", "*.*.bad", "x.*.bad"}}}})
	if err != nil {
		t.Fatal(err)
	}
	s := v.SiteByID("s")
	cases := map[string]bool{
		"http://localhost:3000":             true,
		"https://localhost":                 true,
		"http://localhost":                  true,
		"http://127.0.0.1:8080":             true,
		"ftp://localhost":                   false,
		"http://localhost.evil.test":        false,
		"https://staging.example.com":       true,
		"https://staging.example.com:443":   true,
		"https://staging.example.com:8443":  false, // exact host: default port only
		"http://staging.example.com":        false, // https only
		"https://sub.staging.example.com":   false,
		"https://myapp-pr-7.vercel.app":     true,
		"https://myapp-.vercel.app":         false, // `*` matches one or more characters
		"https://myapp-a.b.vercel.app":      false, // never a dot
		"https://yourapp-1.vercel.app":      false,
		"http://myapp-1.vercel.app":         false,
		"https://feat-x-myteam.example.org": true,
		"https://a.preview.example.org":     true,
		"https://preview.example.org":       false,
		"https://a.b.preview.example.org":   false,
		"https://pr-1.example.net":          false, // a declared domain (include_subdomains) wins
		"https://app.example.org":           false, // declared
		"https://a.x.bad":                   false, // malformed entries are ignored
		"null":                              false,
	}
	for origin, want := range cases {
		o, ok := ParseOrigin(origin)
		if got := ok && s.IsDev(o); got != want {
			t.Errorf("%s: IsDev = %v, want %v", origin, got, want)
		}
	}
	// pr-1.example.net matches the pattern but is declared: DevMatch alone says yes, IsDev no.
	if o, _ := ParseOrigin("https://pr-1.example.net"); !s.DevMatch(o) {
		t.Fatal("pattern itself should match")
	}
}

func TestOptionalD1Fields(t *testing.T) {
	// A payload without the new fields (an older control plane) parses with the documented defaults.
	var old Payload
	if err := json.Unmarshal([]byte(`{"sequence":1,"issued_at":"2026-11-16T00:00:00Z","settings":{"pow_cost":512},"tenants":[],
		"sites":[{"site_id":"s","site_key":"Q4mZ8bS1pTn0aR7cLx2VwE","umami_website_id":"w","domains":[]}],"ingest_tokens":[],"tracker_versions":[]}`), &old); err != nil {
		t.Fatal(err)
	}
	v, err := NewView(old)
	if err != nil {
		t.Fatal(err)
	}
	if v.Settings.DevEventsPerMin() != 120 || v.Settings.HasFeature(FeatureProps) || v.Settings.HasFeature(FeatureDev) || v.Sites[0].DebugOn(time.Now()) {
		t.Fatalf("defaults %+v", v.Settings)
	}
	// The new fields, plus an unknown future field (ignored, §e.3).
	var p Payload
	if err := json.Unmarshal([]byte(`{"sequence":2,"issued_at":"2026-11-16T00:00:00Z","settings":{"dev_events_per_min_site":30,"counter_features":["props","dev"],"future":1},
		"tenants":[],"sites":[{"site_id":"s","site_key":"Q4mZ8bS1pTn0aR7cLx2VwE","umami_website_id":"w","domains":[],
		"dev_origins":["localhost"],"debug_until":"2026-11-16T12:00:00Z","future":true}],"ingest_tokens":[],"tracker_versions":[]}`), &p); err != nil {
		t.Fatal(err)
	}
	v, err = NewView(p)
	if err != nil {
		t.Fatal(err)
	}
	s := v.Sites[0]
	if v.Settings.DevEventsPerMin() != 30 || !v.Settings.HasFeature(FeatureProps) || !v.Settings.HasFeature(FeatureDev) {
		t.Fatalf("settings %+v", v.Settings)
	}
	at := time.Date(2026, 11, 16, 11, 59, 59, 0, time.UTC)
	if !s.DebugOn(at) || s.DebugOn(at.Add(time.Second)) {
		t.Fatal("debug_until bounds")
	}
	if !v.PreflightOK("https://anything.test", at) || v.PreflightOK("https://anything.test", at.Add(time.Hour)) {
		t.Fatal("debug mode opens the preflight to any origin, and only while on")
	}
	if !v.PreflightOK("http://localhost:5173", at.Add(time.Hour)) {
		t.Fatal("dev origin preflight")
	}
	// A malformed debug_until leaves debug mode off (fail closed).
	bad := "tomorrow"
	p.Sites[0].DebugUntil = &bad
	v, _ = NewView(p)
	if v.Sites[0].DebugOn(at) {
		t.Fatal("malformed debug_until must not turn debug mode on")
	}
}
