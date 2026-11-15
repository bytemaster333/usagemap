// SPDX-License-Identifier: Apache-2.0

package keys

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Peer is another gateway node reachable on the private mesh.
type Peer struct {
	Name string // node id, the CN of its certificate
	URL  string // https://host:port of its keyx listener
}

type wireKey struct {
	Kind Kind   `json:"kind"`
	ID   string `json:"id"`
	Key  string `json:"key"`
	FP   string `json:"fp"`
}

type message struct {
	NodeID string    `json:"node_id"`
	Keys   []wireKey `json:"keys"`
}

var b64 = base64.RawURLEncoding

// Stats are exported as metrics.
type Stats struct {
	PeersLive  int
	Conflicts  map[Kind]int
	Generated  int
	Adopted    int
	PullErrors int
	// KDayRegenerated counts K_day keys for the current UTC day this node generated itself — outside the 23:50 UTC
	// hand-over, because no peer had one (C-04, C-124). Each one re-keys that day's visitor surrogates: visitors
	// already counted today are counted again (over-count of the day's uniques).
	KDayRegenerated int
}

// Exchange runs the scf-keyx/1 protocol for one node.
type Exchange struct {
	Node   string
	Ring   *Ring
	Peers  []Peer
	Client *http.Client // mTLS client with the node certificate; peer identity checked by VerifyPeer
	Log    *slog.Logger
	Now    func() time.Time
	// LiveWindow is how long a peer counts as live after its last successful exchange.
	LiveWindow time.Duration

	mu        sync.Mutex
	lastSeen  map[string]time.Time
	generated int
	adopted   int
	pullErrs  int
	kdayRegen int
	started   bool
}

func (x *Exchange) now() time.Time {
	if x.Now != nil {
		return x.Now()
	}
	return time.Now()
}

func (x *Exchange) liveWindow() time.Duration {
	if x.LiveWindow > 0 {
		return x.LiveWindow
	}
	return 90 * time.Second
}

// LiveNodes is 1 (this node) plus the peers that answered within the live window (§n: the count of live edge nodes
// for the rate-limit and quota shares, C-90).
func (x *Exchange) LiveNodes() int {
	x.mu.Lock()
	defer x.mu.Unlock()
	n := 1
	for _, t := range x.lastSeen {
		if x.now().Sub(t) <= x.liveWindow() {
			n++
		}
	}
	return n
}

func (x *Exchange) livePeers() []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	var out []string
	for name, t := range x.lastSeen {
		if x.now().Sub(t) <= x.liveWindow() {
			out = append(out, name)
		}
	}
	return out
}

// Stats snapshot.
func (x *Exchange) Stats() Stats {
	s := Stats{PeersLive: x.LiveNodes() - 1, Conflicts: map[Kind]int{}}
	for _, k := range Kinds {
		s.Conflicts[k] = x.Ring.Conflicts(k)
	}
	x.mu.Lock()
	s.Generated, s.Adopted, s.PullErrors, s.KDayRegenerated = x.generated, x.adopted, x.pullErrs, x.kdayRegen
	x.mu.Unlock()
	return s
}

func (x *Exchange) markSeen(peer string) {
	x.mu.Lock()
	if x.lastSeen == nil {
		x.lastSeen = map[string]time.Time{}
	}
	x.lastSeen[peer] = x.now()
	x.mu.Unlock()
}

func (x *Exchange) encode() ([]byte, func()) {
	ws := x.Ring.Export()
	m := message{NodeID: x.Node}
	for _, w := range ws {
		m.Keys = append(m.Keys, wireKey{Kind: w.Kind, ID: w.ID, Key: b64.EncodeToString(w.Key), FP: w.FP})
	}
	body, _ := json.Marshal(m)
	return body, func() {
		for _, w := range ws {
			clear(w.Key)
		}
		clear(body)
	}
}

// adopt applies a peer's message. Returns an error for a malformed message.
func (x *Exchange) adopt(body []byte) (string, error) {
	var m message
	if err := json.Unmarshal(body, &m); err != nil {
		return "", errors.New("keyx: malformed message")
	}
	for _, w := range m.Keys {
		key, err := b64.DecodeString(w.Key)
		if err != nil || len(key) != 32 || Fingerprint(key) != w.FP {
			clear(key)
			return m.NodeID, errors.New("keyx: malformed key")
		}
		res, err := x.Ring.Put(w.Kind, w.ID, key)
		clear(key)
		if err != nil {
			return m.NodeID, err
		}
		switch res {
		case Adopted:
			x.mu.Lock()
			x.adopted++
			x.mu.Unlock()
		case Conflict:
			x.Log.Warn("keyx conflict: kept the key with the smaller fingerprint", "kind", string(w.Kind), "id", w.ID)
		}
	}
	return m.NodeID, nil
}

// Handler serves GET /keyx/v1/keys and POST /keyx/v1/push. The caller's identity is the CN of its verified client
// certificate (VerifyPeer on the listener); only configured peers are answered.
func (x *Exchange) Handler() http.Handler {
	mux := http.NewServeMux()
	allowed := map[string]bool{}
	for _, p := range x.Peers {
		allowed[p.Name] = true
	}
	who := func(r *http.Request) (string, bool) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			return "", false
		}
		cn := r.TLS.PeerCertificates[0].Subject.CommonName
		return cn, allowed[cn]
	}
	mux.HandleFunc("GET /keyx/v1/keys", func(w http.ResponseWriter, r *http.Request) {
		peer, ok := who(r)
		if !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		x.markSeen(peer)
		body, done := x.encode()
		defer done()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(body)
	})
	mux.HandleFunc("POST /keyx/v1/push", func(w http.ResponseWriter, r *http.Request) {
		peer, ok := who(r)
		if !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		defer clear(body)
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if node, err := x.adopt(body); err != nil || node != peer {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		x.markSeen(peer)
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func (x *Exchange) pull(ctx context.Context, p Peer) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.URL+"/keyx/v1/keys", nil)
	resp, err := x.Client.Do(withPeer(req, p.Name))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	defer clear(body)
	if err != nil || resp.StatusCode != http.StatusOK {
		return fmt.Errorf("keyx: pull status %d", resp.StatusCode)
	}
	node, err := x.adopt(body)
	if err != nil {
		return err
	}
	if node != p.Name {
		return errors.New("keyx: peer answered with another node id")
	}
	x.markSeen(p.Name)
	return nil
}

func (x *Exchange) push(ctx context.Context, p Peer) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	body, done := x.encode()
	defer done()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.URL+"/keyx/v1/push", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := x.Client.Do(withPeer(req, p.Name))
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("keyx: push status %d", resp.StatusCode)
	}
	x.markSeen(p.Name)
	return nil
}

func (x *Exchange) pullAll(ctx context.Context) int {
	ok := 0
	for _, p := range x.Peers {
		if err := x.pull(ctx, p); err != nil {
			x.mu.Lock()
			x.pullErrs++
			x.mu.Unlock()
			continue
		}
		ok++
	}
	return ok
}

func (x *Exchange) pushAll(ctx context.Context) {
	for _, p := range x.Peers {
		_ = x.push(ctx, p)
	}
}

// isGenerator: the live node with the lowest node id generates the next keys (§n).
func (x *Exchange) isGenerator() bool {
	names := append(x.livePeers(), x.Node)
	sort.Strings(names)
	return names[0] == x.Node
}

// Maintain runs one maintenance step at the current time; Run calls it every 10 s. Steps (§n, C-04):
//   - start-up: ask every peer and adopt their keys; if none answers and no peer is known alive, generate;
//   - day/mult: at 23:50 UTC the generator creates the next day's keys and pushes them; nodes missing them pull from
//     23:55; at 00:00 the switch happens by time of receipt (keys are looked up by the receipt time's id);
//   - chal: the same at hh:50 for the next hour;
//   - a node that still lacks a key it needs now pulls, and generates only if no peer is live;
//   - keys outside the retention window are destroyed.
func (x *Exchange) Maintain(ctx context.Context) {
	now := x.now().UTC()
	if !x.started {
		x.started = true
		x.pullAll(ctx)
	} else {
		// liveness and gossip: one pull per peer per step keeps lastSeen fresh and heals missed pushes.
		x.pullAll(ctx)
	}
	generatedAny := false
	gen := func(k Kind, id string) {
		created, err := x.Ring.Generate(k, id)
		if err != nil {
			x.Log.Error("keyx: generate failed", "kind", string(k), "error", err.Error())
			return
		}
		if created {
			generatedAny = true
			x.mu.Lock()
			x.generated++
			regen := k == Day && id == DayID(now)
			if regen {
				x.kdayRegen++
			}
			x.mu.Unlock()
			if regen {
				// Not an error, but it changes the day's counts: say so (no key material is logged).
				x.Log.Warn("keyx: generated today's K_day because no peer had it; today's visitors are re-keyed (uniques over-counted)", "day", id)
			}
		}
	}
	alone := len(x.livePeers()) == 0
	// Current keys: generate only when no peer is live (otherwise the next pull adopts the peer's key).
	if !x.Ring.HasCurrent() && (alone || x.isGenerator()) {
		for _, k := range Kinds {
			gen(k, ID(k, now))
		}
	}
	// Next keys, ahead of the switch.
	if x.isGenerator() {
		if now.Minute() >= 50 {
			gen(Chal, ChalID(now.Add(time.Hour)))
		}
		if now.Hour() == 23 && now.Minute() >= 50 {
			tomorrow := DayID(now.Add(24 * time.Hour))
			gen(Day, tomorrow)
			gen(Mult, tomorrow)
		}
	}
	if generatedAny {
		x.pushAll(ctx)
	}
	x.Ring.Prune()
}

// Run calls Maintain every interval until ctx ends.
func (x *Exchange) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			x.Maintain(ctx)
		}
	}
}

type peerKey struct{}

func withPeer(r *http.Request, name string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), peerKey{}, name))
}

// NewClient returns an HTTP client for keyx: TLS 1.3, the node certificate, and a server check that requires a
// certificate chaining to the CA with OU "edge" and CN equal to the peer name the request was made for.
func NewClient(cert tls.Certificate, ca *x509.CertPool) *http.Client {
	tr := &http.Transport{
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   false,
	}
	tr.DialTLSContext = nil
	base := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, InsecureSkipVerify: true} //nolint:gosec // verified in VerifyConnection
	return &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		name, _ := r.Context().Value(peerKey{}).(string)
		cfg := base.Clone()
		cfg.VerifyConnection = func(cs tls.ConnectionState) error { return VerifyPeer(cs, ca, "edge", name) }
		t := tr.Clone()
		t.TLSClientConfig = cfg
		resp, err := t.RoundTrip(r)
		if err != nil {
			t.CloseIdleConnections()
			return nil, err
		}
		resp.Body = closeTransport{resp.Body, t}
		return resp, nil
	}), Timeout: 10 * time.Second}
}

type closeTransport struct {
	io.ReadCloser
	t *http.Transport
}

func (c closeTransport) Close() error {
	err := c.ReadCloser.Close()
	c.t.CloseIdleConnections()
	return err
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// VerifyPeer checks a TLS peer: chain to ca (any extended key usage), exactly one OU equal to role, and — when
// name is not empty — CN equal to name.
func VerifyPeer(cs tls.ConnectionState, ca *x509.CertPool, role, name string) error {
	if len(cs.PeerCertificates) == 0 {
		return errors.New("no peer certificate")
	}
	leaf := cs.PeerCertificates[0]
	inter := x509.NewCertPool()
	for _, c := range cs.PeerCertificates[1:] {
		inter.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: ca, Intermediates: inter, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}); err != nil {
		return err
	}
	if len(leaf.Subject.OrganizationalUnit) != 1 || leaf.Subject.OrganizationalUnit[0] != role {
		return errors.New("peer certificate has the wrong role")
	}
	if name != "" && leaf.Subject.CommonName != name {
		return errors.New("peer certificate names another node")
	}
	return nil
}

// ServerTLS returns the listener configuration: TLS 1.3, client certificates required and verified against ca with
// OU "edge" (the handler then checks the CN against the peer list).
func ServerTLS(cert tls.Certificate, ca *x509.CertPool) *tls.Config {
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAnyClientCert,
		VerifyConnection: func(cs tls.ConnectionState) error {
			return VerifyPeer(cs, ca, "edge", "")
		},
	}
}
