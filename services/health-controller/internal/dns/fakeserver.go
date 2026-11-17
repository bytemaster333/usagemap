// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
)

// FakeServer serves the reference provider API from memory (tests and the Compose overlay). POST /admin/down and
// /admin/up switch the API off and on (503) so a test can take one provider down; GET /admin/sets dumps all sets.
type FakeServer struct {
	Token string
	mu    sync.Mutex
	sets  map[string]RRSet
	down  atomic.Bool
	puts  atomic.Int64
}

// NewFakeServer returns an empty server.
func NewFakeServer(token string) *FakeServer {
	return &FakeServer{Token: token, sets: map[string]RRSet{}}
}

// SetDown switches the API off or on.
func (f *FakeServer) SetDown(v bool) { f.down.Store(v) }

// Puts counts successful writes.
func (f *FakeServer) Puts() int64 { return f.puts.Load() }

// Seed writes a set.
func (f *FakeServer) Seed(zone, name string, t Type, ttl int, addrs ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sets[zone+"|"+name+"|"+string(t)] = RRSet{TTL: ttl, Records: addrs}
}

// Get returns a set (tests).
func (f *FakeServer) Get(zone, name string, t Type) (RRSet, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rr, ok := f.sets[zone+"|"+name+"|"+string(t)]
	return rr, ok
}

func (f *FakeServer) authorised(r *http.Request) bool {
	if f.Token == "" {
		return true
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(f.Token)) == 1
}

// ServeHTTP implements the API.
func (f *FakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/healthz":
		w.WriteHeader(http.StatusOK)
		return
	case strings.HasPrefix(r.URL.Path, "/admin/"):
		f.admin(w, r)
		return
	}
	if !f.authorised(r) {
		http.Error(w, "unauthorised", http.StatusUnauthorized)
		return
	}
	if f.down.Load() {
		http.Error(w, "provider down", http.StatusServiceUnavailable)
		return
	}
	// /v1/zones/{zone}/rrsets/{name}/{type}
	parts := strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/"), "/")
	if len(parts) != 6 || parts[0] != "v1" || parts[1] != "zones" || parts[3] != "rrsets" {
		http.NotFound(w, r)
		return
	}
	t := Type(parts[5])
	if t != A && t != AAAA {
		http.Error(w, "type", http.StatusBadRequest)
		return
	}
	k := parts[2] + "|" + parts[4] + "|" + string(t)
	switch r.Method {
	case http.MethodGet:
		f.mu.Lock()
		rr, ok := f.sets[k]
		f.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rr)
	case http.MethodPut:
		var rr RRSet
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&rr); err != nil || len(rr.Records) == 0 {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		for _, s := range rr.Records {
			a, err := netip.ParseAddr(s)
			if err != nil || (t == A) != a.Is4() {
				http.Error(w, "bad record", http.StatusBadRequest)
				return
			}
		}
		f.mu.Lock()
		f.sets[k] = rr
		f.mu.Unlock()
		f.puts.Add(1)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (f *FakeServer) admin(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/admin/down":
		f.SetDown(true)
	case r.Method == http.MethodPost && r.URL.Path == "/admin/up":
		f.SetDown(false)
	case r.Method == http.MethodGet && r.URL.Path == "/admin/sets":
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.sets)
		return
	default:
		http.NotFound(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
