// SPDX-License-Identifier: Apache-2.0

// Package snapshot consumes the control plane's signed edge snapshot (wire-formats §e; C-05, C-06, C-62, C-90):
// verification (Ed25519 over the exact payload bytes, pinned key ids, anti-rollback sequence), atomic application,
// persistence of the last good envelope, and staleness reporting.
package snapshot

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Format is the envelope format.
const Format = "scf-edge-snapshot/1"

// MaxEnvelope is the size cap of an envelope (§e.2).
const MaxEnvelope = 32 << 20

// Envelope is the signed wrapper.
type Envelope struct {
	Format  string `json:"format"`
	Alg     string `json:"alg"`
	Kid     string `json:"kid"`
	Payload string `json:"payload"`
	Sig     string `json:"sig"`
}

// Thresholds are the multiplicity thresholds per cell kind and ASN class.
type Thresholds map[string]map[string]int

// Settings of §e.3.
type Settings struct {
	PowCost                     int        `json:"pow_cost"`
	PowMax                      int        `json:"pow_max"`
	PowMaxMultiplier            int        `json:"pow_max_multiplier"`
	WebEventsPerToken           int        `json:"web_events_per_token"`
	MultiplicityThresholds      Thresholds `json:"multiplicity_thresholds"`
	MultiplicityEventThresholds Thresholds `json:"multiplicity_event_thresholds"`
	WebRequestsPerMinSubnet     int        `json:"web_requests_per_min_subnet"`
	OTLPRequestsPerS            int        `json:"otlp_requests_per_s"`
	OTLPBurst                   int        `json:"otlp_burst"`
	OTLPBytesPerS               int        `json:"otlp_bytes_per_s"`
	PathnormRulesVersion        string     `json:"pathnorm_rules_version"`
	// MultiplicityMode is the platform default `enforce` | `shadow` (C-124; absent = enforce).
	MultiplicityMode string `json:"multiplicity_mode,omitempty"`
	// DevEventsPerMinSite caps dev-class events per site and minute on this node (C-136, §a.8; absent = 120).
	DevEventsPerMinSite int `json:"dev_events_per_min_site,omitempty"`
	// CounterFeatures lists the optional counter-record parts the core accepts (C-137, §d.3: "props", "dev";
	// absent = none). A part not listed is never sent.
	CounterFeatures []string `json:"counter_features,omitempty"`
}

// DefaultDevEventsPerMinSite is the platform default of dev_events_per_min_site (§e.3).
const DefaultDevEventsPerMinSite = 120

// DevEventsPerMin is the effective dev limit per site and minute.
func (s Settings) DevEventsPerMin() int {
	if s.DevEventsPerMinSite >= 1 {
		return s.DevEventsPerMinSite
	}
	return DefaultDevEventsPerMinSite
}

// Counter-record parts gated by settings.counter_features (C-137).
const (
	FeatureProps = "props"
	FeatureDev   = "dev"
	// FeatureApp gates the self-attested app-event part (§a.9, migration 0084).
	FeatureApp = "app"
	// FeatureRPC gates the browser Stellar RPC/Horizon aggregate part (§a.3.2, table web_rpc_client_daily).
	FeatureRPC = "rpc"
)

// HasFeature reports whether the core advertises an optional counter-record part.
func (s Settings) HasFeature(f string) bool {
	for _, x := range s.CounterFeatures {
		if x == f {
			return true
		}
	}
	return false
}

// Tenant of §e.3.
type Tenant struct {
	TenantID string `json:"tenant_id"`
	Status   string `json:"status"` // pending, active, suspended
	Level    int    `json:"level"`
}

// Domain of a site.
type Domain struct {
	Host              string `json:"host"`
	IncludeSubdomains bool   `json:"include_subdomains"`
	Verified          bool   `json:"verified"`
}

// Site of §e.3.
type Site struct {
	SiteID                string   `json:"site_id"`
	TenantID              string   `json:"tenant_id"`
	SiteKey               string   `json:"site_key"`
	UmamiWebsiteID        string   `json:"umami_website_id"`
	UmamiTwinWebsiteID    *string  `json:"umami_twin_website_id"`
	Status                string   `json:"status"` // active, over_quota
	Profile               string   `json:"profile"`
	VisitorID             string   `json:"visitor_id"`
	VisitorIDOffCountries []string `json:"visitor_id_off_countries"`
	ExcludeCountries      []string `json:"exclude_countries"`
	PathFolding           string   `json:"path_folding"`
	RateLimitPerMin       int      `json:"rate_limit_per_min"`
	DailyQuota            int      `json:"daily_quota"`
	Domains               []Domain `json:"domains"`
	// MultiplicityMode overrides the platform setting for this site (`enforce` | `shadow`; null/absent = inherit, C-124).
	MultiplicityMode *string `json:"multiplicity_mode,omitempty"`
	// DevOrigins are the site's dev/preview origins (C-136, §a.8; absent = none).
	DevOrigins []string `json:"dev_origins,omitempty"`
	// DebugUntil is the end of the site's debug mode (C-136, §a.8; absent or null = off).
	DebugUntil *string `json:"debug_until,omitempty"`

	devOrigins []devOrigin
	debugUntil time.Time
}

// IngestToken of §e.3 (OTLP; used by the OTLP front door).
type IngestToken struct {
	TokenID             string   `json:"token_id"`
	TenantID            string   `json:"tenant_id"`
	Hash                string   `json:"hash"`
	PepperVersion       int      `json:"pepper_version"`
	AllowedServiceNames []string `json:"allowed_service_names"`
	ExpiresAt           *string  `json:"expires_at"`
}

// TrackerVersion of §e.3.
type TrackerVersion struct {
	Version string `json:"version"`
	Status  string `json:"status"` // active, withdrawn
}

// Payload of §e.3.
type Payload struct {
	Sequence int64  `json:"sequence"`
	IssuedAt string `json:"issued_at"`
	// ExpiresAt is the hard expiry (§e.4, F12): optional; absent = never expires.
	ExpiresAt       string           `json:"expires_at,omitempty"`
	Settings        Settings         `json:"settings"`
	Tenants         []Tenant         `json:"tenants"`
	Sites           []Site           `json:"sites"`
	IngestTokens    []IngestToken    `json:"ingest_tokens"`
	TrackerVersions []TrackerVersion `json:"tracker_versions"`
}

// View is an applied snapshot with lookup indexes. Immutable once built.
type View struct {
	Payload
	sitesByKey  map[string]*Site
	sitesByID   map[string]*Site
	tenants     map[string]*Tenant
	tokens      map[string]*IngestToken
	withdrawn   map[string]bool
	hosts       map[string]bool // every declared host, for CORS preflight
	excludeSets map[string]map[string]bool
	offInSets   map[string]map[string]bool
	expires     time.Time // zero = never
}

// ExpiryGrace tolerates clock skew between the control plane and the edge (§e.4).
const ExpiryGrace = 5 * time.Minute

// ExpiresAtOK returns the hard expiry and whether the snapshot has one (nil view: none).
func (v *View) ExpiresAtOK() (time.Time, bool) {
	if v == nil {
		return time.Time{}, false
	}
	return v.expires, !v.expires.IsZero()
}

// Expired reports whether the snapshot is past expires_at + ExpiryGrace at now: the node must refuse new ingest
// (503 snapshot_expired) until a newer valid snapshot arrives (§e.4).
func (v *View) Expired(now time.Time) bool {
	return v != nil && !v.expires.IsZero() && now.After(v.expires.Add(ExpiryGrace))
}

// NewView indexes a payload without verification (tests and the apply path).
func NewView(p Payload) (*View, error) { return build(p) }

func build(p Payload) (*View, error) {
	v := &View{Payload: p, sitesByKey: map[string]*Site{}, sitesByID: map[string]*Site{}, tenants: map[string]*Tenant{},
		tokens: map[string]*IngestToken{}, withdrawn: map[string]bool{}, hosts: map[string]bool{},
		excludeSets: map[string]map[string]bool{}, offInSets: map[string]map[string]bool{}}
	if p.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339Nano, p.ExpiresAt)
		if err != nil {
			return nil, fmt.Errorf("snapshot: malformed expires_at")
		}
		v.expires = t
	}
	for i := range v.Tenants {
		t := &v.Tenants[i]
		v.tenants[t.TenantID] = t
	}
	for i := range v.Sites {
		s := &v.Sites[i]
		if len(s.SiteKey) != 22 || s.SiteID == "" || s.UmamiWebsiteID == "" {
			return nil, fmt.Errorf("snapshot: malformed site entry %d", i)
		}
		s.devOrigins = compileDevOrigins(s.DevOrigins)
		s.debugUntil = time.Time{}
		if s.DebugUntil != nil && *s.DebugUntil != "" {
			if t, err := time.Parse(time.RFC3339Nano, *s.DebugUntil); err == nil {
				s.debugUntil = t // a malformed value leaves debug mode off (fail closed)
			}
		}
		v.sitesByKey[s.SiteKey] = s
		v.sitesByID[s.SiteID] = s
		ex := map[string]bool{}
		for _, c := range s.ExcludeCountries {
			ex[c] = true
		}
		v.excludeSets[s.SiteID] = ex
		off := map[string]bool{}
		for _, c := range s.VisitorIDOffCountries {
			off[c] = true
		}
		v.offInSets[s.SiteID] = off
		for _, d := range s.Domains {
			v.hosts[strings.ToLower(d.Host)] = true
		}
	}
	for i := range v.IngestTokens {
		t := &v.IngestTokens[i]
		v.tokens[t.TokenID] = t
	}
	for _, tv := range v.TrackerVersions {
		if tv.Status == "withdrawn" {
			v.withdrawn[tv.Version] = true
		}
	}
	return v, nil
}

// SiteByKey returns the site for a public site key, or nil (→ 404).
func (v *View) SiteByKey(k string) *Site { return v.sitesByKey[k] }

// SiteByID returns a site by id, or nil.
func (v *View) SiteByID(id string) *Site { return v.sitesByID[id] }

// Multiplicity modes (C-124).
const (
	ModeEnforce = "enforce"
	ModeShadow  = "shadow"
)

// MultiplicityMode is the effective mode of a site: its own override, else the platform setting, else enforce.
// Unknown values are ignored (fail towards the documented default).
func (v *View) MultiplicityMode(s *Site) string {
	if s != nil && s.MultiplicityMode != nil && (*s.MultiplicityMode == ModeEnforce || *s.MultiplicityMode == ModeShadow) {
		return *s.MultiplicityMode
	}
	if m := v.Settings.MultiplicityMode; m == ModeEnforce || m == ModeShadow {
		return m
	}
	return ModeEnforce
}

// Tenant returns a tenant, or nil.
func (v *View) Tenant(id string) *Tenant { return v.tenants[id] }

// Withdrawn reports a withdrawn tracker version (→ 410).
func (v *View) Withdrawn(version string) bool { return v.withdrawn[version] }

// PreflightOK reports whether a CORS preflight from origin may be answered with CORS headers: the origin's host is a
// declared domain of any site, it matches a dev origin of any site, or some site is in debug mode (§a.1, §a.8; the
// preflight carries no body, so the site is not known yet).
func (v *View) PreflightOK(origin string, now time.Time) bool {
	o, ok := ParseOrigin(origin)
	if !ok {
		return false
	}
	if v.KnownHost(o.Host) {
		return true
	}
	for i := range v.Sites {
		s := &v.Sites[i]
		if s.DebugOn(now) || s.DevMatch(o) {
			return true
		}
	}
	return false
}

// KnownHost reports whether host is a declared domain of any site (CORS preflight).
func (v *View) KnownHost(host string) bool {
	host = strings.ToLower(host)
	if v.hosts[host] {
		return true
	}
	for _, s := range v.Sites {
		if s.DomainMatch(host) != nil {
			return true
		}
	}
	return false
}

// Excluded reports whether country is in the site's exclude_countries (C-58).
func (v *View) Excluded(s *Site, country string) bool { return v.excludeSets[s.SiteID][country] }

// Identified reports whether events of a visitor from country carry an identifier (visitor_id, C-02, C-58).
func (v *View) Identified(s *Site, country string) bool {
	switch s.VisitorID {
	case "off":
		return false
	case "off_in":
		return !v.offInSets[s.SiteID][country]
	default:
		return true
	}
}

// DomainMatch returns the site domain that host belongs to: an exact match, or a subdomain of a domain declared with
// include_subdomains. nil when host is not a declared domain of the site.
func (s *Site) DomainMatch(host string) *Domain {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for i := range s.Domains {
		d := &s.Domains[i]
		h := strings.ToLower(d.Host)
		if host == h || d.IncludeSubdomains && strings.HasSuffix(host, "."+h) {
			return d
		}
	}
	return nil
}

// Token returns an ingest token entry by id, or nil (revoked, expired before the snapshot was built, unknown).
func (v *View) Token(id string) *IngestToken { return v.tokens[id] }

// TokenFor looks up an ingest token (OTLP front door): it is valid only while it is in the current snapshot, so a
// revoked token stops authenticating with the next snapshot (≤ 60 s, C-06). secret is checked by the caller-supplied
// pepper set: HMAC-SHA-256(pepper_ing[pepper_version], secret), base64url.
func (v *View) TokenFor(tokenID, secret string, peppers map[int][]byte, now time.Time) (*IngestToken, bool) {
	t := v.tokens[tokenID]
	if t == nil {
		return nil, false
	}
	pep := peppers[t.PepperVersion]
	if pep == nil {
		return nil, false
	}
	m := hmac.New(sha256.New, pep)
	m.Write([]byte(secret))
	want, err := base64.RawURLEncoding.DecodeString(t.Hash)
	if err != nil || !hmac.Equal(m.Sum(nil), want) {
		return nil, false
	}
	if t.ExpiresAt != nil {
		exp, err := time.Parse(time.RFC3339Nano, *t.ExpiresAt)
		if err != nil || !now.Before(exp) {
			return nil, false
		}
	}
	return t, true
}

// Keys are the pinned verification keys (kid → Ed25519 public key; at most two for rotation).
type Keys map[string]ed25519.PublicKey

// ParseKeys reads "kid=path,kid=path". Each file is a PEM SubjectPublicKeyInfo Ed25519 key.
func ParseKeys(spec string) (Keys, error) {
	ks := Keys{}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kid, path, ok := strings.Cut(part, "=")
		if !ok || kid == "" {
			return nil, fmt.Errorf("snapshot keys: expected kid=path, got %q", part)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		pub, err := ParsePublicKey(b)
		if err != nil {
			return nil, fmt.Errorf("snapshot key %s: %w", kid, err)
		}
		ks[kid] = pub
	}
	if len(ks) == 0 || len(ks) > 2 {
		return nil, errors.New("snapshot keys: configure one or two kid=path entries")
	}
	return ks, nil
}

// ParsePublicKey parses a PEM PUBLIC KEY (SPKI) holding an Ed25519 key.
func ParsePublicKey(b []byte) (ed25519.PublicKey, error) {
	blk, _ := pem.Decode(b)
	if blk == nil || blk.Type != "PUBLIC KEY" {
		return nil, errors.New("expected a PEM PUBLIC KEY")
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	return pub, nil
}

// Errors of Verify; the fetcher maps them to metric labels.
var (
	ErrMalformed = errors.New("malformed envelope")
	ErrKid       = errors.New("unknown kid")
	ErrSignature = errors.New("bad signature")
	ErrFormat    = errors.New("bad format")
	ErrRollback  = errors.New("older sequence refused")
	ErrSame      = errors.New("same sequence")
)

// Verify checks an envelope in the order of §e.2 and returns the payload. current is the sequence in use (0 = none).
func Verify(raw []byte, keys Keys, current int64) (Payload, error) {
	var p Payload
	if len(raw) > MaxEnvelope {
		return p, ErrMalformed
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return p, ErrMalformed
	}
	key, ok := keys[env.Kid]
	if !ok || env.Alg != "Ed25519" {
		return p, ErrKid
	}
	payload, err := base64.RawURLEncoding.DecodeString(env.Payload)
	if err != nil {
		return p, ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(env.Sig)
	if err != nil || !ed25519.Verify(key, payload, sig) {
		return p, ErrSignature
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return p, ErrMalformed
	}
	if env.Format != Format {
		return p, ErrFormat
	}
	if p.Sequence < 1 {
		return p, ErrMalformed
	}
	if p.Sequence == current {
		return p, ErrSame
	}
	if p.Sequence < current {
		return p, ErrRollback
	}
	return p, nil
}

// Store holds the current view and the last-good envelope on disk.
type Store struct {
	path      string
	keys      Keys
	cur       atomic.Pointer[View]
	mu        sync.Mutex
	lastFresh atomic.Int64 // unix ms of the last successful 200/304
	rollbacks atomic.Int64
	failures  sync.Map // reason -> *atomic.Int64
	listeners []func(*View)
	// Now is the clock for the boot-time expiry check (tests); nil = time.Now.
	Now func() time.Time
}

// ErrExpired: the persisted snapshot is past its hard expiry; the node starts as if it had none (§e.4).
var ErrExpired = errors.New("persisted snapshot expired")

// NewStore creates a store persisting to path (e.g. /var/lib/scf-gateway/snapshot.json).
func NewStore(path string, keys Keys) *Store { return &Store{path: path, keys: keys} }

// OnApply registers a callback run after each applied snapshot.
func (s *Store) OnApply(fn func(*View)) { s.listeners = append(s.listeners, fn) }

// Current returns the view in use, or nil (a node without a valid snapshot refuses ingest with 503, §e.4).
func (s *Store) Current() *View { return s.cur.Load() }

// Sequence of the view in use (0 = none).
func (s *Store) Sequence() int64 {
	if v := s.cur.Load(); v != nil {
		return v.Sequence
	}
	return 0
}

// LoadFromDisk applies the persisted envelope after verifying its signature (the start-up path).
func (s *Store) LoadFromDisk() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	return s.apply(raw, false)
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Apply verifies and applies a fetched envelope, then persists it (fsync + rename). It returns ErrSame for an equal
// sequence (no-op) and ErrRollback for an older one (refused, counted).
func (s *Store) Apply(raw []byte) error { return s.apply(raw, true) }

func (s *Store) apply(raw []byte, persist bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := Verify(raw, s.keys, s.Sequence())
	if err != nil {
		if errors.Is(err, ErrRollback) {
			s.rollbacks.Add(1)
		}
		if !errors.Is(err, ErrSame) {
			s.countFailure(err)
		}
		return err
	}
	v, err := build(p)
	if err != nil {
		s.countFailure(ErrMalformed)
		return err
	}
	if !persist && v.Expired(s.now()) {
		return ErrExpired // boot with an expired snapshot on disk = no snapshot
	}
	if persist {
		if err := writeAtomic(s.path, raw); err != nil {
			return err
		}
	}
	s.cur.Store(v)
	for _, fn := range s.listeners {
		fn(v)
	}
	return nil
}

func (s *Store) countFailure(err error) {
	c, _ := s.failures.LoadOrStore(err.Error(), new(atomic.Int64))
	c.(*atomic.Int64).Add(1)
}

// Failures returns verification failures by reason.
func (s *Store) Failures() map[string]int64 {
	out := map[string]int64{}
	s.failures.Range(func(k, v any) bool {
		out[k.(string)] = v.(*atomic.Int64).Load()
		return true
	})
	return out
}

// Rollbacks counts refused older sequences.
func (s *Store) Rollbacks() int64 { return s.rollbacks.Load() }

// MarkFresh records a successful 200/304 from a core.
func (s *Store) MarkFresh(t time.Time) { s.lastFresh.Store(t.UnixMilli()) }

// Age is the time since the last successful fetch (or since start when there was none).
func (s *Store) Age(now time.Time, started time.Time) time.Duration {
	ms := s.lastFresh.Load()
	if ms == 0 {
		return now.Sub(started)
	}
	return now.Sub(time.UnixMilli(ms))
}

func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".snapshot-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
