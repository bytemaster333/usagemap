// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
)

const cfToken = "cf-secret-token"

// fakeCloudflare serves the documented parts of the Cloudflare API v4: zone lookup by name, record list filtered by
// type and name.exact, and the batch endpoint applied in one transaction (deletes → patches → puts → posts; any
// failure → nothing changes).
type fakeCloudflare struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	records     map[string]CFRecord // id → record (zone z1 only)
	next        int
	zoneLookups int
	batches     int
	proxiedSeen bool
	failBatch   bool
	totalPages  int
}

func newFakeCloudflare(t *testing.T) *fakeCloudflare {
	f := &fakeCloudflare{t: t, records: map[string]CFRecord{}, totalPages: 1}
	f.srv = newServer(t, http.HandlerFunc(f.serve))
	return f
}

func (f *fakeCloudflare) adapter() *Cloudflare {
	return NewCloudflare(CloudflareConfig{Name: "cloudflare", Endpoint: f.srv.URL, Token: cfToken})
}

func cfReply(w http.ResponseWriter, status int, ok bool, result any, extra map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"success": ok, "errors": []any{}, "messages": []any{}, "result": result}
	if !ok {
		body["errors"] = []map[string]any{{"code": 1004, "message": "DNS Validation Error: content 192.0.2.77 bad"}}
	}
	for k, v := range extra {
		body[k] = v
	}
	_ = json.NewEncoder(w).Encode(body)
}

func (f *fakeCloudflare) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+cfToken {
		cfReply(w, http.StatusForbidden, false, nil, nil)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/zones":
		f.zoneLookups++
		if r.URL.Query().Get("name") == "domain-a.test" {
			cfReply(w, 200, true, []map[string]string{{"id": "z1", "name": "domain-a.test"}}, nil)
		} else {
			cfReply(w, 200, true, []any{}, nil)
		}
	case r.Method == http.MethodGet && r.URL.Path == "/zones/z1/dns_records":
		q := r.URL.Query()
		if q.Get("per_page") != "100" || q.Get("name") != "" {
			cfReply(w, 400, false, nil, nil)
			return
		}
		out := []CFRecord{}
		for _, rec := range f.records {
			if rec.Type == q.Get("type") && strings.EqualFold(rec.Name, q.Get("name.exact")) {
				out = append(out, rec)
			}
		}
		cfReply(w, 200, true, out, map[string]any{"result_info": map[string]int{"page": 1, "total_pages": f.totalPages, "total_count": len(out)}})
	case r.Method == http.MethodPost && r.URL.Path == "/zones/z1/dns_records/batch":
		f.batches++
		var b CFBatch
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			cfReply(w, 400, false, nil, nil)
			return
		}
		work := map[string]CFRecord{}
		for k, v := range f.records {
			work[k] = v
		}
		fail := f.failBatch
		for _, d := range b.Deletes {
			if _, ok := work[d.ID]; !ok {
				fail = true
			}
			delete(work, d.ID)
		}
		for _, p := range append(b.Patches, b.Puts...) {
			if _, ok := work[p.ID]; !ok {
				fail = true
			}
			work[p.ID] = p
		}
		for _, p := range b.Posts {
			if p.Proxied {
				f.proxiedSeen = true
			}
			if p.ID != "" || p.Content == "" || p.TTL < 1 {
				fail = true
			}
			f.next++
			p.ID = fmt.Sprintf("r%d", f.next)
			work[p.ID] = p
		}
		if fail { // one transaction: nothing applied
			cfReply(w, 400, false, nil, nil)
			return
		}
		f.records = work
		cfReply(w, 200, true, map[string]any{}, nil)
	default:
		cfReply(w, 404, false, nil, nil)
	}
}

func (f *fakeCloudflare) set(name, typ, content string, ttl int, proxied bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	id := fmt.Sprintf("r%d", f.next)
	f.records[id] = CFRecord{ID: id, Type: typ, Name: name, Content: content, TTL: ttl, Proxied: proxied}
}

func TestCloudflareZoneCachedAndNoOpWhenEqual(t *testing.T) {
	f := newFakeCloudflare(t)
	c := f.adapter()
	ctx := context.Background()
	want := []netip.Addr{netip.MustParseAddr("192.0.2.1")}
	for range 3 {
		if err := c.SetRecords(ctx, "domain-a.test", "in.domain-a.test", A, 60, want); err != nil {
			t.Fatal(err)
		}
	}
	if f.zoneLookups != 1 {
		t.Fatalf("zone looked up %d times, want 1 (cached)", f.zoneLookups)
	}
	if f.batches != 1 {
		t.Fatalf("%d batches for an unchanged set, want 1", f.batches)
	}
	if _, err := c.GetRecords(ctx, "other.test", "in.other.test", A); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("unknown zone: %v", err)
	}
}

func TestCloudflareFixesProxiedAndTTLAndDuplicates(t *testing.T) {
	f := newFakeCloudflare(t)
	f.set("in.domain-a.test", "A", "192.0.2.1", 60, true) // proxied: must become DNS only
	f.set("in.domain-a.test", "A", "192.0.2.2", 300, false)
	f.set("in.domain-a.test", "A", "192.0.2.3", 60, false)
	f.set("in.domain-a.test", "A", "192.0.2.3", 60, false) // duplicate
	f.set("in.domain-a.test", "AAAA", "2001:db8::1", 60, false)
	c := f.adapter()
	want := []netip.Addr{netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.2"), netip.MustParseAddr("192.0.2.3")}
	if err := c.SetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A, 60, want); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, r := range f.records {
		if r.Type == "A" {
			n++
			if r.Proxied || r.TTL != 60 {
				t.Fatalf("record left proxied or with the wrong TTL: %+v", r)
			}
		}
	}
	if n != 3 {
		t.Fatalf("%d A records, want 3", n)
	}
	if got, _ := c.GetRecords(context.Background(), "domain-a.test", "in.domain-a.test", AAAA); len(got) != 1 {
		t.Fatalf("AAAA set touched: %v", got)
	}
	if f.proxiedSeen {
		t.Fatal("proxied=true sent")
	}
}

func TestCloudflareBatchFailureChangesNothing(t *testing.T) {
	f := newFakeCloudflare(t)
	f.set("in.domain-a.test", "A", "192.0.2.1", 60, false)
	f.failBatch = true
	c := f.adapter()
	err := c.SetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A, 60, []netip.Addr{netip.MustParseAddr("192.0.2.77")})
	if err == nil {
		t.Fatal("failed batch reported as success")
	}
	if strings.Contains(err.Error(), "192.0.2") || strings.Contains(err.Error(), cfToken) {
		t.Fatalf("error leaks an address or the token: %v", err)
	}
	got, gerr := c.GetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A)
	if gerr != nil || !Equal(got, []netip.Addr{netip.MustParseAddr("192.0.2.1")}) {
		t.Fatalf("set changed by a failed batch: %v %v", got, gerr)
	}
}

func TestCloudflareRefusesPartialList(t *testing.T) {
	f := newFakeCloudflare(t)
	f.set("in.domain-a.test", "A", "192.0.2.1", 60, false)
	f.totalPages = 2
	c := f.adapter()
	if _, err := c.GetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A); err == nil || !strings.Contains(err.Error(), "more than one page") {
		t.Fatalf("multi-page list: %v", err)
	}
	if err := c.SetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A, 60, []netip.Addr{netip.MustParseAddr("192.0.2.2")}); err == nil {
		t.Fatal("write on a partial list")
	}
	if f.batches != 0 {
		t.Fatal("batch sent after a partial list")
	}
}

func TestCloudflareWrongToken(t *testing.T) {
	f := newFakeCloudflare(t)
	c := NewCloudflare(CloudflareConfig{Name: "cloudflare", Endpoint: f.srv.URL, Token: "wrong-secret"})
	_, err := c.GetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A)
	if err == nil || !strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "wrong-secret") {
		t.Fatalf("wrong token: %v", err)
	}
}

func TestCloudflareProxyFromEnvironment(t *testing.T) {
	c := NewCloudflare(CloudflareConfig{Name: "x", Token: "t"})
	if tr, ok := c.client.Transport.(*http.Transport); !ok || tr.Proxy == nil {
		t.Fatal("Cloudflare client must honour the egress proxy")
	}
	if c.cfg.Endpoint != "https://api.cloudflare.com/client/v4" {
		t.Fatal(c.cfg.Endpoint)
	}
}
