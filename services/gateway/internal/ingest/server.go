// SPDX-License-Identifier: Apache-2.0

// Package ingest serves the tracker protocol v1 (wire-formats §a): `POST /v1/c` (challenge) and `POST /v1/e`
// (events), applying every check of §a.6 in order, and turns accepted events into spool records (§d.2). Responses
// never reveal a verdict (202 for every well-formed batch, C-39). The raw IP address and User-Agent are used in memory
// for the surrogate, the multiplicity keys, the country, the network class and the bot check, then discarded; they
// are never logged, spooled or forwarded.
package ingest

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/bytemaster333/usagemap/services/gateway/internal/challenge"
	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/geo"
	"github.com/bytemaster333/usagemap/services/gateway/internal/guard"
	"github.com/bytemaster333/usagemap/services/gateway/internal/keys"
	"github.com/bytemaster333/usagemap/services/gateway/internal/limits"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/multiplicity"
	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/internal/transport"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uabot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uaclass"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uuid"
)

// MaxBody is the body limit of §a.1 (checked on bytes received).
const MaxBody = 8 << 10

// Spooler is the part of the spool the handler needs.
type Spooler interface {
	Append(ctx context.Context, recs []spool.Record) error
}

// Server holds the ingest dependencies.
type Server struct {
	Snap      *snapshot.Store
	Ring      *keys.Ring
	LiveNodes func() int
	Geo       geo.Resolver
	Net       *netclass.Classifier
	Mult      *multiplicity.Store
	Spool     Spooler
	Counters  *counters.Agg
	Metrics   *metrics.Registry
	Log       *slog.Logger
	Now       func() time.Time
	// Draining makes every ingest request answer 503 (shutdown, §a.5).
	Draining func() bool

	siteRate   *limits.Window
	subnetRate *limits.Window
	unauthRate *limits.Window // per-site budget of batches without a verifiable token
	devRate    *limits.Window // dev events per site and minute (§a.8)
	quota      *limits.Quota
	eventIDs   *limits.TTLSet
	nonces     *limits.TTLSet
	devNonces  *limits.TTLSet // per-nonce counter of dev batches (never production state)
	history    *limits.RateHistory
	difficulty *limits.Difficulty
	limited    *siteMarks
}

// Init allocates the node-local state.
func (s *Server) Init() {
	s.siteRate = limits.NewWindow()
	s.subnetRate = limits.NewWindow()
	s.unauthRate = limits.NewWindow()
	s.devRate = limits.NewWindow()
	s.quota = limits.NewQuota()
	s.eventIDs = limits.NewTTLSet(10*time.Minute, 2_000_000)
	s.nonces = limits.NewTTLSet(35*time.Minute, 1_000_000)
	s.devNonces = limits.NewTTLSet(35*time.Minute, 100_000)
	s.history = limits.NewRateHistory()
	s.difficulty = limits.NewDifficulty()
	s.limited = &siteMarks{m: map[string]map[string]time.Time{}}
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.LiveNodes == nil {
		s.LiveNodes = func() int { return 1 }
	}
	if s.Draining == nil {
		s.Draining = func() bool { return false }
	}
}

func (s *Server) count(site *snapshot.Site, at time.Time, counter, label string, n int) {
	s.Counters.Add(site.TenantID, site.SiteID, at, counter, label, int64(n))
	if counter == "drop" {
		s.Metrics.Add("scf_gateway_drops_total", float64(n), "label", label)
		if label == "rate_limited" || label == "quota_exceeded" {
			s.limited.mark(label, site.SiteID, at)
		}
	}
}

// LimitedWindow is the look-back of SitesLimited.
const LimitedWindow = time.Hour

// siteMarks remembers, per limit kind, the sites answered 429 in the last hour (memory only; site ids never leave
// the process — the gauge carries counts only).
type siteMarks struct {
	mu sync.Mutex
	m  map[string]map[string]time.Time
}

func (sm *siteMarks) mark(kind, site string, at time.Time) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	if sm.m[kind] == nil {
		sm.m[kind] = map[string]time.Time{}
	}
	sm.m[kind][site] = at
}

// SitesLimited returns, for `rate_limited` and `quota_exceeded`, the number of sites this node answered 429 within
// the last hour (gauge scf_gateway_sites_limited{kind}).
func (s *Server) SitesLimited(now time.Time) map[string]int {
	sm := s.limited
	sm.mu.Lock()
	defer sm.mu.Unlock()
	out := map[string]int{"rate_limited": 0, "quota_exceeded": 0}
	for kind, sites := range sm.m {
		for id, at := range sites {
			if now.Sub(at) > LimitedWindow {
				delete(sites, id)
				continue
			}
			out[kind]++
		}
	}
	return out
}

// writeJSON writes a status with a small JSON body.
func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func retryAfter(w http.ResponseWriter, secs int) {
	w.Header().Set("Retry-After", strconv.Itoa(secs))
}

// exposeHeaders lists the response headers a CORS response lets the tracker read: Retry-After on 429/503 (C-100) and
// X-Scf-Debug (§a.8). Only when the response carries CORS headers.
func exposeHeaders(w http.ResponseWriter) {
	h := w.Header()
	if h.Get("Access-Control-Allow-Origin") == "" {
		return
	}
	var ex []string
	if h.Get("Retry-After") != "" {
		ex = append(ex, "Retry-After")
	}
	if h.Get(DebugHeader) != "" {
		ex = append(ex, DebugHeader)
	}
	if len(ex) > 0 {
		h.Set("Access-Control-Expose-Headers", strings.Join(ex, ", "))
	}
}

// originHost returns the page host from Origin (fallback Referer), lower-case, without port; "" when absent.
func originHost(r *http.Request) (host string, fromOrigin bool) {
	if o := r.Header.Get("Origin"); o != "" && o != "null" {
		if u, err := url.Parse(o); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname()), true
		}
	}
	if ref := r.Header.Get("Referer"); ref != "" {
		if u, err := url.Parse(ref); err == nil && u.Hostname() != "" {
			return strings.ToLower(u.Hostname()), false
		}
	}
	return "", false
}

// requestOrigin is the request's Origin (fallback: Referer), parsed; ok = false when neither carries a host.
func requestOrigin(r *http.Request) (snapshot.Origin, bool) {
	if o, ok := snapshot.ParseOrigin(r.Header.Get("Origin")); ok {
		return o, true
	}
	return snapshot.ParseOrigin(r.Header.Get("Referer"))
}

// cors sets the CORS headers when the Origin's host is a declared domain of the site (verified or not, §a.1), when
// the request is a dev request of the site, or while the site's debug mode is on (any origin, §a.8).
func cors(w http.ResponseWriter, r *http.Request, site *snapshot.Site, dev, debug bool) {
	o := r.Header.Get("Origin")
	if o == "" || site == nil {
		return
	}
	po, ok := snapshot.ParseOrigin(o)
	if !ok {
		return
	}
	if !debug && !dev && site.DomainMatch(po.Host) == nil {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", o)
	w.Header().Add("Vary", "Origin")
}

// classify resolves the dev class and debug mode of a request for a site (§a.8). A dev request needs an Origin
// (fallback Referer) matching one of the site's dev origins whose host is not a declared domain of the site.
func classify(r *http.Request, site *snapshot.Site, now time.Time) (dev, debug bool) {
	if o, ok := requestOrigin(r); ok {
		dev = site.IsDev(o)
	}
	return dev, site.DebugOn(now)
}

func clientAddr(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, int) {
	if r.Header.Get("Content-Encoding") != "" {
		return nil, http.StatusBadRequest
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if ct != "text/plain" && ct != "application/json" {
		return nil, http.StatusBadRequest
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, MaxBody+1))
	if err != nil {
		return nil, http.StatusBadRequest
	}
	if len(b) > MaxBody {
		return nil, http.StatusRequestEntityTooLarge
	}
	return b, 0
}

// Challenge handles POST /v1/c.
func (s *Server) Challenge(w http.ResponseWriter, r *http.Request) {
	now := s.Now()
	body, bad := readBody(w, r)
	if bad == http.StatusRequestEntityTooLarge {
		s.status(w, "challenge", http.StatusBadRequest, `{"error":"too_large"}`)
		return
	}
	if bad != 0 {
		s.status(w, "challenge", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	req, err := ParseChallenge(body)
	if err != nil {
		s.status(w, "challenge", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	view := s.Snap.Current()
	if view == nil || s.Draining() {
		corsAny(w, r)
		retryAfter(w, 10)
		s.status(w, "challenge", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	if view.Expired(now) {
		// Hard expiry (§e.4, F12): no new ingest on an expired snapshot; polling, the spool and health go on.
		corsAny(w, r)
		retryAfter(w, 30)
		s.status(w, "challenge", http.StatusServiceUnavailable, `{"error":"snapshot_expired"}`)
		return
	}
	site := view.SiteByKey(req.S)
	if site == nil {
		corsAny(w, r)
		s.status(w, "challenge", http.StatusNotFound, `{"error":"unknown_site"}`)
		return
	}
	dev, debug := classify(r, site, now)
	cors(w, r, site, dev, debug)
	switch {
	case debug:
		// §a.8: class=challenge; reasons=none, origin_mismatch (the token's events will be rejected) or dev_origin.
		why := []string{}
		if o, ok := requestOrigin(r); dev {
			why = append(why, "dev_origin")
		} else if ok && site.DomainMatch(o.Host) == nil {
			why = append(why, "origin_mismatch")
		}
		setDebug(w, classChallenge, why)
	case dev:
		devHeader(w, false)
	}
	if view.Withdrawn(req.TV) {
		s.status(w, "challenge", http.StatusGone, `{"error":"withdrawn"}`)
		return
	}
	addr, ok := clientAddr(r)
	if !ok {
		s.status(w, "challenge", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	netb := challenge.Net(addr)
	// §a.6 step 2 on /v1/c: the per-subnet limit (dev requests too, uncounted, C-137), then this node's share of the
	// site limit (production requests), each in its own challenge budget.
	siteShare := limits.Share(site.RateLimitPerMin, s.LiveNodes())
	limited := func(retry int) {
		if !dev {
			s.count(site, now, "drop", "rate_limited", 1)
		}
		if debug && !dev {
			setDebug(w, classDropped, []string{"rate_limited"})
		}
		retryAfter(w, retry)
		s.status(w, "challenge", http.StatusTooManyRequests, `{"error":"rate_limited"}`)
	}
	if ok, retry := s.subnetRate.Allow("c|"+site.SiteID+"|"+string(netb), subnetLimit(view.Settings.WebRequestsPerMinSubnet, siteShare), now); !ok {
		limited(retry)
		return
	}
	if !dev {
		if ok, retry := s.siteRate.Allow("c|"+site.SiteID, siteShare, now); !ok {
			limited(retry)
			return
		}
	}
	ua := uaclass.Parse(r.UserAgent())
	class := s.Net.Class(addr)
	key := s.Ring.Copy(keys.Chal, keys.ChalID(now))
	if key == nil {
		retryAfter(w, 5)
		s.status(w, "challenge", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	defer clear(key)
	mult := s.difficulty.Multiplier(site.SiteID+"|"+string(netb), now)
	if netclass.LowersThresholds(class) && mult < 2 {
		mult = 2
	}
	maxMult := view.Settings.PowMaxMultiplier
	if maxMult < 1 || maxMult > 8 {
		maxMult = 8
	}
	if mult > maxMult {
		mult = maxMult
	}
	powMax := view.Settings.PowMax * mult
	if powMax > 65535 {
		powMax = 65535
	}
	cost := view.Settings.PowCost
	if cost < 256 {
		cost = 256 // never below 256 (S-07)
	}
	is, err := challenge.Issue(challenge.IssueParams{Key: key, Now: now, SiteKey: site.SiteKey, Net: netb, UAClass: ua.String(),
		Cost: cost, Max: powMax, Strict: site.Profile == "strict", Dev: dev})
	if err != nil {
		retryAfter(w, 5)
		s.status(w, "challenge", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	resp, _ := json.Marshal(map[string]any{"v": 1, "t": is.Token, "pow": map[string]any{"alg": "pbkdf2-sha256", "cost": is.Cost, "max": is.Max, "pfx": is.Pfx}, "ttl": is.TTL})
	s.status(w, "challenge", http.StatusOK, string(resp))
}

func (s *Server) status(w http.ResponseWriter, route string, code int, body string) {
	exposeHeaders(w)
	s.Metrics.Add("scf_gateway_requests_total", 1, "route", route, "status", strconv.Itoa(code))
	if code == http.StatusAccepted {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		return
	}
	writeJSON(w, code, body)
}

// Surrogate computes the identified surrogate: 2001:db8: + 96 bits of HMAC-SHA-256(K_day, site_id ‖ ip ‖ ua)
// (ADR-0007, C-34) — from the full address and the raw User-Agent.
func Surrogate(kday []byte, siteID [16]byte, ip netip.Addr, ua string) netip.Addr {
	m := hmac.New(sha256.New, kday)
	m.Write(siteID[:])
	m.Write(ip.AsSlice())
	m.Write([]byte(ua))
	sum := m.Sum(nil)
	var b [16]byte
	b[0], b[1], b[2], b[3] = 0x20, 0x01, 0x0d, 0xb8
	copy(b[4:], sum[:12])
	return netip.AddrFrom16(b)
}

// EventSurrogate is the surrogate of an unidentified event (C-02, C-73): 2001:db8: + 96 bits of
// SHA-256("scf-unid1" ‖ site_id ‖ event id). The event id is 128 random bits drawn by the browser for this one event
// and never stored, so the surrogate is as unlinkable as a random one — but a retry of the same event on another node
// gets the same surrogate, and therefore the same core (§c.1), where its event key de-duplicates it.
func EventSurrogate(siteID [16]byte, eventID string) netip.Addr {
	h := sha256.New()
	h.Write([]byte("scf-unid1"))
	h.Write(siteID[:])
	h.Write([]byte(eventID))
	var b [16]byte
	b[0], b[1], b[2], b[3] = 0x20, 0x01, 0x0d, 0xb8
	copy(b[4:], h.Sum(nil)[:12])
	return netip.AddrFrom16(b)
}

// EventKey is the de-duplication key of an event (§c.2 x-scf-event-key, §d.2 event_key): the first 16 bytes of
// SHA-256("scf-evk1" ‖ site_id ‖ event id), hex. The tracker reuses an event's id on every retry and on either
// ingest host, so all copies of one action carry one key, and the engine proxy forwards only the first (C1 #11).
// It identifies an event, never a person: the id is random per event and lives only in the page's memory.
func EventKey(siteID [16]byte, eventID string) string {
	h := sha256.New()
	h.Write([]byte("scf-evk1"))
	h.Write(siteID[:])
	h.Write([]byte(eventID))
	return hex.EncodeToString(h.Sum(nil)[:16])
}

var screens = map[string]string{"s": "390x844", "m": "820x1180", "l": "1536x864", "x": "2560x1440"}

func powLatency(d time.Duration) string {
	switch {
	case d < 100*time.Millisecond:
		return "lt100ms"
	case d < 300*time.Millisecond:
		return "100_300ms"
	case d < time.Second:
		return "300ms_1s"
	case d < 3*time.Second:
		return "1_3s"
	case d < 10*time.Second:
		return "3_10s"
	default:
		return "gt10s"
	}
}

// headerFacts checks header combinations (§h.2 fetch_impossible, header_inconsistent).
func headerFacts(r *http.Request, ua uaclass.Class) (impossible, inconsistent bool) {
	mode := strings.ToLower(r.Header.Get("Sec-Fetch-Mode"))
	site := strings.ToLower(r.Header.Get("Sec-Fetch-Site"))
	dest := strings.ToLower(r.Header.Get("Sec-Fetch-Dest"))
	if mode == "navigate" || mode == "nested-navigate" || site == "none" || dest == "document" || dest == "iframe" || dest == "frame" {
		impossible = true
	}
	if sendsFetchMeta(ua) && (mode == "" || site == "") {
		inconsistent = true
	}
	if ua.Family != "other" && r.Header.Get("Accept-Language") == "" {
		inconsistent = true
	}
	if r.UserAgent() == "" {
		inconsistent = true
	}
	return
}

// sendsFetchMeta: the UA claims a browser that sends Sec-Fetch-* (and Origin on every cross-origin fetch POST).
func sendsFetchMeta(ua uaclass.Class) bool {
	return ua.Family == "chrome" && ua.Major >= 80 || ua.Family == "edge" && ua.Major >= 80 ||
		ua.Family == "opera" && ua.Major >= 67 || ua.Family == "samsung" && ua.Major >= 13 ||
		ua.Family == "firefox" && ua.Major >= 90 || ua.Family == "safari" && ua.Major >= 17
}

type verdict struct {
	reject  []string
	suspect []string
}

func (v *verdict) add(reject bool, code string) {
	if reject {
		v.reject = append(v.reject, code)
	} else {
		v.suspect = append(v.suspect, code)
	}
}

func (v *verdict) label() string {
	switch {
	case len(v.reject) > 0:
		return "rejected"
	case len(v.suspect) > 0:
		return "suspect"
	default:
		return "verified"
	}
}

// Events handles POST /v1/e.
//
// Response discipline (C-39): for a given site, origin and state, every well-formed
// non-dev batch gets the same answer whatever its verdict — the same status, body and headers, and (through the
// spool's commit barrier) a comparable delay. Quota exhaustion, rate limits and spool failures are decided without
// looking at the verdict.
func (s *Server) Events(w http.ResponseWriter, r *http.Request) {
	now := s.Now()
	// 1. parse and size-check; resolve the site.
	body, bad := readBody(w, r)
	if bad == http.StatusRequestEntityTooLarge {
		s.status(w, "events", http.StatusBadRequest, `{"error":"too_large"}`)
		return
	}
	if bad != 0 {
		s.status(w, "events", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	b, err := ParseBatch(body)
	if err != nil {
		s.status(w, "events", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	view := s.Snap.Current()
	if view == nil || s.Draining() {
		corsAny(w, r)
		retryAfter(w, 10)
		s.status(w, "events", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	if view.Expired(now) {
		// Hard expiry (§e.4, F12): no new ingest on an expired snapshot; polling, the spool and health go on.
		corsAny(w, r)
		retryAfter(w, 30)
		s.status(w, "events", http.StatusServiceUnavailable, `{"error":"snapshot_expired"}`)
		return
	}
	site := view.SiteByKey(b.S)
	if site == nil {
		corsAny(w, r)
		s.status(w, "events", http.StatusNotFound, `{"error":"unknown_site"}`)
		return
	}
	dev, debug := classify(r, site, now)
	cors(w, r, site, dev, debug)
	if dev {
		devHeader(w, false) // refined below in debug mode
	}
	if view.Withdrawn(b.TV) {
		s.status(w, "events", http.StatusGone, `{"error":"withdrawn"}`)
		return
	}
	if dev {
		s.devEvents(w, r, b, view, site, debug, now)
		return
	}
	n := len(b.E)
	dropped := func(label string) {
		if debug {
			setDebug(w, classDropped, []string{label})
		}
	}
	// Quota: the site is over its plan quota (snapshot), or this node's share of the tenant's daily verified-event
	// quota is used up. Both are decided before any verdict, so every batch of the tenant gets the same 429 (no
	// verdict oracle). A batch that starts below the share is accepted whole (overshoot ≤ 10 events).
	if site.Status == "over_quota" || s.quota.Over(site.TenantID, 1, limits.Share(site.DailyQuota, s.LiveNodes()), now) {
		s.count(site, now, "drop", "quota_exceeded", n)
		dropped("quota_exceeded")
		retryAfter(w, limits.SecondsToMidnight(now))
		s.status(w, "events", http.StatusTooManyRequests, `{"error":"quota_exceeded"}`)
		return
	}
	addr, ok := clientAddr(r)
	if !ok {
		s.status(w, "events", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	// 2. rate limits. The per-(site, subnet) limit first, so a refused subnet never spends the site's budget; the
	// subnet limit is also capped to a fraction of the node's site share, so one subnet cannot use the whole share.
	netb := challenge.Net(addr)
	siteShare := limits.Share(site.RateLimitPerMin, s.LiveNodes())
	if ok, retry := s.subnetRate.Allow(site.SiteID+"|"+string(netb), subnetLimit(view.Settings.WebRequestsPerMinSubnet, siteShare), now); !ok {
		s.count(site, now, "drop", "rate_limited", n)
		dropped("rate_limited")
		retryAfter(w, retry)
		s.status(w, "events", http.StatusTooManyRequests, `{"error":"rate_limited"}`)
		return
	}
	// The challenge token decides which per-site budget the request uses: a batch without a token this node can
	// verify (missing, forged, expired, unverifiable) can only ever be rejected or suspect-unverifiable, so it is
	// charged to a separate budget of the same size, and refused silently (202 after the commit barrier, counted
	// drop/rate_limited) when that budget is spent. An unauthenticated flood therefore never takes a site's genuine
	// visitors offline and learns nothing from the answer.
	co := s.verifyToken(b, site, netb, r.UserAgent(), now, false)
	if authenticated(co) {
		if ok, retry := s.siteRate.Allow(site.SiteID, siteShare, now); !ok {
			s.count(site, now, "drop", "rate_limited", n)
			dropped("rate_limited")
			retryAfter(w, retry)
			s.status(w, "events", http.StatusTooManyRequests, `{"error":"rate_limited"}`)
			return
		}
	} else if ok, _ := s.unauthRate.Allow(site.SiteID, siteShare, now); !ok {
		s.count(site, now, "drop", "rate_limited", n)
		dropped("rate_limited")
		if s.accept(w, r, nil) {
			s.status(w, "events", http.StatusAccepted, "")
		}
		return
	}
	if gpcOrDNT(r) {
		s.count(site, now, "drop", "gpc_dnt", n)
		dropped("gpc_dnt")
		s.status(w, "events", http.StatusAccepted, "")
		return
	}
	res, err := s.process(r, b, view, site, addr, netb, co, now, false, debug)
	if err != nil {
		retryAfter(w, 5)
		s.status(w, "events", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	if !s.accept(w, r, res.recs) {
		return
	}
	// Only now (fsync'd): remember the event ids, count the quota, commit the counters and property rows.
	for _, e := range b.E {
		s.eventIDs.Add(site.SiteID+"|"+e.ID, now)
	}
	s.quota.Add(site.TenantID, res.verified, now)
	for k, n := range res.tally {
		s.count(site, now, k.counter, k.label, n)
		switch k.counter {
		case "verdict":
			s.Metrics.Add("scf_gateway_events_total", float64(n), "verdict", k.label)
		case "reason":
			s.Metrics.Add("scf_gateway_reasons_total", float64(n), "reason", k.label)
		}
	}
	for k, n := range res.props {
		s.Counters.AddProp(counters.PropKey{Tenant: site.TenantID, Site: site.SiteID, Event: k.event, Network: k.network,
			Key: k.key, Value: k.value, Verdict: k.verdict}, now, int64(n))
	}
	// Browser RPC aggregate cells (§a.3.2, §d.3 `rpc`).
	for k, n := range res.rpc {
		s.Counters.AddRPC(counters.RPCKey{Tenant: site.TenantID, Site: site.SiteID, API: k.api, Operation: k.operation,
			Network: k.network, Outcome: k.outcome, Latency: k.latency, Verdict: k.verdict}, now, n)
	}
	if debug && res.worst.class != "" {
		setDebug(w, res.worst.class, res.worst.reasons)
	}
	s.status(w, "events", http.StatusAccepted, "")
}

// accept passes the batch's records (possibly none) through the spool's group commit. With no records it is a
// commit barrier with a comparable delay, so an all-rejected or all-dropped batch is answered like an accepted one:
// 202 after the commit, or 503 when the spool is not durable — whatever the verdict. It writes
// the 503 itself and reports false; on success it writes nothing (202 is the caller's).
func (s *Server) accept(w http.ResponseWriter, r *http.Request, recs []spool.Record) bool {
	if err := s.Spool.Append(r.Context(), recs); err != nil {
		if len(recs) > 0 {
			s.Metrics.Add("scf_gateway_spool_append_errors_total", 1)
		}
		retryAfter(w, 5)
		s.status(w, "events", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return false
	}
	return true
}

// subnetLimit is the effective per-(site, subnet) request limit on this node: the setting, but at most a quarter
// of the node's share of the site limit (at least 10/min), so a single subnet cannot spend the whole site budget.
func subnetLimit(setting, siteShare int) int {
	limit := setting
	if limit < 1 {
		limit = 600
	}
	if c := max(siteShare/4, 10); limit > c {
		limit = c
	}
	return limit
}

// corsAny sets CORS headers for an answer given before (or without) a resolved site — 404 unknown_site and early
// 503s — so the tracker can read the status and Retry-After. These answers carry no tenant data.
func corsAny(w http.ResponseWriter, r *http.Request) {
	o := r.Header.Get("Origin")
	if o == "" {
		return
	}
	if _, ok := snapshot.ParseOrigin(o); !ok {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", o)
	w.Header().Add("Vary", "Origin")
}

func gpcOrDNT(r *http.Request) bool {
	return r.Header.Get("Sec-GPC") == "1" || r.Header.Get("DNT") == "1"
}

// devEvents answers a dev batch (§a.6 step 1, §a.8, C-137): the per-subnet request limit applies (uncounted), then the
// dev limit per site; each event's would-be verdict is computed in memory and the event is reported in the next
// counter record's `dev` array. Nothing is spooled, forwarded to Umami or counted, and no per-site rate, quota,
// multiplicity, rate-history, difficulty or event-id state is touched. The answer is 202 (C-39).
func (s *Server) devEvents(w http.ResponseWriter, r *http.Request, b Batch, view *snapshot.View, site *snapshot.Site, debug bool, now time.Time) {
	addr, ok := clientAddr(r)
	if !ok {
		s.status(w, "events", http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	netb := challenge.Net(addr)
	siteShare := limits.Share(site.RateLimitPerMin, s.LiveNodes())
	if ok, retry := s.subnetRate.Allow(site.SiteID+"|"+string(netb), subnetLimit(view.Settings.WebRequestsPerMinSubnet, siteShare), now); !ok {
		retryAfter(w, retry)
		s.status(w, "events", http.StatusTooManyRequests, `{"error":"rate_limited"}`)
		return
	}
	if gpcOrDNT(r) {
		if debug {
			setDebug(w, classDev, []string{"dev_origin", "gpc_dnt"})
		}
		s.status(w, "events", http.StatusAccepted, "")
		return
	}
	if ok, _ := s.devRate.AllowN(site.SiteID, len(b.E), view.Settings.DevEventsPerMin(), now); !ok {
		devHeader(w, true) // dropped silently
		s.status(w, "events", http.StatusAccepted, "")
		return
	}
	co := s.verifyToken(b, site, netb, r.UserAgent(), now, true)
	res, err := s.process(r, b, view, site, addr, netb, co, now, true, debug)
	if err != nil {
		retryAfter(w, 5)
		s.status(w, "events", http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	for _, d := range res.dev {
		s.Counters.AddDev(d)
	}
	if debug && res.worst.class != "" {
		setDebug(w, classDev, append([]string{"dev_origin"}, res.worst.reasons...))
	}
	s.status(w, "events", http.StatusAccepted, "")
}

// verifyToken checks the batch's challenge token and proof (§b.3); a dev-issued token is valid on dev batches only
// (C-137). It is stateless; the per-nonce counter is applied in process.
func (s *Server) verifyToken(b Batch, site *snapshot.Site, netb []byte, rawUA string, now time.Time, dev bool) challenge.Outcome {
	if !b.TokenValid {
		return challenge.Outcome{Reject: "challenge_missing"}
	}
	return challenge.Verify(challenge.VerifyParams{Token: b.T, Counter: b.C, SiteKey: site.SiteKey, Net: netb, UAClass: uaclass.Parse(rawUA).String(), Now: now,
		Keys:     func(e uint32) []byte { return s.Ring.Copy(keys.Chal, strconv.FormatUint(uint64(e), 10)) },
		KeySince: func(e uint32) time.Time { return s.Ring.GeneratedAt(keys.Chal, strconv.FormatUint(uint64(e), 10)) },
		DevBatch: dev})
}

// authenticated: the token was issued by our gateways for this site and is within its lifetime (its proof may still
// be missing). Only such batches can produce a verified event, and only they spend the per-site request budget.
func authenticated(co challenge.Outcome) bool { return co.Reject == "" && !co.Unverifiable }

func whyLabel(w string) string {
	if w == "" {
		return "none"
	}
	return w
}

// cnt is one counter cell of a batch; the batch's counters are committed only when it is accepted (202), so a
// 429/503 answer followed by the tracker's retry never counts twice.
type cnt struct{ counter, label string }

// propCell is one property cell of a batch (§d.3 `props`), committed like cnt.
type propCell struct{ event, network, key, value, verdict string }

// rpcCell is one cell of the browser RPC aggregate (§a.3.2, §d.3 `rpc`), committed like cnt.
type rpcCell struct{ api, operation, network, outcome, latency, verdict string }

// processed is the outcome of steps 3–7 for a batch.
type processed struct {
	rpc      map[rpcCell]int64
	recs     []spool.Record
	verified int // verified events that count towards the quota
	tally    map[cnt]int
	props    map[propCell]int
	dev      []spool.DevEvent // dev batches only
	worst    worst            // for X-Scf-Debug
}

// process runs steps 3–7 of §a.6 for every event and returns the spool records, the number of verified events, the
// counter and property cells. With dev set (a dev batch, §a.8) it computes each event's would-be verdict in memory
// only — without origin_mismatch and domain_unverified, without touching rate-history, difficulty, nonce,
// multiplicity or event-id state — and returns `dev` entries instead of records and counters.
func (s *Server) process(r *http.Request, b Batch, view *snapshot.View, site *snapshot.Site, addr netip.Addr, netb []byte, co challenge.Outcome, now time.Time, dev, debug bool) (processed, error) {
	out := processed{tally: map[cnt]int{}, props: map[propCell]int{}, rpc: map[rpcCell]int64{}}
	add := func(counter, label string) {
		if !dev {
			out.tally[cnt{counter, label}]++
		}
	}
	metric := func(name string, labels ...string) {
		if !dev {
			s.Metrics.Add(name, 1, labels...)
		}
	}
	standard := site.Profile == "standard"
	rawUA := r.UserAgent()
	// 3. surrogate from the full IP and raw UA; truncation; country; network class; UA reduction; bot list.
	siteID, err := uuid.Parse(site.SiteID)
	if err != nil {
		return out, err
	}
	kday := s.Ring.Copy(keys.Day, keys.DayID(now))
	kmult := s.Ring.Copy(keys.Mult, keys.DayID(now))
	if kday == nil || kmult == nil {
		return out, errors.New("keys not ready")
	}
	defer clear(kday)
	defer clear(kmult)
	identSurrogate := Surrogate(kday, siteID, addr, rawUA)
	country := s.Geo.Country(addr)
	class := s.Net.Class(addr)
	ua := uaclass.Parse(rawUA)
	synthetic := uaclass.Synthetic(ua)
	isBot := uabot.IsBot(rawUA)
	headless := uabot.HasHeadlessMarker(rawUA)
	keyIP := multiplicity.KeyIP(kmult, siteID, addr.AsSlice())
	keyNet := multiplicity.KeyNet(kmult, siteID, netb)
	impossible, inconsistent := headerFacts(r, ua)
	// Transport fingerprint (C-124): the connection's TLS ClientHello / HTTP/2 preface against the UA's engine.
	tv := transport.Check(ua.Family, ua.OS, transport.FromContext(r.Context()).Snapshot())
	metric("scf_gateway_transport_checks_total", "claimed", tv.Claimed, "observed", tv.Observed, "result", tv.Result, "why", whyLabel(tv.Why))
	// From here on the raw address and User-Agent are not used.

	// Stellar events after legacy mapping and placement (§a.3.1); counted-only events produce property rows only.
	stellar := make([]*Stellar, len(b.E))
	anyCounted := false // at least one event that is not counted-only: batch-level counters apply
	for i, e := range b.E {
		if e.IsRPCAggregate() {
			continue // §a.3.2: counts only, like a counted-only event
		}
		if e.K == "wl" {
			st := ToStellar(e)
			stellar[i] = &st
			if st.CountedOnly() {
				continue
			}
		}
		anyCounted = true
	}
	batchAdd := add
	if !anyCounted {
		batchAdd = func(string, string) {}
	}

	// Batch-level reasons. The bot-detection signals (bot list, header facts, transport fingerprint, network class,
	// automation flags, context binding) are not applied to a dev batch outside debug mode: the first-event panel
	// would otherwise be a permanent, unaudited verdict oracle for a client that claims a dev origin (§a.8, audit
	// ingest #7). Outside debug mode a dev entry's would-be verdict reflects configuration and protocol checks only.
	detect := !dev || debug
	var base verdict
	tenant := view.Tenant(site.TenantID)
	switch {
	case tenant == nil || tenant.Status == "pending":
		base.add(true, "tenant_pending")
	case tenant.Status == "suspended":
		base.add(true, "tenant_suspended")
	}
	if isBot && detect {
		base.add(true, "ua_bot")
	}
	host, fromOrigin := originHost(r)
	if host != "" && !fromOrigin && !inconsistent && sendsFetchMeta(ua) {
		// A browser that sends fetch metadata always sends Origin on a cross-origin fetch POST; a Referer without an
		// Origin is a non-browser marker. The Referer still names the page host.
		inconsistent = true
	}
	var hostname string
	switch {
	case dev:
		// A dev request's origin is not a declared domain by definition: no origin_mismatch / domain_unverified.
	case host == "":
		base.add(false, "origin_missing")
		if len(site.Domains) > 0 {
			hostname = site.Domains[0].Host
		}
	default:
		if d := site.DomainMatch(host); d == nil {
			base.add(true, "origin_mismatch")
		} else {
			hostname = host
			if !d.Verified {
				base.add(false, "domain_unverified")
			}
		}
	}
	if impossible && detect {
		base.add(true, "fetch_impossible")
	}
	if inconsistent && detect {
		base.add(false, "header_inconsistent")
	}
	if class == "datacenter" && detect {
		base.add(false, "net_datacenter")
	}
	if tv.Result == transport.Mismatch && detect {
		base.add(false, "transport_mismatch") // never a rejection on its own (C-124)
	}
	sigWD := standard && b.SG.WD != nil && *b.SG.WD == 1
	if standard && (sigWD || headless) && detect {
		base.add(false, "automation_flag")
	}
	diffKey := site.SiteID + "|" + string(netb)
	maxMult := view.Settings.PowMaxMultiplier
	// Challenge token and proof (§b.3), verified by the caller.
	if co.Reject != "" {
		base.add(true, co.Reject)
	}
	if co.Unverifiable {
		base.add(false, "challenge_unverifiable")
	}
	if co.CtxMoved && detect {
		base.add(false, "ctx_moved")
	}
	if co.ProofMissing {
		base.add(false, "proof_missing")
	}
	// rate_anomaly (§h.2): the site's rate history counts only events that can still be verified — no batch-level
	// rejection and a solved proof — so junk a competitor posts (no token, bot UA, wrong origin, no proof) can never
	// push a site into an anomaly that marks its genuine visitors suspect. A site already in an
	// anomaly still flags every event.
	if !dev {
		k := 0
		if len(base.reject) == 0 && co.ProofOK {
			k = len(b.E)
		}
		if s.history.Add(site.SiteID, k, now) {
			base.add(false, "rate_anomaly")
			s.difficulty.Trigger(diffKey, maxMult, now)
		}
	}
	// Per-nonce event counter (page-load unit and token_flood). Dev batches use their own memory-only counter, so a
	// dev request never changes production token state.
	before := 1 // no usable nonce: never a first load
	perToken := view.Settings.WebEventsPerToken
	if perToken < 1 {
		perToken = 300
	}
	if co.Token != nil {
		nonces := s.nonces
		if dev {
			nonces = s.devNonces
		}
		before, _ = nonces.Incr(site.SiteID+"|"+string(co.Token.Nonce[:]), len(b.E), now)
		if before == 0 && co.ProofOK {
			batchAdd("pow_latency", powLatency(now.Sub(time.UnixMilli(co.Token.IssuedMs))))
		} else if before == 0 {
			batchAdd("pow_latency", "none")
		}
	}
	// Client signals counter (standard sites with signals; otherwise not collected).
	if standard && b.SG.Present {
		if sigWD {
			batchAdd("client_signal", "webdriver")
		}
		switch b.SG.Vis {
		case "h":
			batchAdd("client_signal", "hidden")
		case "p":
			batchAdd("client_signal", "prerender")
		}
		if b.SG.Act != nil && *b.SG.Act == 0 {
			batchAdd("client_signal", "no_activation")
		}
	} else {
		batchAdd("client_signal", "not_collected")
	}
	if !standard && b.SG.Present {
		batchAdd("drop", "profile_field_stripped")
	}

	inBatch := make(map[string]bool, len(b.E))
	for i, e := range b.E {
		st := stellar[i]
		counted := st == nil || !st.CountedOnly()
		evAdd := add
		if !counted {
			evAdd = func(string, string) {} // counted-only: property rows only (C-137)
		}
		v := verdict{reject: append([]string(nil), base.reject...), suspect: append([]string(nil), base.suspect...)}
		if before+i+1 > perToken && co.Token != nil {
			v.add(true, "token_flood")
			if !dev && before+i == perToken {
				s.difficulty.Trigger(diffKey, maxMult, now)
			}
		}
		if standard && e.K == "pv" && (b.SG.Vis == "h" || b.SG.Vis == "p") {
			v.add(false, "hidden_or_prerender")
		}
		if e.IsRPCAggregate() {
			// §a.3.2: per-site daily totals only — no spool record, no web counter, no quota, no multiplicity, no
			// surrogate; never shown in the dev panel. Retries are still recognised by the event id.
			if dev || inBatch[e.ID] || s.eventIDs.Seen(site.SiteID+"|"+e.ID, now) || view.Excluded(site, country) {
				inBatch[e.ID] = true
				continue
			}
			inBatch[e.ID] = true
			label := v.label()
			if label == "rejected" {
				out.worst.see(label, append(append([]string(nil), v.reject...), v.suspect...))
				continue
			}
			for _, c := range e.RPC {
				out.rpc[rpcCell{c.API, c.Operation, c.Network, c.Outcome, c.Latency, label}] += c.Count
			}
			continue
		}
		if dev {
			// Steps 4–6 are skipped for dev batches; step 7's verdict is reported, never counted (§a.6 step 1).
			label := v.label()
			reasons := append(append([]string(nil), v.reject...), v.suspect...)
			out.worst.see(label, reasons)
			if d, ok := devEntry(e, st, site, label, reasons, now); ok {
				out.dev = append(out.dev, d)
			}
			continue
		}
		// Duplicates: an id already in this batch or seen on this node in the last 10 minutes.
		// Repeats across nodes are removed before Umami by the event key (§c.5).
		dup := inBatch[e.ID]
		inBatch[e.ID] = true
		if dup || s.eventIDs.Seen(site.SiteID+"|"+e.ID, now) {
			evAdd("drop", "duplicate_event_id")
			out.worst.see(classDropped, []string{"duplicate_event_id"})
			continue
		}
		// 4. country exclusion.
		if view.Excluded(site, country) {
			evAdd("drop", "country_excluded")
			out.worst.see(classDropped, []string{"country_excluded"})
			continue
		}
		// 5. identifier.
		identified := view.Identified(site, country)
		surrogate := identSurrogate
		if !identified {
			// Random per event (the event id is a fresh random value, C-02, C-73), but the same for a retry of the
			// same event on any node, so both copies reach the same core and the duplicate is recognised (C1 #11).
			surrogate = EventSurrogate(siteID, e.ID)
		}
		// 6. multiplicity (page load = first event of the nonce on this node).
		suffix := surrogate.As16()
		load := multiplicity.Load{Surrogate: multiplicity.Digest(suffix[4:]), Identified: identified, Standard: standard,
			ZeroActivation: b.SG.Act != nil && *b.SG.Act == 0, AutoFlag: sigWD || b.SG.Vis == "h" || b.SG.Vis == "p", ProofOK: co.ProofOK}
		th := view.Settings.MultiplicityThresholds
		if !identified {
			th = view.Settings.MultiplicityEventThresholds
		}
		mr := s.Mult.Observe(now, keyIP, keyNet, load, before == 0 && i == 0, class, multiplicity.Thresholds(th))
		evAdd("multiplicity", mr.Bucket)
		if mr.High {
			if mode := view.MultiplicityMode(site); mode == snapshot.ModeShadow {
				// Shadow (C-124): count what would have been suspect, leave the verdict alone.
				evAdd("multiplicity", "high_shadow")
				s.Metrics.Add("scf_gateway_multiplicity_flags_total", 1, "mode", mode)
			} else {
				v.add(false, "multiplicity_high")
				s.Metrics.Add("scf_gateway_multiplicity_flags_total", 1, "mode", mode)
			}
		}
		if mr.SubnetBucket == multiplicity.High {
			s.difficulty.Trigger(diffKey, maxMult, now)
		}
		// 7. verdict.
		label := v.label()
		reasons := append(append([]string(nil), v.reject...), v.suspect...)
		evAdd("verdict", label)
		evAdd("asn_class", class)
		for _, c := range reasons {
			evAdd("reason", c)
		}
		if label == "rejected" {
			out.worst.see(label, reasons)
			continue
		}
		// Stellar property rows of every accepted wallet event, counted-only ones included (§a.3.1, §d.3).
		if st != nil {
			for _, kv := range st.PropRows() {
				out.props[propCell{st.Name, st.Network, kv[0], kv[1], label}]++
			}
		}
		if !counted {
			// Never spooled, never forwarded, not counted towards the quota (C-137).
			out.worst.see(label, reasons)
			continue
		}
		// C-129 (tracker.intentional-upgrade): the tracker version of every event that is not rejected; the installation check reports
		// the version with the most events (data-model §8.9).
		add("tracker_version", trackerVersionLabel(b.TV))
		rec, dropped := s.buildRecord(e, st, site, standard, hostname, now)
		for _, d := range dropped {
			add("drop", d)
		}
		out.worst.see(label, append(reasons, dropped...))
		if rec == nil {
			continue
		}
		if e.WK && standard {
			add("kit_present_pageviews", "all")
		}
		if identified {
			add("identifier", "identified")
			rec.Target = "main"
			id := site.UmamiWebsiteID
			rec.UmamiWebsiteID = &id
		} else {
			add("identifier", "unidentified")
			rec.Target = "twin"
			rec.UmamiWebsiteID = site.UmamiTwinWebsiteID
		}
		rec.Tag = "s"
		if label == "verified" {
			rec.Tag = "v"
			out.verified++
		}
		rec.Surrogate = surrogate.String()
		rec.EventKey = EventKey(siteID, e.ID)
		rec.Country = country
		rec.UA = synthetic
		out.recs = append(out.recs, rec)
	}
	return out, nil
}

// devEntry builds the first-event panel entry of a dev event (§a.8, §d.3 `dev`): kind, canonical name, path with
// `full` folding, receipt time, would-be verdict and its worst reason. Never a visitor identifier, address,
// User-Agent, referrer, country, property value or the origin host. ok = false when the custom name fails the guard.
func devEntry(e Event, st *Stellar, site *snapshot.Site, label string, reasons []string, now time.Time) (spool.DevEvent, bool) {
	d := spool.DevEvent{TenantID: site.TenantID, SiteID: site.SiteID, ReceivedAtMs: now.UnixMilli(), WouldBe: label}
	switch e.K {
	case "pv":
		d.Kind, d.Name = "pageview", "pageview"
	case "ev":
		if guard.Unsafe(e.N) {
			return d, false
		}
		d.Kind, d.Name = "custom", e.N
	case "wl":
		d.Kind, d.Name = "stellar", st.Name
	default:
		return d, false
	}
	path, _ := guard.Path(e.U, "full")
	d.Path = devPath(path)
	if len(reasons) > 0 {
		r := reasons[0] // reject reasons come first: the worst one
		d.Reason = &r
	}
	return d, true
}

// devPath fits a normalised path to the `dev` entry's pattern `^/[^?#\s]*$`, at most 200 characters.
func devPath(p string) string {
	var sb strings.Builder
	n := 0
	for _, c := range p {
		if n == 200 {
			break
		}
		if c == '?' || c == '#' || unicode.IsSpace(c) {
			break
		}
		sb.WriteRune(c)
		n++
	}
	if sb.Len() == 0 || !strings.HasPrefix(sb.String(), "/") {
		return "/"
	}
	return sb.String()
}

// buildRecord applies the site's profile and the guards to one event (§a.4) and returns the spool record without
// verdict fields, plus drop labels to count. nil when the event itself is dropped. A wallet event is recorded under
// its v1 name with its fields under the rollup keys (§a.3.1, §c.2).
func (s *Server) buildRecord(e Event, st *Stellar, site *snapshot.Site, standard bool, hostname string, now time.Time) (*spool.EventRecord, []string) {
	var drops []string
	path, redacted := guard.Path(e.U, site.PathFolding)
	if redacted {
		drops = append(drops, "path_redacted")
	}
	rec := &spool.EventRecord{RecordID: uuid.V7(now).String(), ReceivedAtMs: now.UnixMilli(), TenantID: site.TenantID, SiteID: site.SiteID,
		Hostname: hostname, URL: path}
	switch e.K {
	case "pv":
		rec.Kind = "pageview"
		if !standard {
			if e.R != "" || e.W != "" || e.L != "" || e.WK {
				drops = append(drops, "profile_field_stripped")
			}
			break
		}
		if r := strings.ToLower(e.R); r != "" && r != strings.ToLower(hostname) && site.DomainMatch(r) == nil {
			rec.ReferrerHost = r
		}
		rec.Screen = screens[e.W]
		rec.Language = e.L
	case "ev":
		rec.Kind = "custom"
		if guard.Unsafe(e.N) {
			return nil, append(drops, "prop_redacted")
		}
		rec.Name = e.N
		if len(e.D) > 0 {
			rec.Data = map[string]any{}
			for k, v := range e.D {
				if sv, ok := v.(string); ok && guard.Unsafe(sv) {
					drops = append(drops, "prop_redacted")
					continue
				}
				rec.Data[k] = v
			}
			if len(rec.Data) == 0 {
				rec.Data = nil
			}
		}
	case "wl":
		rec.Kind = "wallet"
		rec.Name = st.Name
		rec.Data = st.UmamiData()
		if st.Stripped {
			drops = append(drops, "profile_field_stripped")
		}
	}
	return rec, drops
}

// trackerVersionLabel turns a payload `tv` (x.y.z, checked by the parser) into the counter label v<x>_<y>_<z>
// (labels allow [a-z0-9_] only, C-129).
func trackerVersionLabel(tv string) string { return "v" + strings.ReplaceAll(tv, ".", "_") }
