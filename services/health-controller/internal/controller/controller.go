// SPDX-License-Identifier: Apache-2.0

// Package controller is the health controller's decision loop (C-92):
//
//   - every round (30 s, aligned to the wall clock so both instances probe together) each instance probes every node;
//   - the instances exchange their results for the round (peer API);
//   - a round counts as failed for a node only when every instance that reported saw it fail, and as good only when
//     every reporting instance saw it good ("seen by both"; with the peer unreachable the instance's own view stands,
//     so the loss of one instance does not freeze DNS);
//   - a node goes down after FailRounds (3) consecutive failed rounds and comes back after RecoverRounds (5)
//     consecutive good rounds;
//   - the leader (etcd lease) writes each hostname's A and AAAA sets at every provider, each provider independently and
//     concurrently with its own timeout, so one provider's API being down never blocks the other; failed writes are
//     retried every round and counted; drift is corrected the same way;
//   - the last address of a record set is never removed.
package controller

import (
	"context"
	"errors"
	"log/slog"
	"net/netip"
	"slices"
	"sync"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/config"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/dns"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/election"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/metrics"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/prober"
)

// PeerSource fetches a peer's results for a round; ok=false when the peer has none (yet) or is unreachable.
type PeerSource interface {
	Fetch(ctx context.Context, round int64) (results []prober.Result, ok bool)
	Name() string
}

// Controller is one instance.
type Controller struct {
	Cfg       *config.Config
	Prober    prober.Prober
	Providers []dns.Provider
	Peers     []PeerSource
	Elector   election.Elector
	Metrics   *metrics.Registry
	Log       *slog.Logger
	Now       func() time.Time
	// PeerWait bounds how long a round waits for the peers' results after this instance started probing (default:
	// probe timeout + 2 s, at most 80 % of the interval). Peers probe at the same aligned instant.
	PeerWait time.Duration

	mu        sync.Mutex
	rounds    map[int64][]prober.Result // own results by round id (last few)
	nodes     map[string]*nodeState
	members   map[string]map[dns.Type]map[string]bool // hostname → type → node → in the desired set
	hydrated  bool
	wasLeader bool
}

type nodeState struct {
	up         bool
	failStreak int
	goodStreak int
}

// Describe registers the metric families.
func Describe(m *metrics.Registry) {
	m.Describe("scf_health_controller_leader", "gauge", "1 while this instance holds the etcd lease and writes DNS.")
	m.Describe("scf_health_controller_rounds_total", "counter", "Probe rounds completed by this instance.")
	m.Describe("scf_health_controller_last_round_timestamp_seconds", "gauge", "End of the last completed round (unix seconds).")
	m.Describe("scf_health_controller_node_probe_ok", "gauge", "This instance's last probe of the node (1 ok, 0 failed).")
	m.Describe("scf_health_controller_node_up", "gauge", "The controller's verdict for the node after the round rules (1 up, 0 down).")
	m.Describe("scf_health_controller_node_transitions_total", "counter", "Node verdict changes by direction.")
	m.Describe("scf_health_controller_peer_reachable", "gauge", "1 when the peer's results for the last round were received.")
	m.Describe("scf_health_controller_record_members", "gauge", "Addresses in the desired record set.")
	m.Describe("scf_health_controller_last_address_kept", "gauge", "1 when a failing node stays in a set because it is the last address (C-92).")
	m.Describe("scf_health_controller_dns_writes_total", "counter", "Record-set writes by provider and reason (remove, add, drift).")
	m.Describe("scf_health_controller_provider_errors_total", "counter", "Failed provider calls.")
	m.Describe("scf_health_controller_provider_up", "gauge", "1 when the last reconcile against the provider succeeded.")
	m.Describe("scf_health_controller_dns_drift", "gauge", "1 when the provider's published set differed from the desired set at the last reconcile.")
	m.Describe("scf_probe_canary_accepted_total", "counter", "Canary events answered 202 (wire-formats §o; used by durability_reconcile).")
}

func (c *Controller) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *Controller) init() {
	if c.rounds == nil {
		c.rounds = map[int64][]prober.Result{}
		c.nodes = map[string]*nodeState{}
		c.members = map[string]map[dns.Type]map[string]bool{}
		for _, n := range c.Cfg.Nodes {
			c.nodes[n.ID] = &nodeState{up: true}
		}
		for _, h := range c.Cfg.Hostnames {
			c.members[h.Name] = map[dns.Type]map[string]bool{}
			for _, t := range []dns.Type{dns.A, dns.AAAA} {
				c.members[h.Name][t] = map[string]bool{}
				for _, id := range h.Nodes {
					if addrOf(c.Cfg, id, t).IsValid() {
						c.members[h.Name][t][id] = true
					}
				}
			}
		}
	}
}

// RoundID is the wall-clock-aligned round number.
func (c *Controller) RoundID(t time.Time) int64 { return t.UnixNano() / int64(c.Cfg.Interval.Duration) }

// Results returns this instance's results for a round (peer API).
func (c *Controller) Results(round int64) ([]prober.Result, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r, ok := c.rounds[round]
	return r, ok
}

// Run loops until ctx ends.
func (c *Controller) Run(ctx context.Context) {
	c.mu.Lock()
	c.init()
	c.mu.Unlock()
	iv := c.Cfg.Interval.Duration
	for {
		now := c.now()
		next := now.Truncate(iv).Add(iv)
		t := time.NewTimer(next.Sub(now))
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		c.Round(ctx, c.RoundID(next))
	}
}

// Round runs one complete round: probe, exchange, decide, reconcile (leader only).
func (c *Controller) Round(ctx context.Context, round int64) {
	c.mu.Lock()
	c.init()
	c.mu.Unlock()
	start := c.now()
	own := c.probeAll(ctx)
	c.mu.Lock()
	c.rounds[round] = own
	for r := range c.rounds {
		if r < round-10 {
			delete(c.rounds, r)
		}
	}
	c.mu.Unlock()

	views := [][]prober.Result{own}
	wait := c.PeerWait
	if wait == 0 {
		wait = c.Cfg.ProbeTimeout.Duration + 2*time.Second
	}
	wait = min(wait, c.Cfg.Interval.Duration*8/10)
	deadline := start.Add(wait)
	for _, p := range c.Peers {
		res, ok := c.fetchPeer(ctx, p, round, deadline)
		if ok {
			views = append(views, res)
			c.Metrics.Set("scf_health_controller_peer_reachable", 1, "peer", p.Name())
		} else {
			c.Metrics.Set("scf_health_controller_peer_reachable", 0, "peer", p.Name())
		}
	}

	leader := c.Elector.IsLeader()
	c.Metrics.Set("scf_health_controller_leader", b2f(leader), "controller", c.Cfg.Instance)
	c.mu.Lock()
	if leader && !c.wasLeader {
		c.hydrated = false // a new leader starts from what is published
	}
	c.wasLeader = leader
	c.mu.Unlock()
	if leader && !c.hydrated {
		c.hydrate(ctx)
	}
	c.decide(views)
	if leader {
		c.reconcile(ctx)
	}
	c.Metrics.Add("scf_health_controller_rounds_total", 1, "controller", c.Cfg.Instance)
	c.Metrics.Set("scf_health_controller_last_round_timestamp_seconds", float64(c.now().Unix()))
}

func (c *Controller) probeAll(ctx context.Context) []prober.Result {
	out := make([]prober.Result, len(c.Cfg.Nodes))
	var wg sync.WaitGroup
	for i, n := range c.Cfg.Nodes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, c.Cfg.ProbeTimeout.Duration)
			defer cancel()
			r := c.Prober.Probe(pctx, n)
			r.Node = n.ID
			out[i] = r
			c.Metrics.Set("scf_health_controller_node_probe_ok", b2f(r.OK), "node", n.ID)
			if r.OK && n.IngestURL != "" && c.Cfg.Canary != nil {
				c.Metrics.Add("scf_probe_canary_accepted_total", 1, "source", c.Cfg.Instance, "path", "/canary/"+c.Cfg.Instance+"/"+n.ID)
			}
		}()
	}
	wg.Wait()
	return out
}

func (c *Controller) fetchPeer(ctx context.Context, p PeerSource, round int64, deadline time.Time) ([]prober.Result, bool) {
	for {
		fctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		res, ok := p.Fetch(fctx, round)
		cancel()
		if ok {
			return res, true
		}
		if c.now().Add(250*time.Millisecond).After(deadline) || ctx.Err() != nil {
			return nil, false
		}
		select {
		case <-ctx.Done():
			return nil, false
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// decide applies the round rules to the merged views.
func (c *Controller) decide(views [][]prober.Result) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, n := range c.Cfg.Nodes {
		st := c.nodes[n.ID]
		seen, fails := 0, 0
		for _, v := range views {
			for _, r := range v {
				if r.Node == n.ID {
					seen++
					if !r.OK {
						fails++
					}
				}
			}
		}
		switch {
		case seen > 0 && fails == seen:
			st.failStreak++
			st.goodStreak = 0
		case seen > 0 && fails == 0:
			st.goodStreak++
			st.failStreak = 0
		default: // mixed views, or nobody saw the node: neither streak continues
			st.failStreak, st.goodStreak = 0, 0
		}
		before := st.up
		if st.up && st.failStreak >= c.Cfg.FailRounds {
			st.up = false
		} else if !st.up && st.goodStreak >= c.Cfg.RecoverRounds {
			st.up = true
		}
		if before != st.up {
			to := "down"
			if st.up {
				to = "up"
			}
			c.Metrics.Add("scf_health_controller_node_transitions_total", 1, "node", n.ID, "to", to)
			c.log().Info("node verdict changed", "node", n.ID, "to", to)
		}
		c.Metrics.Set("scf_health_controller_node_up", b2f(st.up), "node", n.ID)
	}
	// Membership per hostname, with the last-address guard per record type.
	for _, h := range c.Cfg.Hostnames {
		for _, t := range []dns.Type{dns.A, dns.AAAA} {
			has := func(id string) bool { return addrOf(c.Cfg, id, t).IsValid() }
			prev := c.members[h.Name][t]
			next := map[string]bool{}
			for _, id := range h.Nodes {
				if c.nodes[id].up && has(id) {
					next[id] = true
				}
			}
			kept := false
			if len(next) == 0 {
				for _, id := range h.Nodes {
					if prev[id] && has(id) {
						next[id], kept = true, true
					}
				}
				if !kept { // nothing of this type was published before either: publish every node of the type
					for _, id := range h.Nodes {
						if has(id) {
							next[id], kept = true, true
						}
					}
				}
			}
			c.members[h.Name][t] = next
			c.Metrics.Set("scf_health_controller_last_address_kept", b2f(kept), "hostname", h.Name, "type", string(t))
			c.Metrics.Set("scf_health_controller_record_members", float64(len(c.desiredLocked(h, t))), "hostname", h.Name, "type", string(t))
		}
	}
}

func (c *Controller) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}

func addrOf(cfg *config.Config, id string, t dns.Type) netip.Addr {
	n, ok := cfg.Node(id)
	if !ok {
		return netip.Addr{}
	}
	s := n.IPv4
	if t == dns.AAAA {
		s = n.IPv6
	}
	if s == "" {
		return netip.Addr{}
	}
	a, _ := netip.ParseAddr(s)
	return a
}

func (c *Controller) desiredLocked(h config.Hostname, t dns.Type) []netip.Addr {
	var out []netip.Addr
	for _, id := range h.Nodes {
		if c.members[h.Name][t][id] {
			if a := addrOf(c.Cfg, id, t); a.IsValid() {
				out = append(out, a)
			}
		}
	}
	return dns.Normalize(out)
}

// Desired returns the desired set (tests and the status endpoint).
func (c *Controller) Desired(hostname string, t dns.Type) []netip.Addr {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, h := range c.Cfg.Hostnames {
		if h.Name == hostname {
			return c.desiredLocked(h, t)
		}
	}
	return nil
}

// NodeUp reports the verdict for a node (tests).
func (c *Controller) NodeUp(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.init()
	return c.nodes[id].up
}

// hydrate starts from what is published: a node whose address is published at any reachable provider is a member,
// and a node published nowhere is down (it must earn RecoverRounds good rounds first). With no provider reachable the
// configured inventory stands.
func (c *Controller) hydrate(ctx context.Context) {
	type key struct {
		host string
		t    dns.Type
		node string
	}
	present := map[key]bool{}
	reached := false
	for _, p := range c.Providers {
		pctx, cancel := context.WithTimeout(ctx, c.Cfg.ProviderTimeout.Duration)
		ok := true
		for _, h := range c.Cfg.Hostnames {
			for _, t := range []dns.Type{dns.A, dns.AAAA} {
				addrs, err := p.GetRecords(pctx, h.Zone, h.Name, t)
				if err != nil && !errors.Is(err, dns.ErrNotFound) {
					ok = false
					continue
				}
				for _, id := range h.Nodes {
					if a := addrOf(c.Cfg, id, t); a.IsValid() && slices.Contains(addrs, a) {
						present[key{h.Name, t, id}] = true
					}
				}
			}
		}
		cancel()
		reached = reached || ok
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !reached {
		c.hydrated = true
		return
	}
	published := map[string]bool{}
	for _, h := range c.Cfg.Hostnames {
		for _, t := range []dns.Type{dns.A, dns.AAAA} {
			m := map[string]bool{}
			for _, id := range h.Nodes {
				if present[key{h.Name, t, id}] {
					m[id] = true
					published[id] = true
				}
			}
			c.members[h.Name][t] = m
		}
	}
	for id, st := range c.nodes {
		if !published[id] && st.up && st.goodStreak < c.Cfg.RecoverRounds {
			st.up = false
		}
	}
	c.hydrated = true
}

// reconcile writes every provider concurrently; each provider has its own deadline, so a hanging or failing API
// cannot delay the other.
func (c *Controller) reconcile(ctx context.Context) {
	type want struct {
		h     config.Hostname
		t     dns.Type
		addrs []netip.Addr
	}
	var wants []want
	c.mu.Lock()
	for _, h := range c.Cfg.Hostnames {
		for _, t := range []dns.Type{dns.A, dns.AAAA} {
			if a := c.desiredLocked(h, t); len(a) > 0 {
				wants = append(wants, want{h, t, a})
			}
		}
	}
	c.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range c.Providers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, c.Cfg.ProviderTimeout.Duration)
			defer cancel()
			ok := true
			for _, w := range wants {
				cur, err := p.GetRecords(pctx, w.h.Zone, w.h.Name, w.t)
				if err != nil && !errors.Is(err, dns.ErrNotFound) {
					ok = false
					c.Metrics.Add("scf_health_controller_provider_errors_total", 1, "provider", p.Name())
					c.log().Warn("provider read failed", "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t))
					continue
				}
				if dns.Equal(cur, w.addrs) {
					c.Metrics.Set("scf_health_controller_dns_drift", 0, "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t))
					continue
				}
				reason := classify(cur, w.addrs)
				if reason == "drift" {
					c.Metrics.Set("scf_health_controller_dns_drift", 1, "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t))
				}
				if err := p.SetRecords(pctx, w.h.Zone, w.h.Name, w.t, w.h.TTL, w.addrs); err != nil {
					ok = false
					c.Metrics.Add("scf_health_controller_provider_errors_total", 1, "provider", p.Name())
					c.log().Warn("provider write failed", "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t))
					continue
				}
				c.Metrics.Set("scf_health_controller_dns_drift", 0, "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t))
				c.Metrics.Add("scf_health_controller_dns_writes_total", 1, "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t), "reason", reason)
				c.log().Info("record set written", "provider", p.Name(), "hostname", w.h.Name, "type", string(w.t),
					"reason", reason, "nodes", c.nodesFor(w.h, w.t, w.addrs))
			}
			c.Metrics.Set("scf_health_controller_provider_up", b2f(ok), "provider", p.Name())
		}()
	}
	wg.Wait()
}

// classify names a write: a pure removal or addition of addresses, or anything else (drift).
func classify(cur, want []netip.Addr) string {
	added, removed := false, false
	for _, a := range want {
		if !slices.Contains(cur, a) {
			added = true
		}
	}
	for _, a := range cur {
		if !slices.Contains(want, a) {
			removed = true
		}
	}
	switch {
	case removed && !added:
		return "remove"
	case added && !removed:
		return "add"
	default:
		return "drift"
	}
}

func (c *Controller) nodesFor(h config.Hostname, t dns.Type, addrs []netip.Addr) []string {
	var out []string
	for _, id := range h.Nodes {
		if a := addrOf(c.Cfg, id, t); a.IsValid() && slices.Contains(addrs, a) {
			out = append(out, id)
		}
	}
	return out
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}
