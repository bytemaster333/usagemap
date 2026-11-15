// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

func sign(t *testing.T, priv ed25519.PrivateKey, kid string, p Payload) []byte {
	t.Helper()
	pb, _ := json.Marshal(p)
	env := Envelope{Format: Format, Alg: "Ed25519", Kid: kid, Payload: base64.RawURLEncoding.EncodeToString(pb),
		Sig: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, pb))}
	b, _ := json.Marshal(env)
	return b
}

func payload(seq int64) Payload {
	twin := "0193b7e2-0000-7000-8000-0000000000b2"
	return Payload{Sequence: seq, IssuedAt: "2026-11-12T10:00:00Z",
		Settings: Settings{PowCost: 512, PowMax: 1024, PowMaxMultiplier: 8, WebEventsPerToken: 300, WebRequestsPerMinSubnet: 600, PathnormRulesVersion: "scf-path-rules/1.0.0"},
		Tenants:  []Tenant{{TenantID: "t1", Status: "active", Level: 1}},
		Sites: []Site{{SiteID: "s1", TenantID: "t1", SiteKey: "Q4mZ8bS1pTn0aR7cLx2VwE", UmamiWebsiteID: "w1", UmamiTwinWebsiteID: &twin,
			Status: "active", Profile: "standard", VisitorID: "off_in", VisitorIDOffCountries: []string{"DE"}, ExcludeCountries: []string{"RU"},
			PathFolding: "full", RateLimitPerMin: 6000, DailyQuota: 1000000,
			Domains: []Domain{{Host: "example.org", IncludeSubdomains: true, Verified: true}, {Host: "other.test", Verified: false}}}},
		TrackerVersions: []TrackerVersion{{Version: "1.0.0", Status: "active"}, {Version: "0.9.0", Status: "withdrawn"}},
	}
}

func keyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func TestVerifyOrderAndAntiRollback(t *testing.T) {
	pub, priv := keyPair(t)
	_, other := keyPair(t)
	keys := Keys{"edge-1": pub}
	if _, err := Verify(sign(t, priv, "edge-1", payload(5)), keys, 0); err != nil {
		t.Fatal(err)
	}
	cases := map[string]struct {
		raw  []byte
		cur  int64
		want error
	}{
		"unknown kid":   {sign(t, priv, "edge-9", payload(5)), 0, ErrKid},
		"bad signature": {sign(t, other, "edge-1", payload(5)), 0, ErrSignature},
		"garbage":       {[]byte("{"), 0, ErrMalformed},
		"older":         {sign(t, priv, "edge-1", payload(4)), 5, ErrRollback},
		"same":          {sign(t, priv, "edge-1", payload(5)), 5, ErrSame},
	}
	for name, c := range cases {
		if _, err := Verify(c.raw, keys, c.cur); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", name, err, c.want)
		}
	}
	// Signature is over the exact payload bytes: re-encoding the payload breaks it.
	var env Envelope
	_ = json.Unmarshal(sign(t, priv, "edge-1", payload(6)), &env)
	pb, _ := base64.RawURLEncoding.DecodeString(env.Payload)
	var m map[string]any
	_ = json.Unmarshal(pb, &m)
	pb2, _ := json.MarshalIndent(m, "", " ")
	env.Payload = base64.RawURLEncoding.EncodeToString(pb2)
	raw, _ := json.Marshal(env)
	if _, err := Verify(raw, keys, 0); !errors.Is(err, ErrSignature) {
		t.Fatalf("re-encoded payload accepted: %v", err)
	}
}

func TestStorePersistsAndReloads(t *testing.T) {
	pub, priv := keyPair(t)
	path := filepath.Join(t.TempDir(), "state", "snapshot.json")
	s := NewStore(path, Keys{"edge-1": pub})
	if s.Current() != nil {
		t.Fatal("no snapshot yet")
	}
	if err := s.Apply(sign(t, priv, "edge-1", payload(7))); err != nil {
		t.Fatal(err)
	}
	if err := s.Apply(sign(t, priv, "edge-1", payload(3))); !errors.Is(err, ErrRollback) || s.Rollbacks() != 1 || s.Sequence() != 7 {
		t.Fatalf("rollback not refused: %v seq %d", err, s.Sequence())
	}
	s2 := NewStore(path, Keys{"edge-1": pub})
	if err := s2.LoadFromDisk(); err != nil || s2.Sequence() != 7 {
		t.Fatalf("reload: %v seq %d", err, s2.Sequence())
	}
	// A tampered file on disk is refused at start (no snapshot → ingest 503).
	_ = os.WriteFile(path, sign(t, priv, "edge-x", payload(8)), 0o600)
	s3 := NewStore(path, Keys{"edge-1": pub})
	if err := s3.LoadFromDisk(); err == nil || s3.Current() != nil {
		t.Fatal("tampered snapshot accepted")
	}
}

func TestViewLookups(t *testing.T) {
	v, err := NewView(payload(1))
	if err != nil {
		t.Fatal(err)
	}
	s := v.SiteByKey("Q4mZ8bS1pTn0aR7cLx2VwE")
	if s == nil || v.SiteByKey("AAAAAAAAAAAAAAAAAAAAAA") != nil {
		t.Fatal("site lookup")
	}
	if d := s.DomainMatch("www.example.org"); d == nil || !d.Verified {
		t.Fatal("subdomain of include_subdomains domain")
	}
	if s.DomainMatch("evilexample.org") != nil || s.DomainMatch("www.other.test") != nil {
		t.Fatal("non-matching hosts accepted")
	}
	if d := s.DomainMatch("OTHER.test."); d == nil || d.Verified {
		t.Fatal("case/trailing dot and unverified flag")
	}
	if !v.Withdrawn("0.9.0") || v.Withdrawn("1.0.0") {
		t.Fatal("withdrawn")
	}
	if !v.Excluded(s, "RU") || v.Excluded(s, "DE") {
		t.Fatal("exclude_countries")
	}
	if v.Identified(s, "DE") || !v.Identified(s, "FR") {
		t.Fatal("visitor_id off_in")
	}
	if !v.KnownHost("a.b.example.org") || v.KnownHost("x.test") {
		t.Fatal("KnownHost")
	}
}

type fakeCore struct {
	mu   sync.Mutex
	env  []byte
	seq  int64
	hits int
}

func (f *fakeCore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hits++
	if r.Header.Get("If-None-Match") == `"`+strconv.FormatInt(f.seq, 10)+`"` {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(f.env)
}

// TestRevokedTokenRefusedWithin60s: the poll interval (30 s ± 5 s) bounds the delay between the control plane
// issuing a snapshot without a token and every node refusing it (C-06: ≤ 60 s including the 10 s rebuild).
func TestRevokedTokenRefusedWithin60s(t *testing.T) {
	pub, priv := keyPair(t)
	pepper := []byte("pepper-ing-v1-for-tests-32-bytes")
	secret := "AbCdEfGhIjKlMnOpQrStUvWxYz0"
	m := hmac.New(sha256.New, pepper)
	m.Write([]byte(secret))
	p := payload(1)
	p.IngestTokens = []IngestToken{{TokenID: "AAAAAAAAAAAA", TenantID: "t1", Hash: base64.RawURLEncoding.EncodeToString(m.Sum(nil)), PepperVersion: 1}}
	core := &fakeCore{env: sign(t, priv, "edge-1", p), seq: 1}
	srv := httptest.NewServer(core)
	defer srv.Close()
	store := NewStore(filepath.Join(t.TempDir(), "s.json"), Keys{"edge-1": pub})
	f := &Fetcher{Store: store, Cores: []Core{{ID: "core-a", URL: srv.URL}}, Client: srv.Client(), Interval: 30 * time.Second, Jitter: 5 * time.Second,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := f.FetchOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if _, ok := store.Current().TokenFor("AAAAAAAAAAAA", secret, map[int][]byte{1: pepper}, now); !ok {
		t.Fatal("valid token refused")
	}
	if _, ok := store.Current().TokenFor("AAAAAAAAAAAA", "wrong", map[int][]byte{1: pepper}, now); ok {
		t.Fatal("wrong secret accepted")
	}
	// Revocation: the next snapshot omits the token.
	p2 := payload(2)
	core.mu.Lock()
	core.env, core.seq = sign(t, priv, "edge-1", p2), 2
	core.mu.Unlock()
	if f.Interval+f.Jitter+10*time.Second > 60*time.Second {
		t.Fatal("poll interval + jitter + rebuild exceeds 60 s")
	}
	if err := f.FetchOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.Current().TokenFor("AAAAAAAAAAAA", secret, map[int][]byte{1: pepper}, now); ok {
		t.Fatal("revoked token still accepted after the next poll")
	}
	if err := f.FetchOnce(context.Background()); err != nil { // 304 path
		t.Fatal(err)
	}
	if store.Age(time.Now(), time.Now()) > time.Second {
		t.Fatal("age not reset by 304")
	}
}

func TestStaleKeepsLastGood(t *testing.T) {
	pub, priv := keyPair(t)
	store := NewStore(filepath.Join(t.TempDir(), "s.json"), Keys{"edge-1": pub})
	if err := store.Apply(sign(t, priv, "edge-1", payload(3))); err != nil {
		t.Fatal(err)
	}
	store.MarkFresh(time.Now().Add(-16 * time.Minute))
	f := &Fetcher{Store: store, Cores: []Core{{ID: "core-a", URL: "http://127.0.0.1:1"}}, Client: &http.Client{Timeout: time.Second}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := f.FetchOnce(context.Background()); err == nil {
		t.Fatal("expected failure")
	}
	if store.Current() == nil || store.Sequence() != 3 {
		t.Fatal("last good snapshot must stay in use")
	}
	if store.Age(time.Now(), time.Now()) < 15*time.Minute {
		t.Fatal("age must grow while fetches fail")
	}
}

// C-124: multiplicity_mode — site override, else platform setting, else enforce; unknown values ignored; the fields
// are optional so snapshots without them still verify and apply.
func TestMultiplicityMode(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		platform string
		site     *string
		want     string
	}{
		{"", nil, ModeEnforce}, {"shadow", nil, ModeShadow}, {"enforce", str("shadow"), ModeShadow},
		{"shadow", str("enforce"), ModeEnforce}, {"bogus", str("bogus"), ModeEnforce}, {"shadow", str(""), ModeShadow},
	} {
		v, err := NewView(Payload{Settings: Settings{MultiplicityMode: c.platform}})
		if err != nil {
			t.Fatal(err)
		}
		if got := v.MultiplicityMode(&Site{MultiplicityMode: c.site}); got != c.want {
			t.Errorf("platform %q site %v: %s, want %s", c.platform, c.site, got, c.want)
		}
	}
	var p Payload
	if err := json.Unmarshal([]byte(`{"settings":{"multiplicity_mode":"shadow"},"sites":[{"site_id":"x","multiplicity_mode":null}]}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.Settings.MultiplicityMode != "shadow" || p.Sites[0].MultiplicityMode != nil {
		t.Fatalf("decoded %+v", p)
	}
}

// §e.4 hard expiry (F12): expires_at parsed; Expired only after the 5-minute grace; a payload without it never
// expires; a malformed one is refused; booting with an expired snapshot on disk behaves as if there were none, a
// valid one on disk is used; a newer valid snapshot replaces an expired one.
func TestHardExpiry(t *testing.T) {
	pub, priv := keyPair(t)
	exp := time.Date(2026, 11, 13, 10, 0, 0, 0, time.UTC)
	p := payload(3)
	p.ExpiresAt = exp.Format(time.RFC3339)
	v, err := NewView(p)
	if err != nil {
		t.Fatal(err)
	}
	if v.Expired(exp.Add(4*time.Minute)) || !v.Expired(exp.Add(6*time.Minute)) {
		t.Fatal("grace of 5 minutes not applied")
	}
	if at, ok := v.ExpiresAtOK(); !ok || !at.Equal(exp) {
		t.Fatal("ExpiresAtOK")
	}
	never, _ := NewView(payload(4))
	if never.Expired(exp.Add(1000 * time.Hour)) {
		t.Fatal("no expires_at must never expire")
	}
	var nilView *View
	if nilView.Expired(exp) {
		t.Fatal("nil view")
	}
	bad := payload(5)
	bad.ExpiresAt = "tomorrow"
	if _, err := NewView(bad); err == nil {
		t.Fatal("malformed expires_at accepted")
	}

	path := filepath.Join(t.TempDir(), "snapshot.json")
	s := NewStore(path, Keys{"edge-1": pub})
	if err := s.Apply(sign(t, priv, "edge-1", p)); err != nil {
		t.Fatal(err)
	}
	late := NewStore(path, Keys{"edge-1": pub})
	late.Now = func() time.Time { return exp.Add(time.Hour) }
	if err := late.LoadFromDisk(); !errors.Is(err, ErrExpired) || late.Current() != nil {
		t.Fatalf("expired snapshot on disk must count as none: %v", err)
	}
	// It still polls: a newer valid snapshot is accepted from sequence 0.
	p2 := payload(4)
	p2.ExpiresAt = exp.Add(24 * time.Hour).Format(time.RFC3339)
	if err := late.Apply(sign(t, priv, "edge-1", p2)); err != nil || late.Current().Expired(exp.Add(time.Hour)) {
		t.Fatalf("newer snapshot: %v", err)
	}
	early := NewStore(path, Keys{"edge-1": pub})
	early.Now = func() time.Time { return exp.Add(-time.Hour) }
	_ = os.WriteFile(path, sign(t, priv, "edge-1", p), 0o600)
	if err := early.LoadFromDisk(); err != nil || early.Sequence() != 3 {
		t.Fatalf("valid snapshot on disk: %v", err)
	}
}
