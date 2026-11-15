// SPDX-License-Identifier: Apache-2.0

package keys

import (
	"bytes"
	"context"
	"crypto/tls"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/testpki"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

func newRing(t *testing.T, c *clock) *Ring {
	r, err := NewRing(c.Now)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRingConflictKeepsSmallerFingerprint(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	r := newRing(t, c)
	a, b := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	small, large := a, b
	if Fingerprint(b) < Fingerprint(a) {
		small, large = b, a
	}
	id := DayID(c.Now())
	if res, _ := r.Put(Day, id, large); res != Adopted {
		t.Fatal("first key not adopted")
	}
	if res, _ := r.Put(Day, id, small); res != Conflict {
		t.Fatal("conflict not detected")
	}
	if !bytes.Equal(r.Copy(Day, id), small) {
		t.Fatal("smaller fingerprint must win")
	}
	if res, _ := r.Put(Day, id, large); res != Conflict || !bytes.Equal(r.Copy(Day, id), small) {
		t.Fatal("larger fingerprint must lose")
	}
	if r.Conflicts(Day) != 2 {
		t.Fatalf("conflicts %d", r.Conflicts(Day))
	}
}

func TestRingWindowAndPrune(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 23, 59, 0, 0, time.UTC)}
	r := newRing(t, c)
	var destroyed []string
	r.OnDestroy(func(k Kind, id string) { destroyed = append(destroyed, string(k)+":"+id) })
	k := bytes.Repeat([]byte{9}, 32)
	if res, _ := r.Put(Day, "2026-11-20", k); res != Unchanged {
		t.Fatal("a key outside the window must be refused")
	}
	for _, id := range []string{"2026-11-12", "2026-11-13"} {
		if res, _ := r.Put(Day, id, k); res != Adopted {
			t.Fatalf("%s not adopted", id)
		}
	}
	_, _ = r.Generate(Chal, ChalID(c.Now()))
	c.Set(time.Date(2026, 11, 13, 0, 0, 1, 0, time.UTC))
	r.Prune()
	if r.Has(Day, "2026-11-12") || !r.Has(Day, "2026-11-13") {
		t.Fatal("yesterday's key must be destroyed, today's kept")
	}
	if len(destroyed) != 1 || destroyed[0] != "day:2026-11-12" {
		t.Fatalf("destroyed %v", destroyed)
	}
	// chal of 23:00 is the previous hour now: kept; two hours later it is gone.
	c.Set(time.Date(2026, 11, 13, 1, 0, 1, 0, time.UTC))
	r.Prune()
	if r.Has(Chal, ChalID(time.Date(2026, 11, 12, 23, 0, 0, 0, time.UTC))) {
		t.Fatal("chal key older than the previous hour must be destroyed")
	}
}

func TestRingMalformed(t *testing.T) {
	c := &clock{t: time.Now()}
	r := newRing(t, c)
	if _, err := r.Put(Day, "../etc", bytes.Repeat([]byte{1}, 32)); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err := r.Put(Chal, ChalID(c.Now()), []byte{1}); err == nil {
		t.Fatal("short key accepted")
	}
}

type node struct {
	x   *Exchange
	srv *httptest.Server
}

func startNodes(t *testing.T, c *clock, names ...string) []*node {
	t.Helper()
	ca := testpki.NewCA()
	var nodes []*node
	for _, n := range names {
		cert := ca.Issue("edge", n, "127.0.0.1")
		x := &Exchange{Node: n, Ring: newRing(t, c), Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: c.Now, Client: NewClient(cert.TLS, ca.Pool)}
		srv := httptest.NewUnstartedServer(nil)
		srv.TLS = ServerTLS(cert.TLS, ca.Pool)
		nodes = append(nodes, &node{x: x, srv: srv})
	}
	for _, n := range nodes {
		n.srv.StartTLS()
		t.Cleanup(n.srv.Close)
	}
	for i, n := range nodes {
		for j, m := range nodes {
			if i != j {
				n.x.Peers = append(n.x.Peers, Peer{Name: m.x.Node, URL: m.srv.URL})
			}
		}
	}
	for _, n := range nodes {
		n.srv.Config.Handler = n.x.Handler()
	}
	return nodes
}

func TestExchangeStartupAdoptsPeerKeys(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1", "edge-a2", "edge-b1")
	ctx := context.Background()
	nodes[0].x.Maintain(ctx) // first node alone: generates
	if !nodes[0].x.Ring.HasCurrent() {
		t.Fatal("first node must generate when no peer has keys")
	}
	nodes[1].x.Maintain(ctx)
	nodes[2].x.Maintain(ctx)
	for _, k := range Kinds {
		id := ID(k, c.Now())
		want := nodes[0].x.Ring.Copy(k, id)
		for _, n := range nodes[1:] {
			if !bytes.Equal(n.x.Ring.Copy(k, id), want) {
				t.Fatalf("%s key differs on %s", k, n.x.Node)
			}
		}
	}
	if got := nodes[1].x.LiveNodes(); got != 3 {
		t.Fatalf("live nodes %d", got)
	}
}

func TestExchangeDailyRotationAndPush(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 23, 40, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1", "edge-a2")
	ctx := context.Background()
	for _, n := range nodes {
		n.x.Maintain(ctx)
	}
	nodes[1].x.Maintain(ctx) // edge-a2 now sees edge-a1 alive
	c.Set(time.Date(2026, 11, 12, 23, 50, 5, 0, time.UTC))
	nodes[1].x.Maintain(ctx) // not the generator (edge-a1 < edge-a2)
	tomorrow := "2026-11-13"
	if nodes[1].x.Ring.Has(Day, tomorrow) {
		t.Fatal("edge-a2 must not generate while edge-a1 is live")
	}
	nodes[0].x.Maintain(ctx) // generator: creates and pushes
	for _, n := range nodes {
		if !n.x.Ring.Has(Day, tomorrow) || !n.x.Ring.Has(Mult, tomorrow) {
			t.Fatalf("%s lacks tomorrow's keys after the push", n.x.Node)
		}
	}
	if !bytes.Equal(nodes[0].x.Ring.Copy(Day, tomorrow), nodes[1].x.Ring.Copy(Day, tomorrow)) {
		t.Fatal("tomorrow's key differs")
	}
	c.Set(time.Date(2026, 11, 13, 0, 0, 1, 0, time.UTC))
	for _, n := range nodes {
		n.x.Maintain(ctx)
		if n.x.Ring.Has(Day, "2026-11-12") {
			t.Fatal("yesterday's key survived rotation")
		}
		if !n.x.Ring.HasCurrent() {
			t.Fatal("current keys missing after the switch")
		}
	}
}

func TestExchangePartitionConflictConverges(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1", "edge-a2")
	// Partition: both start alone and generate.
	nodes[0].srv.Config.Handler = http.NotFoundHandler()
	nodes[1].srv.Config.Handler = http.NotFoundHandler()
	ctx := context.Background()
	nodes[0].x.Maintain(ctx)
	nodes[1].x.Maintain(ctx)
	id := DayID(c.Now())
	if bytes.Equal(nodes[0].x.Ring.Copy(Day, id), nodes[1].x.Ring.Copy(Day, id)) {
		t.Skip("random keys collided")
	}
	nodes[0].srv.Config.Handler = nodes[0].x.Handler()
	nodes[1].srv.Config.Handler = nodes[1].x.Handler()
	nodes[0].x.Maintain(ctx)
	nodes[1].x.Maintain(ctx)
	nodes[0].x.Maintain(ctx)
	if !bytes.Equal(nodes[0].x.Ring.Copy(Day, id), nodes[1].x.Ring.Copy(Day, id)) {
		t.Fatal("keys did not converge after the partition")
	}
	if nodes[0].x.Ring.Conflicts(Day)+nodes[1].x.Ring.Conflicts(Day) == 0 {
		t.Fatal("conflict not counted")
	}
}

func TestKeyxRefusesUnknownCaller(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1")
	nodes[0].x.Maintain(context.Background())
	nodes[0].srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	ca := testpki.NewCA() // a different CA
	stranger := ca.Issue("edge", "edge-a2")
	cl := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{stranger.TLS}, InsecureSkipVerify: true}}} //nolint:gosec
	resp, err := cl.Get(nodes[0].srv.URL + "/keyx/v1/keys")
	if err == nil {
		resp.Body.Close()
		t.Fatalf("a certificate from another CA must be refused, got %d", resp.StatusCode)
	}
}

// TestNoKeysOnDisk asserts that the key exchange never writes a file (keys are memory-only, C-04): a full exchange
// round runs with the working directory set to an empty temp dir, which must stay empty.
func TestNoKeysOnDisk(t *testing.T) {
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(wd) }()
	c := &clock{t: time.Date(2026, 11, 12, 23, 55, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1", "edge-a2")
	for i := 0; i < 3; i++ {
		for _, n := range nodes {
			n.x.Maintain(context.Background())
		}
	}
	var files []string
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			files = append(files, p)
		}
		return nil
	})
	if len(files) != 0 {
		t.Fatalf("files written: %v", files)
	}
	if !nodes[0].x.Ring.Locked() && !strings.Contains(os.Getenv("SCF_ALLOW_UNLOCKED"), "1") {
		t.Log("note: mlock unavailable in this environment (RLIMIT_MEMLOCK)")
	}
}

// C-124 (F12): a node that generates today's K_day itself (cold start, restart without a live peer) counts a
// regeneration; adopting a peer's key and the 23:50 hand-over of tomorrow's key do not. The public fingerprint is a
// short, domain-separated hash that differs from the exchange fingerprint and is equal across nodes sharing the key.
func TestKDayRegenerationCountedAndPublicFingerprint(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 23, 45, 0, 0, time.UTC)}
	nodes := startNodes(t, c, "edge-a1", "edge-a2")
	ctx := context.Background()
	nodes[0].x.Maintain(ctx) // alone with no keys: today's K_day generated → 1 regeneration
	if got := nodes[0].x.Stats().KDayRegenerated; got != 1 {
		t.Fatalf("regenerated %d, want 1", got)
	}
	nodes[1].x.Maintain(ctx) // adopts from edge-a1
	if got := nodes[1].x.Stats().KDayRegenerated; got != 0 {
		t.Fatalf("adopting node counted %d", got)
	}
	nodes[0].x.Maintain(ctx)
	c.Set(time.Date(2026, 11, 12, 23, 51, 0, 0, time.UTC))
	nodes[0].x.Maintain(ctx) // generator creates tomorrow's keys: a hand-over, not a regeneration
	if got := nodes[0].x.Stats().KDayRegenerated; got != 1 {
		t.Fatalf("hand-over counted as regeneration: %d", got)
	}
	today := "2026-11-12"
	fp0, fp1 := nodes[0].x.Ring.PublicFingerprintOf(Day, today), nodes[1].x.Ring.PublicFingerprintOf(Day, today)
	if len(fp0) != 16 || fp0 != fp1 {
		t.Fatalf("public fingerprints %q %q", fp0, fp1)
	}
	if strings.HasPrefix(Fingerprint(nodes[0].x.Ring.Copy(Day, today)), fp0) {
		t.Fatal("public fingerprint must not be a prefix of the exchange fingerprint")
	}
	if nodes[0].x.Ring.PublicFingerprintOf(Day, "2001-01-01") != "" {
		t.Fatal("absent key must give an empty fingerprint")
	}
	// A restarted node (fresh ring) with its peer alive adopts instead of regenerating.
	restarted := &Exchange{Node: "edge-a2", Ring: newRing(t, c), Log: nodes[1].x.Log, Now: c.Now, Client: nodes[1].x.Client, Peers: nodes[1].x.Peers}
	restarted.Maintain(ctx)
	if restarted.Stats().KDayRegenerated != 0 || restarted.Ring.PublicFingerprintOf(Day, today) != fp0 {
		t.Fatal("restart with a live peer must adopt today's K_day")
	}
}

func TestGeneratedAt(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)}
	r := newRing(t, c)
	if _, err := r.Generate(Chal, ChalID(c.Now())); err != nil {
		t.Fatal(err)
	}
	if !r.GeneratedAt(Chal, ChalID(c.Now())).Equal(c.Now()) {
		t.Fatal("self-generated key must carry its generation time")
	}
	if _, err := r.Put(Day, DayID(c.Now()), bytes.Repeat([]byte{3}, 32)); err != nil {
		t.Fatal(err)
	}
	if !r.GeneratedAt(Day, DayID(c.Now())).IsZero() || !r.GeneratedAt(Mult, "2001-01-01").IsZero() {
		t.Fatal("adopted or absent keys have no generation time")
	}
}
