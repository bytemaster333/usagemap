// SPDX-License-Identifier: Apache-2.0

// Package forwarder drains the spool (wire-formats §c, §l): event records go to `POST /api/send` on a core's engine
// proxy chosen by rendezvous hashing of the surrogate (C-74), with failover to the next core; counter records go to
// `POST /internal/v1/edge/counters`. Both over per-node mutual TLS with the edge certificate (C-60). A record is
// acknowledged in the spool only on a final answer (§c.6); otherwise it stays and is retried with back-off (1 s →
// 60 s) until the 72-hour rule discards it. Delivery is at-least-once.
package forwarder

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/counters"
	"github.com/bytemaster333/usagemap/services/gateway/internal/metrics"
	"github.com/bytemaster333/usagemap/services/gateway/internal/snapshot"
	"github.com/bytemaster333/usagemap/services/gateway/internal/spool"
)

// Forwarder drains one node's spool.
type Forwarder struct {
	Spool    *spool.Spool
	Snap     *snapshot.Store
	Cores    []snapshot.Core
	Client   *http.Client
	Counters *counters.Agg
	Metrics  *metrics.Registry
	Log      *slog.Logger
	Workers  int
	Now      func() time.Time
	Expiry   time.Duration // 72 h
	// MaxBackoff caps the retry delay (60 s; tests lower it).
	MaxBackoff time.Duration

	mu        sync.Mutex
	inflight  map[spool.Position]bool
	siteBusy  map[uint32]int // in-flight event records per site
	unhealthy map[string]time.Time
}

// siteCap is how many workers one site's records may occupy: three quarters of them, so a backlog of one site
// (a flood while Umami was down) never stops the delivery of the other sites' records. A site
// alone still gets most of the throughput.
func (f *Forwarder) siteCap() int { return max(1, f.Workers*3/4) }

func (f *Forwarder) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

// Order returns the cores in rendezvous order for a surrogate: score(k) = first 8 bytes of SHA-256(core_id ‖
// surrogate as 16 bytes), highest first (§c.1).
func Order(cores []snapshot.Core, surrogate netip.Addr) []snapshot.Core {
	s16 := surrogate.As16()
	type scored struct {
		c snapshot.Core
		s uint64
	}
	sc := make([]scored, len(cores))
	for i, c := range cores {
		h := sha256.New()
		h.Write([]byte(c.ID))
		h.Write(s16[:])
		sc[i] = scored{c, binary.BigEndian.Uint64(h.Sum(nil)[:8])}
	}
	sort.SliceStable(sc, func(i, j int) bool { return sc[i].s > sc[j].s })
	out := make([]snapshot.Core, len(sc))
	for i, x := range sc {
		out[i] = x.c
	}
	return out
}

// healthyFirst keeps the order but moves cores that failed in the last 10 s to the end.
func (f *Forwarder) healthyFirst(cores []snapshot.Core) []snapshot.Core {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	var good, bad []snapshot.Core
	for _, c := range cores {
		if t, ok := f.unhealthy[c.ID]; ok && now.Before(t) {
			bad = append(bad, c)
		} else {
			good = append(good, c)
		}
	}
	return append(good, bad...)
}

func (f *Forwarder) markUnhealthy(id string) {
	f.mu.Lock()
	f.unhealthy[id] = f.now().Add(10 * time.Second)
	f.mu.Unlock()
}

// Run drains until ctx ends.
func (f *Forwarder) Run(ctx context.Context) {
	if f.Workers <= 0 {
		f.Workers = 16
	}
	if f.Expiry <= 0 {
		f.Expiry = 72 * time.Hour
	}
	if f.MaxBackoff <= 0 {
		f.MaxBackoff = 60 * time.Second
	}
	f.inflight = map[spool.Position]bool{}
	f.siteBusy = map[uint32]int{}
	f.unhealthy = map[string]time.Time{}
	jobs := make(chan spool.Pending)
	freed := make(chan struct{}, 1)
	var wg sync.WaitGroup
	for i := 0; i < f.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for p := range jobs {
				f.handle(ctx, p)
				f.mu.Lock()
				delete(f.inflight, p.Pos)
				if p.Site != 0 {
					if f.siteBusy[p.Site]--; f.siteBusy[p.Site] <= 0 {
						delete(f.siteBusy, p.Site)
					}
				}
				f.mu.Unlock()
				select {
				case freed <- struct{}{}:
				default:
				}
			}
		}()
	}
	// Per-site fairness: a site may occupy at most siteCap workers. Records of a site at its cap
	// are parked (positions only, at most parkMax per site) and dispatched as soon as the site has a free worker, while
	// the cursor moves on to the other sites' records. Beyond parkMax a site's records are skipped and picked up by a
	// new pass from the oldest record once the parked ones are out.
	const parkMax = 1 << 16
	parked := map[uint32][]spool.Pending{}
	dispatch := func(p spool.Pending) bool {
		select {
		case jobs <- p:
			return true
		case <-ctx.Done():
			return false
		}
	}
	cursor := spool.Start
	skipped := false
	lastRescan := f.now()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
loop:
	for ctx.Err() == nil {
		for site, q := range parked {
			for len(q) > 0 {
				f.mu.Lock()
				free := f.siteBusy[site] < f.siteCap()
				if free {
					f.siteBusy[site]++
				}
				f.mu.Unlock()
				if !free {
					break
				}
				if !dispatch(q[0]) {
					break loop
				}
				q = q[1:]
			}
			if len(q) == 0 {
				delete(parked, site)
			} else {
				parked[site] = q
			}
		}
		if f.now().Sub(lastRescan) > 15*time.Second && len(parked) == 0 {
			cursor, lastRescan = spool.Start, f.now() // pick up deferred records
		}
		batch := f.Spool.PendingAfter(cursor, 256)
		for _, p := range batch {
			cursor = p.Pos
			f.mu.Lock()
			busy := f.inflight[p.Pos]
			full := !busy && p.Site != 0 && f.siteBusy[p.Site] >= f.siteCap()
			park := full && len(parked[p.Site]) < parkMax
			if !busy && (!full || park) {
				f.inflight[p.Pos] = true // dispatched or parked: a later pass must not take it again
				if !full && p.Site != 0 {
					f.siteBusy[p.Site]++
				}
			}
			f.mu.Unlock()
			switch {
			case busy:
			case park:
				parked[p.Site] = append(parked[p.Site], p)
			case full:
				skipped = true
			default:
				if !dispatch(p) {
					break loop
				}
			}
		}
		if len(batch) < 256 {
			select {
			case <-ctx.Done():
				break loop
			case <-f.Spool.Notify():
			case <-freed:
			case <-tick.C:
			}
			if skipped && len(parked) == 0 {
				cursor, skipped = spool.Start, false // a pass that skipped records starts again from the oldest
			}
		}
	}
	close(jobs)
	wg.Wait()
}

type result int

const (
	final result = iota
	transient
	deferred
)

func (f *Forwarder) handle(ctx context.Context, p spool.Pending) {
	backoff := time.Second
	ambiguous := "" // core of an earlier attempt that may have reached Umami (ADR-0020)
	for ctx.Err() == nil {
		if f.now().UnixMilli()-p.ReceivedAtMs > f.Expiry.Milliseconds() {
			f.expire(p)
			return
		}
		data, err := f.Spool.Read(p.Pos)
		if errors.Is(err, spool.ErrGone) {
			return
		}
		if err != nil {
			f.Log.Error("spool record unreadable", "segment", p.Pos.Seg, "index", p.Pos.Idx)
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "event", "outcome", "unreadable")
			return
		}
		var r result
		if p.Event {
			r = f.sendEvent(ctx, p, data, &ambiguous)
		} else {
			r = f.sendCounters(ctx, p, data)
		}
		switch r {
		case final, deferred:
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > f.MaxBackoff {
			backoff = f.MaxBackoff
		}
	}
}

func (f *Forwarder) expire(p spool.Pending) {
	if p.Event {
		if data, err := f.Spool.Read(p.Pos); err == nil {
			var rec spool.EventRecord
			if json.Unmarshal(data, &rec) == nil {
				f.Counters.Add(rec.TenantID, rec.SiteID, time.UnixMilli(rec.ReceivedAtMs), "drop", "undeliverable_72h", 1)
			}
		}
	}
	if err := f.Spool.Ack(p.Pos, spool.OutExpired); err == nil {
		f.Metrics.Add("scf_gateway_forward_total", 1, "kind", kind(p), "outcome", "expired_72h")
	}
}

func kind(p spool.Pending) string {
	if p.Event {
		return "event"
	}
	return "counter"
}

// Payload builds the exact §c.2 body for a record.
func Payload(rec *spool.EventRecord, website string) ([]byte, error) {
	pl := map[string]any{
		"website":   website,
		"hostname":  rec.Hostname,
		"url":       rec.URL,
		"tag":       rec.Tag,
		"timestamp": rec.ReceivedAtMs / 1000,
	}
	if rec.ReferrerHost != "" {
		pl["referrer"] = "https://" + rec.ReferrerHost + "/"
	}
	if rec.Screen != "" {
		pl["screen"] = rec.Screen
	}
	if rec.Language != "" {
		pl["language"] = rec.Language
	}
	if rec.Kind != "pageview" && rec.Name != "" {
		pl["name"] = rec.Name
	}
	if len(rec.Data) > 0 && rec.Kind != "pageview" {
		pl["data"] = rec.Data
	}
	return json.Marshal(map[string]any{"type": "event", "payload": pl})
}

// Ambiguous reports whether a failed attempt may still have been processed by Umami: the request was fully written
// and the answer was lost (transport error after writing) or a gateway-type 5xx (500, 502, 504) came back. A refused
// connection, a 503 or a 429 is an explicit "not processed".
func Ambiguous(wrote bool, err error, status int) bool {
	if !wrote {
		return false
	}
	if err != nil {
		return !errors.Is(err, syscall.ECONNREFUSED)
	}
	return status == http.StatusInternalServerError || status == http.StatusBadGateway || status == http.StatusGatewayTimeout
}

func (f *Forwarder) sendEvent(ctx context.Context, p spool.Pending, data []byte, ambiguous *string) result {
	var rec spool.EventRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		f.Log.Error("spool event record not decodable", "segment", p.Pos.Seg, "index", p.Pos.Idx)
		return deferred
	}
	website := ""
	if rec.UmamiWebsiteID != nil {
		website = *rec.UmamiWebsiteID
	} else if v := f.Snap.Current(); v != nil {
		// Twin not yet provisioned when the event arrived (C-73): resolve it now from the snapshot.
		if s := v.SiteByID(rec.SiteID); s != nil && s.UmamiTwinWebsiteID != nil && rec.Target == "twin" {
			website = *s.UmamiTwinWebsiteID
		}
	}
	if website == "" {
		f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "event", "outcome", "deferred_twin")
		return deferred // kept in the spool; retried on the next rescan
	}
	body, err := Payload(&rec, website)
	if err != nil {
		return deferred
	}
	sur, err := netip.ParseAddr(rec.Surrogate)
	if err != nil {
		return deferred
	}
	visit := "track"
	if rec.Target == "twin" {
		visit = "none"
	}
	for _, c := range f.healthyFirst(Order(f.Cores, sur)) {
		hdr := map[string]string{
			"User-Agent":         rec.UA,
			"x-scf-surrogate-ip": rec.Surrogate,
			"cf-ipcountry":       rec.Country,
			"x-scf-visit":        visit,
		}
		if rec.EventKey != "" {
			// The engine proxy forwards the first copy of an event key and answers later copies without forwarding
			// (§c.5). Records spooled before the key existed carry none.
			hdr["x-scf-event-key"] = rec.EventKey
		}
		status, respBody, wrote, err := f.postTraced(ctx, c, "/api/send", body, hdr)
		if (err != nil || status >= 500) && Ambiguous(wrote, err, status) && *ambiguous == "" {
			*ambiguous = c.ID
		}
		if err != nil || status >= 500 || status == http.StatusTooManyRequests {
			f.markUnhealthy(c.ID)
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "event", "outcome", "core_failed", "core", c.ID, "error_kind", errorKind(err, status))
			continue
		}
		var out spool.Outcome
		switch {
		case status == http.StatusOK && bytes.Equal(bytes.TrimSpace(respBody), []byte(`{"beep":"boop"}`)):
			out = spool.OutEngineBot
			f.Counters.Add(rec.TenantID, rec.SiteID, time.UnixMilli(rec.ReceivedAtMs), "drop", "engine_bot_drop", 1)
		case status == http.StatusOK:
			out = spool.OutStored
		case status == http.StatusBadRequest:
			out = spool.OutEngineRejected
			f.Counters.Add(rec.TenantID, rec.SiteID, time.UnixMilli(rec.ReceivedAtMs), "drop", "engine_rejected", 1)
			f.Log.Error("engine rejected an event (400); discarded", "core", c.ID, "site_id", rec.SiteID)
		default:
			// 401/403/404/…: a configuration problem on our side, never the record's fault — keep and retry.
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "event", "outcome", "refused", "core", c.ID, "error_kind", strconv.Itoa(status))
			f.Log.Error("engine proxy refused the edge", "core", c.ID, "status", status)
			return transient
		}
		if err := f.Spool.Ack(p.Pos, out); err != nil {
			return transient
		}
		f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "event", "outcome", outcomeLabel(out), "core", c.ID)
		if *ambiguous != "" && out != spool.OutEngineRejected {
			// Delivered after an attempt whose outcome is unknown. With an event key the engine proxy de-duplicates the
			// retry on the same core (§c.5); without one (old records) or across a core failover Umami may hold the
			// event twice. Counted, reported monthly, alerted on (DuplicateForwardsHigh).
			f.Metrics.Add("scf_gateway_forward_ambiguous_retries_total", 1, "core", *ambiguous)
		}
		return final
	}
	return transient
}

func outcomeLabel(o spool.Outcome) string {
	switch o {
	case spool.OutEngineBot:
		return "acked_engine_bot"
	case spool.OutEngineRejected:
		return "acked_engine_rejected"
	default:
		return "acked_stored"
	}
}

func (f *Forwarder) sendCounters(ctx context.Context, p spool.Pending, data []byte) result {
	stripped := false
	for _, c := range f.healthyFirst(f.Cores) {
	attempt:
		status, _, err := f.post(ctx, c, "/internal/v1/edge/counters", data, nil)
		if err != nil || status >= 500 || status == http.StatusTooManyRequests {
			f.markUnhealthy(c.ID)
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "counter", "outcome", "core_failed", "core", c.ID, "error_kind", errorKind(err, status))
			continue
		}
		switch {
		case status == http.StatusOK || status == http.StatusNoContent:
		case status == http.StatusBadRequest || status == http.StatusUnprocessableEntity:
			if !stripped {
				// Upgrade/rollback safety net (C-137, §d.3 rule 3): a core that does not know the optional parts
				// refuses the whole record; re-send it once without them (same record_id, so the per-part
				// idempotency of §l holds) before the discard rule applies.
				if lean, props, dev, ok := StripOptional(data); ok {
					stripped = true
					data = lean
					f.Log.Warn("control plane refused a counter record with optional parts; re-sending without them",
						"core", c.ID, "status", status, "props_dropped", props, "dev_dropped", dev)
					f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "counter", "outcome", "stripped_retry", "core", c.ID)
					goto attempt
				}
			}
			f.Log.Error("control plane rejected a counter record; discarded", "core", c.ID, "status", status)
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "counter", "outcome", "rejected", "core", c.ID)
		default:
			f.Log.Error("control plane refused a counter record", "core", c.ID, "status", status)
			f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "counter", "outcome", "refused", "core", c.ID, "error_kind", strconv.Itoa(status))
			return transient
		}
		if err := f.Spool.Ack(p.Pos, spool.OutCounter); err != nil {
			return transient
		}
		f.Metrics.Add("scf_gateway_forward_total", 1, "kind", "counter", "outcome", "delivered", "core", c.ID)
		return final
	}
	return transient
}

// StripOptional removes the optional `props`, `dev` (C-136) and `app` (§a.9) parts from a counter record, keeping
// every other byte of meaning (record_id included). ok = false when the record carries none of them. The returned
// counts are those of `props` and `dev`; dropped `app` rows are self-attested and best effort.
func StripOptional(data []byte) (lean []byte, props, dev int, ok bool) {
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil {
		return nil, 0, 0, false
	}
	count := func(k string) int {
		var a []json.RawMessage
		_ = json.Unmarshal(m[k], &a)
		return len(a)
	}
	_, hasP := m["props"]
	_, hasD := m["dev"]
	_, hasA := m["app"]
	_, hasR := m["rpc"]
	if !hasP && !hasD && !hasA && !hasR {
		return nil, 0, 0, false
	}
	props, dev = count("props"), count("dev")
	delete(m, "props")
	delete(m, "dev")
	delete(m, "app")
	delete(m, "rpc")
	lean, err := json.Marshal(m)
	if err != nil {
		return nil, 0, 0, false
	}
	return lean, props, dev, true
}

func (f *Forwarder) post(ctx context.Context, c snapshot.Core, path string, body []byte, headers map[string]string) (int, []byte, error) {
	status, b, _, err := f.postTraced(ctx, c, path, body, headers)
	return status, b, err
}

// postTraced also reports whether the whole request was written to the connection (httptrace WroteRequest).
func (f *Forwarder) postTraced(ctx context.Context, c snapshot.Core, path string, body []byte, headers map[string]string) (int, []byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var wrote atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteRequest: func(i httptrace.WroteRequestInfo) {
		if i.Err == nil {
			wrote.Store(true)
		}
	}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return 0, nil, wrote.Load(), err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode, b, wrote.Load(), err
}

// errorKind maps a failure to a closed set (transport errors embed addresses; never logged).
func errorKind(err error, status int) string {
	if err == nil {
		return strconv.Itoa(status)
	}
	var ne net.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.ECONNRESET):
		return "connection_reset"
	default:
		return "transport"
	}
}

// CountExpired is the spool's ExpireOld callback: it counts `drop/undeliverable_72h` for the record's site.
func (f *Forwarder) CountExpired(data []byte) {
	var rec spool.EventRecord
	if json.Unmarshal(data, &rec) == nil {
		f.Counters.Add(rec.TenantID, rec.SiteID, time.UnixMilli(rec.ReceivedAtMs), "drop", "undeliverable_72h", 1)
	}
}
