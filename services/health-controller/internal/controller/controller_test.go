// SPDX-License-Identifier: Apache-2.0

package controller

import (
	"context"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/config"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/dns"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/election"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/metrics"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/prober"
)

const cfgJSON = `{
  "instance": "mon-c", "interval": "30s", "probe_timeout": "5s", "provider_timeout": "1s",
  "nodes": [
    {"id": "edge-a1", "ipv4": "192.0.2.1", "ipv6": "2001:db8:a::1", "health_url": "http://edge-a1:9464/healthz"},
    {"id": "edge-a2", "ipv4": "192.0.2.2", "ipv6": "2001:db8:a::2", "health_url": "http://edge-a2:9464/healthz"},
    {"id": "edge-b1", "ipv4": "198.51.100.1", "health_url": "http://edge-b1:9464/healthz"},
    {"id": "edge-b2", "ipv4": "198.51.100.2", "health_url": "http://edge-b2:9464/healthz"}
  ],
  "hostnames": [
    {"name": "in.domain-a.test", "zone": "domain-a.test", "ttl": 60, "nodes": ["edge-a1", "edge-a2", "edge-b1", "edge-b2"]},
    {"name": "in.domain-b.test", "zone": "domain-b.test", "ttl": 60, "nodes": ["edge-a1", "edge-a2", "edge-b1", "edge-b2"]}
  ],
  "providers": [{"name": "dns-a", "kind": "memory"}, {"name": "dns-b", "kind": "memory"}]
}`

var all4 = []string{"192.0.2.1", "192.0.2.2", "198.51.100.1", "198.51.100.2"}

func addrs(s ...string) []netip.Addr {
	var out []netip.Addr
	for _, x := range s {
		out = append(out, netip.MustParseAddr(x))
	}
	return dns.Normalize(out)
}

type health struct {
	mu   sync.Mutex
	down map[string]bool
}

func (h *health) set(node string, down bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.down[node] = down
}

func (h *health) probe(_ context.Context, n config.Node) prober.Result {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.down[n.ID] {
		return prober.Result{Node: n.ID, Reason: "health_failed"}
	}
	return prober.Result{Node: n.ID, OK: true, Reason: "ok"}
}

// staticPeer replays a fixed view: nodes listed in down fail, all others pass; reachable=false means no answer.
type staticPeer struct {
	mu        sync.Mutex
	down      map[string]bool
	reachable bool
	cfg       *config.Config
}

func (p *staticPeer) Name() string { return "core-b" }
func (p *staticPeer) Fetch(_ context.Context, _ int64) ([]prober.Result, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.reachable {
		return nil, false
	}
	var out []prober.Result
	for _, n := range p.cfg.Nodes {
		out = append(out, prober.Result{Node: n.ID, OK: !p.down[n.ID]})
	}
	return out, true
}

type fixture struct {
	c      *Controller
	h      *health
	peer   *staticPeer
	a, b   *dns.Memory
	round  int64
	leader *election.Static
}

func newFixture(t *testing.T, seed bool) *fixture {
	t.Helper()
	cfg, err := config.Parse([]byte(cfgJSON))
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{h: &health{down: map[string]bool{}}, a: dns.NewMemory("dns-a"), b: dns.NewMemory("dns-b")}
	f.peer = &staticPeer{down: map[string]bool{}, reachable: true, cfg: cfg}
	if seed {
		for _, p := range []*dns.Memory{f.a, f.b} {
			for _, h := range cfg.Hostnames {
				p.Seed(h.Zone, h.Name, dns.A, addrs(all4...)...)
				p.Seed(h.Zone, h.Name, dns.AAAA, addrs("2001:db8:a::1", "2001:db8:a::2")...)
			}
		}
	}
	reg := metrics.New()
	Describe(reg)
	f.c = &Controller{Cfg: cfg, Prober: prober.Func(f.h.probe), Providers: []dns.Provider{f.a, f.b},
		Peers: []PeerSource{f.peer}, Elector: election.Static{Leader: true}, Metrics: reg, PeerWait: 50 * time.Millisecond}
	return f
}

func (f *fixture) rounds(n int) {
	for range n {
		f.round++
		f.c.Round(context.Background(), f.round)
	}
}

func (f *fixture) published(t *testing.T, p *dns.Memory, host string, typ dns.Type) []netip.Addr {
	t.Helper()
	got, err := p.GetRecords(context.Background(), "domain-a.test", host, typ)
	if err != nil && typ == dns.A {
		t.Fatalf("%s: %v", p.Name(), err)
	}
	return got
}

func (f *fixture) downBoth(node string, down bool) {
	f.h.set(node, down)
	f.peer.mu.Lock()
	f.peer.down[node] = down
	f.peer.mu.Unlock()
}

func TestRemovedAfterThreeFailedRoundsSeenByBoth(t *testing.T) {
	f := newFixture(t, true)
	f.rounds(1)
	f.downBoth("edge-a1", true)
	f.rounds(2)
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); !dns.Equal(got, addrs(all4...)) {
		t.Fatalf("removed after 2 rounds: %v", got)
	}
	f.rounds(1)
	want := addrs("192.0.2.2", "198.51.100.1", "198.51.100.2")
	for _, p := range []*dns.Memory{f.a, f.b} {
		if got := f.published(t, p, "in.domain-a.test", dns.A); !dns.Equal(got, want) {
			t.Fatalf("%s A after 3 failed rounds = %v, want %v", p.Name(), got, want)
		}
		if got := f.published(t, p, "in.domain-a.test", dns.AAAA); !dns.Equal(got, addrs("2001:db8:a::2")) {
			t.Fatalf("%s AAAA = %v", p.Name(), got)
		}
	}
	if f.c.Metrics.Get("scf_health_controller_dns_writes_total", "provider", "dns-a", "hostname", "in.domain-a.test", "type", "A", "reason", "remove") != 1 {
		t.Fatal("remove write not counted")
	}
	if f.c.Metrics.Get("scf_health_controller_node_up", "node", "edge-a1") != 0 {
		t.Fatal("node_up metric")
	}
}

func TestMixedViewsDoNotRemove(t *testing.T) {
	f := newFixture(t, true)
	f.h.set("edge-a1", true) // only this instance sees it fail
	f.rounds(10)
	if !f.c.NodeUp("edge-a1") {
		t.Fatal("node removed although the peer saw it healthy")
	}
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); !dns.Equal(got, addrs(all4...)) {
		t.Fatalf("changed: %v", got)
	}
}

func TestPeerUnreachableOwnViewDecides(t *testing.T) {
	f := newFixture(t, true)
	f.peer.reachable = false
	f.h.set("edge-b2", true)
	f.rounds(3)
	if f.c.NodeUp("edge-b2") {
		t.Fatal("with the peer down, the own view must decide")
	}
	if f.c.Metrics.Get("scf_health_controller_peer_reachable", "peer", "core-b") != 0 {
		t.Fatal("peer_reachable metric")
	}
}

func TestRestoredAfterFiveGoodRounds(t *testing.T) {
	f := newFixture(t, true)
	f.downBoth("edge-a2", true)
	f.rounds(3)
	if f.c.NodeUp("edge-a2") {
		t.Fatal("not removed")
	}
	f.downBoth("edge-a2", false)
	f.rounds(4)
	if f.c.NodeUp("edge-a2") {
		t.Fatal("restored after 4 good rounds")
	}
	f.rounds(1)
	if !f.c.NodeUp("edge-a2") {
		t.Fatal("not restored after 5 good rounds")
	}
	for _, p := range []*dns.Memory{f.a, f.b} {
		if got := f.published(t, p, "in.domain-a.test", dns.A); !dns.Equal(got, addrs(all4...)) {
			t.Fatalf("%s after recovery: %v", p.Name(), got)
		}
	}
}

func TestFlappingResetsStreaks(t *testing.T) {
	f := newFixture(t, true)
	for range 5 {
		f.downBoth("edge-a1", true)
		f.rounds(2)
		f.downBoth("edge-a1", false)
		f.rounds(1)
	}
	if !f.c.NodeUp("edge-a1") {
		t.Fatal("two failed rounds at a time must never remove")
	}
}

func TestLastAddressNeverRemoved(t *testing.T) {
	f := newFixture(t, true)
	for _, n := range []string{"edge-a1", "edge-a2", "edge-b1", "edge-b2"} {
		f.downBoth(n, true)
	}
	f.rounds(6)
	for _, p := range []*dns.Memory{f.a, f.b} {
		a := f.published(t, p, "in.domain-a.test", dns.A)
		if len(a) == 0 {
			t.Fatalf("%s: A set emptied", p.Name())
		}
		aaaa := f.published(t, p, "in.domain-a.test", dns.AAAA)
		if len(aaaa) == 0 {
			t.Fatalf("%s: AAAA set emptied", p.Name())
		}
	}
	if f.c.Metrics.Get("scf_health_controller_last_address_kept", "hostname", "in.domain-a.test", "type", "A") != 1 {
		t.Fatal("guard metric not set")
	}
	for _, ch := range append(f.a.Changes(), f.b.Changes()...) {
		if len(ch.Addrs) == 0 {
			t.Fatal("an empty set was written")
		}
	}
}

func TestLastAddressPerTypeKeepsTheFailingIPv6Node(t *testing.T) {
	f := newFixture(t, true)
	// Both IPv6-capable nodes fail; the IPv4-only nodes stay healthy. The AAAA set must keep an address.
	f.downBoth("edge-a1", true)
	f.downBoth("edge-a2", true)
	f.rounds(3)
	a := f.published(t, f.a, "in.domain-a.test", dns.A)
	if !dns.Equal(a, addrs("198.51.100.1", "198.51.100.2")) {
		t.Fatalf("A = %v", a)
	}
	aaaa := f.published(t, f.a, "in.domain-a.test", dns.AAAA)
	if len(aaaa) == 0 {
		t.Fatal("AAAA emptied")
	}
}

func TestOneProviderDownDoesNotBlockTheOther(t *testing.T) {
	f := newFixture(t, true)
	f.b.SetDown(true)
	f.downBoth("edge-b1", true)
	f.rounds(3)
	want := addrs("192.0.2.1", "192.0.2.2", "198.51.100.2")
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); !dns.Equal(got, want) {
		t.Fatalf("dns-a not updated while dns-b is down: %v", got)
	}
	if f.c.Metrics.Get("scf_health_controller_provider_up", "provider", "dns-b") != 0 ||
		f.c.Metrics.Get("scf_health_controller_provider_errors_total", "provider", "dns-b") == 0 {
		t.Fatal("dns-b failure not reported")
	}
	f.b.SetDown(false)
	f.rounds(1)
	if got := f.published(t, f.b, "in.domain-a.test", dns.A); !dns.Equal(got, want) {
		t.Fatalf("dns-b not caught up after it came back: %v", got)
	}
}

// hanging blocks every call until its context ends.
type hanging struct{ name string }

func (h hanging) Name() string { return h.name }
func (h hanging) GetRecords(ctx context.Context, _, _ string, _ dns.Type) ([]netip.Addr, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (h hanging) SetRecords(ctx context.Context, _, _ string, _ dns.Type, _ int, _ []netip.Addr) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestHangingProviderDoesNotDelayTheOther(t *testing.T) {
	f := newFixture(t, true)
	f.c.Providers = []dns.Provider{hanging{"dns-x"}, f.a}
	f.downBoth("edge-b1", true)
	start := time.Now()
	f.rounds(3)
	if el := time.Since(start); el > 8*time.Second {
		t.Fatalf("rounds took %v", el)
	}
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); slices.Contains(got, netip.MustParseAddr("198.51.100.1")) {
		t.Fatalf("dns-a not updated: %v", got)
	}
}

func TestFollowerNeverWrites(t *testing.T) {
	f := newFixture(t, true)
	f.c.Elector = election.Static{Leader: false}
	f.downBoth("edge-a1", true)
	f.rounds(4)
	if len(f.a.Changes())+len(f.b.Changes()) != 0 {
		t.Fatal("follower wrote DNS")
	}
	if f.c.NodeUp("edge-a1") {
		t.Fatal("follower must still track verdicts (ready to take over)")
	}
}

func TestHydrateNodeNotPublishedMustEarnRecovery(t *testing.T) {
	f := newFixture(t, false)
	for _, p := range []*dns.Memory{f.a, f.b} {
		p.Seed("domain-a.test", "in.domain-a.test", dns.A, addrs("192.0.2.1", "192.0.2.2", "198.51.100.1")...)
		p.Seed("domain-b.test", "in.domain-b.test", dns.A, addrs("192.0.2.1", "192.0.2.2", "198.51.100.1")...)
	}
	f.rounds(1)
	if f.c.NodeUp("edge-b2") {
		t.Fatal("a node published nowhere must not be added at start")
	}
	f.rounds(4) // 5 good rounds in total
	if !f.c.NodeUp("edge-b2") {
		t.Fatal("not added after 5 good rounds")
	}
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); !dns.Equal(got, addrs(all4...)) {
		t.Fatalf("A = %v", got)
	}
}

func TestDriftIsCorrected(t *testing.T) {
	f := newFixture(t, true)
	f.rounds(1)
	f.a.Seed("domain-a.test", "in.domain-a.test", dns.A, addrs("192.0.2.1", "203.0.113.66")...)
	f.rounds(1)
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); !dns.Equal(got, addrs(all4...)) {
		t.Fatalf("drift not corrected: %v", got)
	}
	if f.c.Metrics.Get("scf_health_controller_dns_writes_total", "provider", "dns-a", "hostname", "in.domain-a.test", "type", "A", "reason", "drift") != 1 {
		t.Fatal("drift write not counted")
	}
}

func TestNewLeaderRehydrates(t *testing.T) {
	f := newFixture(t, true)
	el := &switchable{}
	f.c.Elector = el
	f.rounds(1)
	// While a follower, the other instance removed edge-a1 at both providers.
	for _, p := range []*dns.Memory{f.a, f.b} {
		for _, h := range f.c.Cfg.Hostnames {
			p.Seed(h.Zone, h.Name, dns.A, addrs("192.0.2.2", "198.51.100.1", "198.51.100.2")...)
			p.Seed(h.Zone, h.Name, dns.AAAA, addrs("2001:db8:a::2")...)
		}
	}
	el.set(true)
	f.rounds(1)
	if got := f.published(t, f.a, "in.domain-a.test", dns.A); slices.Contains(got, netip.MustParseAddr("192.0.2.1")) {
		t.Fatal("new leader re-added a node the old leader removed without 5 good rounds")
	}
}

type switchable struct {
	mu sync.Mutex
	v  bool
}

func (s *switchable) Run(ctx context.Context) { <-ctx.Done() }
func (s *switchable) IsLeader() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.v
}
func (s *switchable) set(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.v = v
}

func TestCanaryCounterExported(t *testing.T) {
	f := newFixture(t, true)
	f.c.Cfg.Canary = &config.Canary{SiteKey: "k", Origin: "https://canary.test"}
	f.c.Cfg.Nodes[0].IngestURL = "https://edge-a1.test"
	f.rounds(2)
	if f.c.Metrics.Get("scf_probe_canary_accepted_total", "source", "mon-c", "path", "/canary/mon-c/edge-a1") != 2 {
		t.Fatal("canary counter")
	}
}
