// SPDX-License-Identifier: Apache-2.0

// Package integration runs the real binaries: two health-controller processes elected through a real etcd (Docker),
// two fake DNS provider processes, and four fake edge nodes that speak the tracker protocol (the gateway's probe
// client runs unmodified against them). Host ports 56320–56330.
//
//	go test -count=1 ./integration/                       # 2 s rounds (fast)
//	SCF_HC_REALTIME=1 go test -count=1 -timeout 15m ./integration/   # production timing: 30 s rounds, removal ≤ 2 min
//
// Without Docker the suite fails unless SCF_SKIP_DOCKER_TESTS=1.
package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/dns"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/election"
	"github.com/bytemaster333/usagemap/services/health-controller/internal/fakeedge"
)

const (
	etcdImage    = "quay.io/coreos/etcd:v3.6.6@sha256:ea8a4698f22200bf0322fd8ed6e0b106a3107db649bd61f654e1a9fc14d9a17e"
	etcdPort     = 56320
	dnsAPort     = 56321
	dnsBPort     = 56322
	edgeBase     = 56327
	hcPeerBase   = 56323 // 56323, 56324
	hcMetricBase = 56325 // 56325, 56326
)

var edges = []struct{ id, v4 string }{
	{"edge-a1", "192.0.2.1"}, {"edge-a2", "192.0.2.2"}, {"edge-b1", "198.51.100.1"}, {"edge-b2", "198.51.100.2"},
}

func docker(t *testing.T) bool {
	t.Helper()
	if os.Getenv("SCF_SKIP_DOCKER_TESTS") == "1" {
		t.Skip("SCF_SKIP_DOCKER_TESTS=1")
	}
	if err := exec.Command("docker", "version").Run(); err != nil {
		t.Fatal("Docker is required (set SCF_SKIP_DOCKER_TESTS=1 to skip)")
	}
	return true
}

func startEtcd(t *testing.T) string {
	t.Helper()
	name := fmt.Sprintf("scf-wsj1-hc-etcd-%d", os.Getpid())
	out, err := exec.Command("docker", "run", "-d", "--rm", "--name", name,
		"--label", "com.docker.compose.project=scf-wsj1-hc",
		"-p", fmt.Sprintf("127.0.0.1:%d:2379", etcdPort), etcdImage,
		"etcd", "--name", "e1", "--data-dir", "/tmp/etcd",
		"--listen-client-urls", "http://0.0.0.0:2379", "--advertise-client-urls", "http://127.0.0.1:2379",
		"--listen-peer-urls", "http://127.0.0.1:2380", "--initial-advertise-peer-urls", "http://127.0.0.1:2380",
		"--initial-cluster", "e1=http://127.0.0.1:2380").CombinedOutput()
	if err != nil {
		t.Fatalf("etcd: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	url := fmt.Sprintf("http://127.0.0.1:%d", etcdPort)
	waitFor(t, 30*time.Second, func() bool {
		resp, err := http.Get(url + "/health")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == 200
	})
	return url
}

func waitFor(t *testing.T, d time.Duration, f func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("condition not met within %v", d)
}

// flaky lets a test cut an elector off from etcd (a partition), without a clean lease revoke.
type flaky struct {
	cut atomic
	rt  http.RoundTripper
}

type atomic struct {
	mu sync.Mutex
	v  bool
}

func (a *atomic) set(v bool) { a.mu.Lock(); a.v = v; a.mu.Unlock() }
func (a *atomic) get() bool  { a.mu.Lock(); defer a.mu.Unlock(); return a.v }

func (f *flaky) RoundTrip(r *http.Request) (*http.Response, error) {
	if f.cut.get() {
		return nil, errors.New("partitioned")
	}
	return f.rt.RoundTrip(r)
}

func TestEtcdElectionFailoverWithoutOverlap(t *testing.T) {
	docker(t)
	url := startEtcd(t)
	ttl := 3 * time.Second
	mk := func(name string) (*election.Etcd, *flaky) {
		fl := &flaky{rt: http.DefaultTransport}
		return &election.Etcd{Endpoints: []string{url}, Client: &http.Client{Timeout: time.Second, Transport: fl},
			Key: "/scf/test/leader", Instance: name, TTL: ttl}, fl
	}
	a, fa := mk("mon-c")
	b, _ := mk("core-b")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx)
	waitFor(t, 10*time.Second, a.IsLeader)
	go b.Run(ctx)

	// Exactly one leader for a while.
	var overlap bool
	stop := time.Now().Add(2 * ttl)
	for time.Now().Before(stop) {
		if a.IsLeader() && b.IsLeader() {
			overlap = true
		}
		time.Sleep(20 * time.Millisecond)
	}
	if overlap || !a.IsLeader() || b.IsLeader() {
		t.Fatalf("steady state: a=%v b=%v overlap=%v", a.IsLeader(), b.IsLeader(), overlap)
	}

	// Partition the leader: it must give up before (or when) the other takes over, never both at once.
	fa.cut.set(true)
	cutAt := time.Now()
	deadline := time.Now().Add(4 * ttl)
	for time.Now().Before(deadline) && !b.IsLeader() {
		if a.IsLeader() && b.IsLeader() {
			t.Fatal("two leaders at once")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !b.IsLeader() {
		t.Fatal("no failover")
	}
	if a.IsLeader() {
		t.Fatal("old leader still believes it leads")
	}
	t.Logf("failover after %v (lease TTL %v)", time.Since(cutAt).Round(100*time.Millisecond), ttl)
}

// ---- process-level test -------------------------------------------------------------------------------------

func buildBinaries(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, c := range []string{"health-controller", "fake-dns-provider"} {
		cmd := exec.Command("go", "build", "-o", filepath.Join(dir, c), "./cmd/"+c)
		cmd.Dir = ".."
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v %s", c, err, out)
		}
	}
	return dir
}

type proc struct {
	cmd *exec.Cmd
	out *strings.Builder
	mu  sync.Mutex
}

func (p *proc) Write(b []byte) (int, error) { p.mu.Lock(); defer p.mu.Unlock(); return p.out.Write(b) }
func (p *proc) String() string              { p.mu.Lock(); defer p.mu.Unlock(); return p.out.String() }

func start(t *testing.T, bin string, args ...string) *proc {
	t.Helper()
	p := &proc{out: &strings.Builder{}}
	p.cmd = exec.Command(bin, args...)
	p.cmd.Stdout, p.cmd.Stderr = p, p
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
	})
	return p
}

// edgeNode is a fake edge on a fixed port that can be killed and restarted.
type edgeNode struct {
	port int
	srv  *http.Server
	h    *fakeedge.Edge
}

func (e *edgeNode) up(t *testing.T) {
	t.Helper()
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", e.port))
	if err != nil {
		t.Fatal(err)
	}
	e.srv = &http.Server{Handler: e.h, ReadHeaderTimeout: time.Second}
	go func() { _ = e.srv.Serve(ln) }()
}

func (e *edgeNode) kill() { _ = e.srv.Close() }

func sets(t *testing.T, port int) map[string]dns.RRSet {
	t.Helper()
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/admin/sets", port))
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var m map[string]dns.RRSet
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return m
}

func published(t *testing.T, port int) []string {
	rr := sets(t, port)["domain-a.test|in.domain-a.test|A"]
	out := slices.Clone(rr.Records)
	slices.Sort(out)
	return out
}

func post(t *testing.T, url string) {
	t.Helper()
	resp, err := http.Post(url, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func metricValue(port int, line string) bool {
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/metrics", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return strings.Contains(string(b), line)
}

func TestKillEdgeRemovesAndRestores(t *testing.T) {
	docker(t)
	realtime := os.Getenv("SCF_HC_REALTIME") == "1"
	interval, probeTimeout, removeWithin := 2*time.Second, time.Second, 4*2*time.Second+3*time.Second
	if realtime {
		interval, probeTimeout, removeWithin = 30*time.Second, 5*time.Second, 2*time.Minute
	}
	etcd := startEtcd(t)
	bin := buildBinaries(t)
	dir := t.TempDir()

	all := []string{"192.0.2.1", "192.0.2.2", "198.51.100.1", "198.51.100.2"}
	seed := "domain-a.test|in.domain-a.test|A|60|" + strings.Join(all, ",")
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("dns-test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	start(t, filepath.Join(bin, "fake-dns-provider"), "-listen", fmt.Sprintf("127.0.0.1:%d", dnsAPort), "-token-file", filepath.Join(dir, "token"), "-seed", seed)
	start(t, filepath.Join(bin, "fake-dns-provider"), "-listen", fmt.Sprintf("127.0.0.1:%d", dnsBPort), "-token-file", filepath.Join(dir, "token"), "-seed", seed)

	nodes := make([]*edgeNode, len(edges))
	var nodeCfg []map[string]any
	for i, e := range edges {
		nodes[i] = &edgeNode{port: edgeBase + i, h: &fakeedge.Edge{}}
		nodes[i].up(t)
		base := fmt.Sprintf("http://127.0.0.1:%d", edgeBase+i)
		nodeCfg = append(nodeCfg, map[string]any{"id": e.id, "ipv4": e.v4, "health_url": base + "/healthz", "ingest_url": base})
	}
	t.Cleanup(func() {
		for _, n := range nodes {
			n.kill()
		}
	})
	hcs := map[string]*proc{}
	for i, inst := range []string{"mon-c", "core-b"} {
		peer := fmt.Sprintf("http://127.0.0.1:%d", hcPeerBase+1-i)
		cfg := map[string]any{
			"instance": inst, "interval": interval.String(), "probe_timeout": probeTimeout.String(), "provider_timeout": "3s",
			"nodes": nodeCfg,
			"hostnames": []any{map[string]any{"name": "in.domain-a.test", "zone": "domain-a.test", "ttl": 60,
				"nodes": []string{"edge-a1", "edge-a2", "edge-b1", "edge-b2"}}},
			"providers": []any{
				map[string]any{"name": "dns-a", "kind": "http", "endpoint": fmt.Sprintf("http://127.0.0.1:%d", dnsAPort), "token_file": filepath.Join(dir, "token")},
				map[string]any{"name": "dns-b", "kind": "http", "endpoint": fmt.Sprintf("http://127.0.0.1:%d", dnsBPort), "token_file": filepath.Join(dir, "token")},
			},
			"canary": map[string]any{"site_key": "0123456789abcdefghijkl", "origin": "https://canary.test"},
			"peers":  []string{peer},
		}
		b, _ := json.Marshal(cfg)
		path := filepath.Join(dir, inst+".json")
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
		hcs[inst] = start(t, filepath.Join(bin, "health-controller"), "-config", path,
			"-listen", fmt.Sprintf("127.0.0.1:%d", hcPeerBase+i), "-metrics", fmt.Sprintf("127.0.0.1:%d", hcMetricBase+i),
			"-etcd", etcd, "-etcd-ttl", "6s")
		if i == 0 {
			// mon-c campaigns first and leads.
			waitFor(t, 15*time.Second+2*interval, func() bool { return metricValue(hcMetricBase, `scf_health_controller_leader{controller="mon-c"} 1`) })
		}
	}
	defer func() {
		if t.Failed() {
			for k, p := range hcs {
				t.Logf("--- %s\n%s", k, p.String())
			}
		}
	}()

	// 1. Kill edge-b1: removed at both providers within the bound.
	nodes[2].kill()
	killed := time.Now()
	want := []string{"192.0.2.1", "192.0.2.2", "198.51.100.2"}
	waitFor(t, removeWithin+interval, func() bool {
		return slices.Equal(published(t, dnsAPort), want) && slices.Equal(published(t, dnsBPort), want)
	})
	took := time.Since(killed)
	t.Logf("edge-b1 removed at both providers after %v (bound %v, interval %v)", took.Round(time.Second), removeWithin, interval)
	if took > removeWithin {
		t.Fatalf("removal took %v > %v", took, removeWithin)
	}

	// 2. Provider B's API goes down; edge-a2 dies: provider A is still updated.
	post(t, fmt.Sprintf("http://127.0.0.1:%d/admin/down", dnsBPort))
	nodes[1].kill()
	want2 := []string{"192.0.2.1", "198.51.100.2"}
	waitFor(t, removeWithin+interval, func() bool { return slices.Equal(published(t, dnsAPort), want2) })
	waitFor(t, 2*interval, func() bool {
		return metricValue(hcMetricBase, `scf_health_controller_provider_up{provider="dns-b"} 0`)
	})

	// 3. Provider B returns: it catches up.
	post(t, fmt.Sprintf("http://127.0.0.1:%d/admin/up", dnsBPort))
	waitFor(t, 3*interval, func() bool { return slices.Equal(published(t, dnsBPort), want2) })

	// 4. Kill the leader process (SIGKILL, no lease revoke): core-b takes over and keeps managing DNS.
	_ = hcs["mon-c"].cmd.Process.Signal(syscall.SIGKILL)
	waitFor(t, 20*time.Second+interval, func() bool {
		return metricValue(hcMetricBase+1, `scf_health_controller_leader{controller="core-b"} 1`)
	})

	// 5. edge-b1 recovers: re-added after five good rounds, at both providers.
	nodes[2].up(t)
	recovered := time.Now()
	want3 := []string{"192.0.2.1", "198.51.100.1", "198.51.100.2"}
	waitFor(t, 7*interval+10*time.Second, func() bool {
		return slices.Equal(published(t, dnsAPort), want3) && slices.Equal(published(t, dnsBPort), want3)
	})
	t.Logf("edge-b1 re-added after %v", time.Since(recovered).Round(time.Second))

	// 6. Every edge dies: the last address is never removed.
	for _, i := range []int{0, 2, 3} {
		nodes[i].kill()
	}
	time.Sleep(5 * interval)
	for _, p := range []int{dnsAPort, dnsBPort} {
		if got := published(t, p); len(got) == 0 {
			t.Fatalf("provider %d: record set emptied", p)
		}
	}
	if !metricValue(hcMetricBase+1, `scf_health_controller_last_address_kept{hostname="in.domain-a.test",type="A"} 1`) {
		t.Fatal("last-address guard not reported")
	}
	// Privacy: logs carry node ids and closed words, never addresses or tokens.
	for k, p := range hcs {
		if s := p.String(); strings.Contains(s, "dns-test-token") || strings.Contains(s, "192.0.2.") {
			t.Fatalf("%s logged a token or an address", k)
		}
	}
}
