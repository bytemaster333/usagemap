// SPDX-License-Identifier: Apache-2.0

// Package counters aggregates the per-site daily edge counters (verdicts, reasons, network class, client signals,
// proof-of-work latency, multiplicity buckets, identifier, Wallets Kit presence, drops; data-model §8.9) in memory
// and writes them, once a minute, as a counter record into the spool together with the spool accounting deltas
// (wire-formats §d.3, §d.4, C-39, C-76). The forwarder uploads those records to the control plane (§l).
package counters

import (
	"context"
	"log/slog"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
	"github.com/bytemaster333/usagemap/services/gateway/internal/uuid"
)

type key struct {
	tenant, site, day, counter, label string
}

type otlpKey struct{ tenant, day, reason string }

// PropKey identifies one property-count cell (§d.3 `props`).
type PropKey struct {
	Tenant, Site, Day, Event, Network, Key, Value, Verdict string
}

// AppKey identifies one self-attested app-event cell (§a.9, §d.3 `app`). Day is the event's UTC day, set by the
// caller (an app may deliver a queued event after midnight).
type AppKey struct {
	Tenant, Site, Day, Platform, Event, Key, Value string
}

// MaxDevPerSite caps the `dev` entries per site and counter record (§a.8, §d.3).
const MaxDevPerSite = 20

var labelRe = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)

// Agg is the in-memory aggregate of one period.
type Agg struct {
	mu     sync.Mutex
	web    map[key]int64
	otlp   map[otlpKey]int64
	tokens map[string]spool.TokenUse
	props  map[PropKey]int64
	dev    map[string][]spool.DevEvent // site id → newest entries of this period (≤ MaxDevPerSite)
	app    map[AppKey]int64
	rpc    map[RPCKey]int64 // browser RPC aggregate cells (§a.3.2), see rpc.go
}

// New creates an empty aggregate.
func New() *Agg {
	return &Agg{web: map[key]int64{}, otlp: map[otlpKey]int64{}, tokens: map[string]spool.TokenUse{},
		props: map[PropKey]int64{}, dev: map[string][]spool.DevEvent{}, app: map[AppKey]int64{}}
}

// AddApp counts n for one self-attested app-event cell (§a.9). The appevents door validates every field; a cell
// without a day is ignored (a programming error).
func (a *Agg) AddApp(k AppKey, n int64) {
	if n <= 0 || k.Day == "" {
		return
	}
	a.mu.Lock()
	a.app[k] += n
	a.mu.Unlock()
}

// GetApp returns one app-event cell's current value (tests).
func (a *Agg) GetApp(k AppKey) int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.app[k]
}

// AddProp counts n for one property cell of an accepted Stellar event (C-136, §a.3.1). Values outside the label
// pattern are ignored (a programming error; the parser admits closed lists only).
func (a *Agg) AddProp(k PropKey, at time.Time, n int64) {
	if n <= 0 || !labelRe.MatchString(k.Value) || !labelRe.MatchString(k.Key) {
		return
	}
	k.Day = Day(at)
	a.mu.Lock()
	a.props[k] += n
	a.mu.Unlock()
}

// GetProp returns one property cell's current value (tests).
func (a *Agg) GetProp(k PropKey, at time.Time) int64 {
	k.Day = Day(at)
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.props[k]
}

// AddDev keeps one dev-request event for the first-event panel (§a.8): at most MaxDevPerSite per site and period,
// the newest kept.
func (a *Agg) AddDev(e spool.DevEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	l := append(a.dev[e.SiteID], e)
	if len(l) > MaxDevPerSite {
		l = l[len(l)-MaxDevPerSite:]
	}
	a.dev[e.SiteID] = l
}

// Dev returns the dev entries of the current period for a site (tests).
func (a *Agg) Dev(site string) []spool.DevEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]spool.DevEvent(nil), a.dev[site]...)
}

// WebRows returns every web counter cell of the current period for a site (tests).
func (a *Agg) WebRows(site string) map[string]int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := map[string]int64{}
	for k, v := range a.web {
		if k.site == site {
			out[k.counter+"/"+k.label] += v
		}
	}
	return out
}

// PropRows returns the number of property cells of the current period for a site (tests).
func (a *Agg) PropRows(site string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for k := range a.props {
		if k.Site == site {
			n++
		}
	}
	return n
}

// Day is the UTC day of t.
func Day(t time.Time) string { return t.UTC().Format("2006-01-02") }

// Add counts n for one web counter. Labels outside the closed pattern are ignored (a programming error).
func (a *Agg) Add(tenant, site string, at time.Time, counter, label string, n int64) {
	if n <= 0 || !labelRe.MatchString(label) {
		return
	}
	a.mu.Lock()
	a.web[key{tenant, site, Day(at), counter, label}] += n
	a.mu.Unlock()
}

// AddOTLP counts an OTLP rejection (the OTLP front door).
func (a *Agg) AddOTLP(tenant string, at time.Time, reason string, n int64) {
	a.mu.Lock()
	a.otlp[otlpKey{tenant, Day(at), reason}] += n
	a.mu.Unlock()
}

// TokenUsed records an ingest token's last use.
func (a *Agg) TokenUsed(tokenID, tenant string, at time.Time) {
	a.mu.Lock()
	t := a.tokens[tokenID]
	if at.UnixMilli() > t.LastUsedMs {
		a.tokens[tokenID] = spool.TokenUse{TokenID: tokenID, TenantID: tenant, LastUsedMs: at.UnixMilli()}
	}
	a.mu.Unlock()
}

// Get returns one counter's current value (tests).
func (a *Agg) Get(tenant, site string, at time.Time, counter, label string) int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.web[key{tenant, site, Day(at), counter, label}]
}

type taken struct {
	web    map[key]int64
	otlp   map[otlpKey]int64
	tokens map[string]spool.TokenUse
	props  map[PropKey]int64
	dev    map[string][]spool.DevEvent
	app    map[AppKey]int64
}

func (a *Agg) take() taken {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := taken{a.web, a.otlp, a.tokens, a.props, a.dev, a.app}
	a.web, a.otlp, a.tokens = map[key]int64{}, map[otlpKey]int64{}, map[string]spool.TokenUse{}
	a.props, a.dev, a.app = map[PropKey]int64{}, map[string][]spool.DevEvent{}, map[AppKey]int64{}
	return t
}

func (a *Agg) restore(t taken) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for k, v := range t.web {
		a.web[k] += v
	}
	for k, v := range t.otlp {
		a.otlp[k] += v
	}
	for k, v := range t.tokens {
		if v.LastUsedMs > a.tokens[k].LastUsedMs {
			a.tokens[k] = v
		}
	}
	for k, v := range t.props {
		a.props[k] += v
	}
	for k, v := range t.app {
		a.app[k] += v
	}
	for site, l := range t.dev {
		l = append(l, a.dev[site]...)
		if len(l) > MaxDevPerSite {
			l = l[len(l)-MaxDevPerSite:]
		}
		a.dev[site] = l
	}
}

// Flusher writes one counter record per period.
type Flusher struct {
	Agg    *Agg
	Spool  *spool.Spool
	Node   string
	BootID string
	Log    *slog.Logger
	Now    func() time.Time
	// Features reports which optional counter-record parts the current edge snapshot advertises
	// (settings.counter_features, C-137). nil = none: `props` and `dev` entries are then dropped in memory.
	Features func() (props, dev bool)
	// AppFeature reports whether the snapshot advertises the `app` part (§a.9). nil or false: app cells are dropped
	// in memory at the flush (the app door answers 202 regardless; the counts are self-attested and best effort).
	AppFeature func() bool
	// RPCFeature reports whether the snapshot advertises the `rpc` part (§a.3.2, browser RPC aggregate). nil or false:
	// the cells are dropped in memory at the flush.
	RPCFeature func() bool

	periodStart time.Time
	reportedDay map[string]bool // days for which this boot already sent queued_at_day_start
	lastQueued  int64
	haveQueued  bool
}

func (f *Flusher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

// Flush builds and spools one counter record covering [periodStart, now). It always writes a record (even an
// empty one) so the spool accounting reaches the control plane every period.
func (f *Flusher) Flush(ctx context.Context) error {
	end := f.now().UTC()
	if f.periodStart.IsZero() {
		f.periodStart = end.Add(-time.Minute)
	}
	if f.reportedDay == nil {
		f.reportedDay = map[string]bool{}
	}
	t := f.Agg.take()
	d := f.Spool.TakeAccounting()
	rec := &spool.CounterRecord{
		RecordID:      uuid.V7(end).String(),
		PeriodStartMs: f.periodStart.UnixMilli(),
		PeriodEndMs:   end.UnixMilli(),
	}
	for k, v := range t.web {
		rec.Web = append(rec.Web, spool.WebCounter{TenantID: k.tenant, SiteID: k.site, Day: k.day, Counter: k.counter, Label: k.label, Count: v})
	}
	sort.Slice(rec.Web, func(i, j int) bool {
		a, b := rec.Web[i], rec.Web[j]
		if a.SiteID != b.SiteID {
			return a.SiteID < b.SiteID
		}
		if a.Counter != b.Counter {
			return a.Counter < b.Counter
		}
		return a.Label < b.Label
	})
	for k, v := range t.otlp {
		rec.OTLP = append(rec.OTLP, spool.OTLPCounter{TenantID: k.tenant, Day: k.day, Reason: k.reason, Count: v})
	}
	for _, v := range t.tokens {
		rec.Tokens = append(rec.Tokens, v)
	}
	var wantProps, wantDev bool
	if f.Features != nil {
		wantProps, wantDev = f.Features()
	}
	if wantProps {
		for k, v := range t.props {
			rec.Props = append(rec.Props, spool.PropCounter{TenantID: k.Tenant, SiteID: k.Site, Day: k.Day, Event: k.Event,
				Network: k.Network, Key: k.Key, Value: k.Value, Verdict: k.Verdict, Count: v})
		}
		sort.Slice(rec.Props, func(i, j int) bool { return propLess(rec.Props[i], rec.Props[j]) })
	}
	if wantDev {
		sites := make([]string, 0, len(t.dev))
		for s := range t.dev {
			sites = append(sites, s)
		}
		sort.Strings(sites)
		for _, s := range sites {
			rec.Dev = append(rec.Dev, t.dev[s]...)
		}
	}
	wantApp := f.AppFeature != nil && f.AppFeature()
	if wantApp {
		for k, v := range t.app {
			rec.App = append(rec.App, spool.AppCounter{TenantID: k.Tenant, SiteID: k.Site, Day: k.Day, Platform: k.Platform,
				Event: k.Event, Key: k.Key, Value: k.Value, Count: v})
		}
		sort.Slice(rec.App, func(i, j int) bool { return appLess(rec.App[i], rec.App[j]) })
	}
	rpcCells := f.Agg.takeRPC()
	wantRPC := f.RPCFeature != nil && f.RPCFeature()
	if wantRPC {
		rec.RPC = rpcRows(rpcCells)
	}
	day := Day(end)
	rec.Spool = spool.Accounting{BootID: f.BootID, Day: day, Fsynced: d.Fsynced, AckedStored: d.AckedStored,
		AckedEngineBot: d.AckedEngineBot, AckedEngineRejected: d.AckedEngineRejected, Expired72h: d.Expired72h, Queued: d.Queued}
	if !f.reportedDay[day] {
		// queued at the start of this record's period: the previous record's queue gauge (or, for the first record of
		// this boot, the queue recovered from the segment files minus what this period added and removed).
		q := d.Queued - d.Fsynced + d.AckedStored + d.AckedEngineBot + d.AckedEngineRejected + d.Expired72h
		if f.haveQueued {
			q = f.lastQueued
		}
		if q < 0 {
			q = 0
		}
		rec.Spool.QueuedAtDayStart = &q
	}
	if err := f.Spool.Append(ctx, []spool.Record{rec}); err != nil {
		if !wantProps {
			t.props = nil
		}
		if !wantDev {
			t.dev = nil
		}
		if !wantApp {
			t.app = nil
		}
		f.Agg.restore(t)
		if wantRPC {
			f.Agg.restoreRPC(rpcCells)
		}
		f.Spool.Restore(d)
		f.Log.Warn("counter record not spooled; kept for the next period", "error", err.Error())
		return err
	}
	f.reportedDay[day] = true
	f.lastQueued, f.haveQueued = d.Queued, true
	f.periodStart = end
	return nil
}

// Run flushes at every minute boundary until ctx ends, then once more.
func (f *Flusher) Run(ctx context.Context, period time.Duration) {
	for {
		now := f.now()
		next := now.Truncate(period).Add(period)
		select {
		case <-ctx.Done():
			_ = f.Flush(context.Background())
			return
		case <-time.After(next.Sub(now)):
			_ = f.Flush(ctx)
		}
	}
}

// GetOTLP returns one OTLP rejection counter's current value (tests).
func (a *Agg) GetOTLP(tenant string, at time.Time, reason string) int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.otlp[otlpKey{tenant, Day(at), reason}]
}

func propLess(a, b spool.PropCounter) bool {
	x := [...]string{a.SiteID, a.Day, a.Event, a.Network, a.Key, a.Value, a.Verdict}
	y := [...]string{b.SiteID, b.Day, b.Event, b.Network, b.Key, b.Value, b.Verdict}
	for i := range x {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}

func appLess(a, b spool.AppCounter) bool {
	x := [...]string{a.TenantID, a.SiteID, a.Day, a.Platform, a.Event, a.Key, a.Value}
	y := [...]string{b.TenantID, b.SiteID, b.Day, b.Platform, b.Event, b.Key, b.Value}
	for i := range x {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}
