// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testSub = "00000000-0000-0000-0000-000000000001"
	testRG  = "rg-dns"
)

func newServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// fakeAzure serves the instance metadata token endpoint and the Azure DNS record-set API (Get / Create Or Update,
// 2018-05-01) for one zone, with the documented semantics: a missing set is 404, a PUT replaces the whole set.
type fakeAzure struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	sets        map[string]azureProps // "A/<relative>" → properties
	tokens      int                   // tokens issued
	tokenTTL    time.Duration
	imdsDown    bool
	metadataBad int // token requests without "Metadata: true"
	issued      []string
}

var azPath = regexp.MustCompile(`^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.Network/dnsZones/([^/]+)/(A|AAAA)/([^/]+)$`)

func newFakeAzure(t *testing.T) *fakeAzure {
	f := &fakeAzure{t: t, sets: map[string]azureProps{}, tokenTTL: time.Hour}
	f.srv = newServer(t, http.HandlerFunc(f.serve))
	return f
}

func (f *fakeAzure) adapter() *Azure {
	return NewAzure(AzureConfig{Name: "azure-dns", SubscriptionID: testSub, ResourceGroup: testRG,
		Endpoint: f.srv.URL, IMDSEndpoint: f.srv.URL})
}

func (f *fakeAzure) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var k []string
	for x := range f.sets {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}

func (f *fakeAzure) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/metadata/identity/oauth2/token" {
		if r.Header.Get("Metadata") != "true" {
			f.metadataBad++
			http.Error(w, `{"error":"invalid_request","error_description":"bad_request_102"}`, http.StatusBadRequest)
			return
		}
		if f.imdsDown {
			http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		if r.URL.Query().Get("resource") != "https://management.azure.com/" || r.URL.Query().Get("api-version") != "2018-02-01" {
			http.Error(w, "bad query", http.StatusBadRequest)
			return
		}
		f.tokens++
		tok := fmt.Sprintf("tok-secret-%d", f.tokens)
		f.issued = append(f.issued, tok)
		exp := time.Now().Add(f.tokenTTL).Unix()
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": tok, "expires_on": strconv.FormatInt(exp, 10),
			"expires_in": strconv.Itoa(int(f.tokenTTL.Seconds())), "token_type": "Bearer", "resource": "https://management.azure.com/"})
		return
	}
	m := azPath.FindStringSubmatch(r.URL.EscapedPath())
	if m == nil || m[1] != testSub || m[2] != testRG || m[3] != "domain-a.test" || r.URL.Query().Get("api-version") != "2018-05-01" {
		http.Error(w, `{"error":{"code":"InvalidResourceId"}}`, http.StatusBadRequest)
		return
	}
	if len(f.issued) == 0 || r.Header.Get("Authorization") != "Bearer "+f.issued[len(f.issued)-1] {
		http.Error(w, `{"error":{"code":"AuthenticationFailed"}}`, http.StatusUnauthorized)
		return
	}
	key := m[4] + "/" + m[5]
	switch r.Method {
	case http.MethodGet:
		p, ok := f.sets[key]
		if !ok {
			http.Error(w, `{"error":{"code":"NotFound"}}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"name": m[5], "type": "Microsoft.Network/dnszones/" + m[4], "etag": "e1",
			"properties": map[string]any{"TTL": p.TTL, "ARecords": p.ARecords, "AAAARecords": p.AAAARecords, "fqdn": "x."}})
	case http.MethodPut:
		var rs azureRecordSet
		if err := json.NewDecoder(r.Body).Decode(&rs); err != nil || rs.Properties.TTL < 1 {
			http.Error(w, `{"error":{"code":"BadRequest"}}`, http.StatusBadRequest)
			return
		}
		if (m[4] == "A" && len(rs.Properties.AAAARecords) > 0) || (m[4] == "AAAA" && len(rs.Properties.ARecords) > 0) {
			http.Error(w, `{"error":{"code":"BadRequest"}}`, http.StatusBadRequest)
			return
		}
		_, existed := f.sets[key]
		f.sets[key] = rs.Properties
		if existed {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusCreated)
		}
		_, _ = w.Write([]byte(`{}`))
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func TestAzureTokenCachedAndRefreshed(t *testing.T) {
	f := newFakeAzure(t)
	a := f.adapter()
	now := time.Now()
	a.now = func() time.Time { return now }
	ctx := context.Background()
	for range 5 {
		if _, err := a.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	}
	if f.tokens != 1 {
		t.Fatalf("token fetched %d times for 5 calls, want 1 (cached)", f.tokens)
	}
	// 56 minutes later the 1-hour token is inside the refresh window: a new one is fetched
	now = now.Add(56 * time.Minute)
	if _, err := a.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if f.tokens != 2 {
		t.Fatalf("token not refreshed before expiry: %d", f.tokens)
	}
	if f.metadataBad != 0 {
		t.Fatal("a token request went out without Metadata: true")
	}
}

func TestAzureTokenDroppedOn401(t *testing.T) {
	f := newFakeAzure(t)
	a := f.adapter()
	ctx := context.Background()
	if _, err := a.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.issued = append(f.issued, "rotated") // the cached token is no longer accepted
	f.mu.Unlock()
	if _, err := a.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("401 not reported: %v", err)
	}
	if _, err := a.GetRecords(ctx, "domain-a.test", "in.domain-a.test", A); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no new token after 401: %v", err)
	}
}

func TestAzureIMDSFailureNamesNoSecret(t *testing.T) {
	f := newFakeAzure(t)
	f.imdsDown = true
	a := f.adapter()
	err := a.SetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A, 60, []netip.Addr{netip.MustParseAddr("192.0.2.9")})
	if err == nil || !strings.Contains(err.Error(), "managed-identity token") {
		t.Fatalf("IMDS failure: %v", err)
	}
	if strings.Contains(err.Error(), "192.0.2.9") || strings.Contains(err.Error(), "tok-") {
		t.Fatalf("error leaks an address or token: %v", err)
	}
	if len(f.sets) != 0 {
		t.Fatal("written without a token")
	}
}

func TestAzureErrorsNameNoAddressOrToken(t *testing.T) {
	f := newFakeAzure(t)
	a := NewAzure(AzureConfig{Name: "azure-dns", SubscriptionID: testSub, ResourceGroup: "other-rg", Endpoint: f.srv.URL, IMDSEndpoint: f.srv.URL})
	err := a.SetRecords(context.Background(), "domain-a.test", "in.domain-a.test", A, 60, []netip.Addr{netip.MustParseAddr("192.0.2.9")})
	if err == nil || !strings.Contains(err.Error(), "400") {
		t.Fatalf("want a 400: %v", err)
	}
	if strings.Contains(err.Error(), "192.0.2.9") || strings.Contains(err.Error(), "tok-") {
		t.Fatalf("error leaks: %v", err)
	}
	if _, err := a.GetRecords(context.Background(), "domain-a.test", "in.other.test", A); err == nil {
		t.Fatal("name outside the zone accepted")
	}
}

func TestAzureWritesTTLAndRelativeName(t *testing.T) {
	f := newFakeAzure(t)
	a := f.adapter()
	if err := a.SetRecords(context.Background(), "domain-a.test.", "Ingest.Domain-A.test.", A, 45, []netip.Addr{netip.MustParseAddr("192.0.2.1")}); err != nil {
		t.Fatal(err)
	}
	p, ok := f.sets["A/ingest"]
	if !ok || p.TTL != 45 || len(p.ARecords) != 1 || p.ARecords[0].IPv4Address != "192.0.2.1" {
		t.Fatalf("stored %v (keys %v)", p, f.keys())
	}
}

func TestAzureNoProxyForIMDS(t *testing.T) {
	a := NewAzure(AzureConfig{Name: "x", SubscriptionID: testSub, ResourceGroup: testRG})
	if tr, ok := a.imds.Transport.(*http.Transport); !ok || tr.Proxy != nil {
		t.Fatal("the metadata service client must not use a proxy")
	}
	if tr, ok := a.arm.Transport.(*http.Transport); !ok || tr.Proxy == nil {
		t.Fatal("the ARM client must honour the egress proxy")
	}
	if a.cfg.Endpoint != "https://management.azure.com" || a.cfg.IMDSEndpoint != "http://169.254.169.254" {
		t.Fatalf("defaults: %+v", a.cfg)
	}
}
