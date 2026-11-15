// SPDX-License-Identifier: Apache-2.0

// Package appevents is the mobile / app intake of the edge (wire-formats §a.9): `POST /v1/app-events` takes small
// batches of named events from native apps (React Native, Expo, Flutter, Swift, Kotlin) and Telegram Mini Apps,
// authenticated only by the site's public key, and turns them into daily, self-attested counts in the counter record's
// optional `app` part (§d.3) → `scf.app_event_daily` (migration 0084).
//
// Honesty rule: an app cannot run the browser proof of work or the browser checks, so nothing here is verified. Every
// count is labelled `self_attested`, never enters the web verdict counters, the verified-event quota, Umami, the
// visitor counts, trust scoring or public metrics. Privacy: no device id, advertising id, install id, IP address or
// User-Agent is read into anything stored; the peer address is used in memory for the per-subnet rate limit only (as
// on the web path); the session id lives only as a keyed hash in a 35-minute memory set for the distinct-session
// count. Request headers and bodies are never logged.
package appevents

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/challenge"
	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/limits"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
)

// Path is the route of the app intake.
const Path = "/v1/app-events"

// Per-site, per-UTC-day, per-node budgets: beyond them an event is dropped with reason `cardinality` (§a.9). They keep
// the self-attested table bounded whatever a client sends.
const (
	MaxNamesPerSiteDay = 100
	MaxCellsPerSiteDay = 1000
	// SessionTTL is how long a session id's keyed hash is remembered: the SDKs rotate the id at most every 30 minutes.
	SessionTTL  = 35 * time.Minute
	maxSessions = 1_000_000
	maxPast     = 24 * time.Hour
	maxFuture   = 5 * time.Minute
)

// Door serves the app intake.
type Door struct {
	Snap      *snapshot.Store
	Counters  *counters.Agg
	Metrics   *metrics.Registry
	Now       func() time.Time
	LiveNodes func() int
	Draining  func() bool

	siteRate   *limits.Window
	subnetRate *limits.Window
	quota      *limits.Quota
	sessions   *limits.TTLSet
	sessKey    []byte // random per process: hashes are not comparable across nodes or restarts
	mu         sync.Mutex
	card       map[string]*budget // site|day → names and cells seen
	cardDay    string
}

type budget struct {
	names map[string]bool
	cells map[string]bool
}

// Init allocates the node-local state and declares the metrics.
func (d *Door) Init() {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.LiveNodes == nil {
		d.LiveNodes = func() int { return 1 }
	}
	if d.Draining == nil {
		d.Draining = func() bool { return false }
	}
	d.siteRate, d.subnetRate = limits.NewWindow(), limits.NewWindow()
	d.quota = limits.NewQuota()
	d.sessions = limits.NewTTLSet(SessionTTL, maxSessions)
	d.sessKey = make([]byte, 32)
	if _, err := rand.Read(d.sessKey); err != nil {
		panic("appevents: no randomness: " + err.Error())
	}
	d.card = map[string]*budget{}
	d.Metrics.Help("scf_gateway_app_requests_total", "counter", "App-event requests (/v1/app-events) by HTTP status.")
	d.Metrics.Help("scf_gateway_app_events_total", "counter", "Self-attested app events by outcome (accepted, dropped) and reason (none, unsafe, value_shape, stale, cardinality).")
}

// Register adds the route (POST and the CORS preflight a Telegram Mini App's WebView sends).
func (d *Door) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST "+Path, d.serve)
	mux.HandleFunc("OPTIONS "+Path, func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "POST")
		h.Set("Access-Control-Allow-Headers", "content-type")
		h.Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
	})
}

func (d *Door) answer(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	// Any origin, never credentials: the key is public and nothing in the answer is tenant data.
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Expose-Headers", "Retry-After")
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
	d.Metrics.Add("scf_gateway_app_requests_total", 1, "status", strconv.Itoa(status))
}

func retryAfter(w http.ResponseWriter, s int) { w.Header().Set("Retry-After", strconv.Itoa(s)) }

func peerNet(r *http.Request) (string, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return "", false
	}
	return string(challenge.Net(a.Unmap())), true
}

func (d *Door) serve(w http.ResponseWriter, r *http.Request) {
	now := d.Now()
	ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	if ct != "application/json" && ct != "text/plain" { // text/plain: a WebView may send without a preflight
		d.answer(w, http.StatusUnsupportedMediaType, `{"error":"content_type"}`)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBody))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		d.answer(w, http.StatusRequestEntityTooLarge, `{"error":"too_large"}`)
		return
	}
	if err != nil {
		d.answer(w, http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	b, err := Parse(body)
	if err != nil {
		d.answer(w, http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	view := d.Snap.Current()
	if view == nil || d.Draining() {
		retryAfter(w, 10)
		d.answer(w, http.StatusServiceUnavailable, `{"error":"unavailable"}`)
		return
	}
	if view.Expired(now) {
		retryAfter(w, 30)
		d.answer(w, http.StatusServiceUnavailable, `{"error":"snapshot_expired"}`)
		return
	}
	site := view.SiteByKey(b.SiteKey)
	if site == nil {
		d.answer(w, http.StatusNotFound, `{"error":"unknown_site"}`)
		return
	}
	switch t := view.Tenant(site.TenantID); {
	case t == nil || t.Status == "pending":
		d.answer(w, http.StatusForbidden, `{"error":"tenant_pending"}`)
		return
	case t.Status == "suspended":
		d.answer(w, http.StatusForbidden, `{"error":"tenant_suspended"}`)
		return
	}
	n := len(b.Events)
	// Daily cap: a separate per-tenant budget of the same size as the verified-event quota share, so app traffic can
	// neither consume nor be consumed by the web quota.
	if site.Status == "over_quota" || d.quota.Over(site.TenantID, n, limits.Share(site.DailyQuota, d.LiveNodes()), now) {
		retryAfter(w, limits.SecondsToMidnight(now))
		d.answer(w, http.StatusTooManyRequests, `{"error":"quota_exceeded"}`)
		return
	}
	netb, ok := peerNet(r)
	if !ok {
		d.answer(w, http.StatusBadRequest, `{"error":"malformed"}`)
		return
	}
	// Rate limits as on the web path (§a.6 step 2), in their own windows: per (site, subnet) first, capped to a quarter
	// of the node's site share, then per site.
	siteShare := limits.Share(site.RateLimitPerMin, d.LiveNodes())
	if ok, retry := d.subnetRate.Allow(site.SiteID+"|"+netb, subnetLimit(view.Settings.WebRequestsPerMinSubnet, siteShare), now); !ok {
		retryAfter(w, retry)
		d.answer(w, http.StatusTooManyRequests, `{"error":"rate_limited"}`)
		return
	}
	if ok, retry := d.siteRate.Allow(site.SiteID, siteShare, now); !ok {
		retryAfter(w, retry)
		d.answer(w, http.StatusTooManyRequests, `{"error":"rate_limited"}`)
		return
	}
	accepted, dropped := d.count(site, b, now)
	d.quota.Add(site.TenantID, accepted, now)
	d.answer(w, http.StatusAccepted, `{"accepted":`+strconv.Itoa(accepted)+`,"dropped":`+strconv.Itoa(dropped)+`}`)
}

// subnetLimit mirrors the web path: the setting (default 600/min), at most a quarter of the node's site share
// (at least 10/min).
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

// count judges each event and adds the accepted ones to the `app` cells: per event `<name>/_total/all` and one
// `<name>/<key>/<value>` per property; per new session of the day `_session/_total/all`, `_session/app_version/…`,
// `_session/sdk_version/…` and, for a Mini App, `_session/tma_platform/…`; per dropped event `_dropped/reason/…`.
func (d *Door) count(site *snapshot.Site, b Batch, now time.Time) (accepted, dropped int) {
	add := func(day, event, key, value string) {
		d.Counters.AddApp(counters.AppKey{Tenant: site.TenantID, Site: site.SiteID, Day: day, Platform: b.Platform,
			Event: event, Key: key, Value: value}, 1)
	}
	today := counters.Day(now)
	for _, e := range b.Events {
		ts := time.UnixMilli(e.TsMs)
		reason := judgeEvent(e)
		if reason == "" && (ts.Before(now.Add(-maxPast)) || ts.After(now.Add(maxFuture))) {
			reason = DropStale
		}
		day := today
		if reason == "" {
			day = counters.Day(ts) // a queued event counts on the day it happened (≤ 24 h back)
			if !d.fits(site.SiteID, day, e) {
				reason = DropCardinality
			}
		}
		if reason != "" {
			dropped++
			add(today, "_dropped", "reason", reason)
			d.Metrics.Add("scf_gateway_app_events_total", 1, "outcome", "dropped", "reason", reason)
			continue
		}
		accepted++
		d.Metrics.Add("scf_gateway_app_events_total", 1, "outcome", "accepted", "reason", "none")
		add(day, e.Name, "_total", "all")
		for k, v := range e.Props {
			add(day, e.Name, k, v)
		}
		if d.newSession(site.SiteID, day, e.Session, now) {
			add(day, "_session", "_total", "all")
			add(day, "_session", "app_version", b.AppVersion)
			add(day, "_session", "sdk_version", b.SDKVersion)
			if b.TMAPlatform != "" {
				add(day, "_session", "tma_platform", b.TMAPlatform)
			}
		}
	}
	return accepted, dropped
}

// newSession reports the first sighting of a session id for the site and day on this node. Only a keyed hash is kept,
// for SessionTTL; a session that spans midnight counts on both days, and one seen by two edge nodes counts twice
// (stated in docs/onboarding/mobile.md).
func (d *Door) newSession(site, day, session string, now time.Time) bool {
	m := hmac.New(sha256.New, d.sessKey)
	m.Write([]byte(site + "|" + day + "|" + session))
	k := hex.EncodeToString(m.Sum(nil)[:16])
	if d.sessions.Seen(k, now) {
		return false
	}
	d.sessions.Add(k, now)
	return true
}

// fits applies the per-site daily budgets of distinct names and cells; an event that would start a name or cell
// beyond them is refused whole (no partial event is counted).
func (d *Door) fits(site, day string, e Event) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if day > d.cardDay {
		// A new day: forget budgets older than yesterday (events may arrive up to 24 h late).
		for k := range d.card {
			if !sameOrPrevDay(k[strings.LastIndexByte(k, '|')+1:], day) {
				delete(d.card, k)
			}
		}
		d.cardDay = day
	}
	bk := site + "|" + day
	bu := d.card[bk]
	if bu == nil {
		bu = &budget{names: map[string]bool{}, cells: map[string]bool{}}
		d.card[bk] = bu
	}
	newName := !bu.names[e.Name]
	if newName && len(bu.names) >= MaxNamesPerSiteDay {
		return false
	}
	var newCells []string
	for k, v := range e.Props {
		c := e.Name + "\x00" + k + "\x00" + v
		if !bu.cells[c] {
			newCells = append(newCells, c)
		}
	}
	if len(bu.cells)+len(newCells) > MaxCellsPerSiteDay {
		return false
	}
	bu.names[e.Name] = true
	for _, c := range newCells {
		bu.cells[c] = true
	}
	return true
}

func sameOrPrevDay(a, day string) bool {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return false
	}
	return a == day || a == t.AddDate(0, 0, -1).Format("2006-01-02")
}
