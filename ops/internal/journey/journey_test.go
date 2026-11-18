// SPDX-License-Identifier: Apache-2.0

package journey

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const tenant = "7a1d1f8e-4e1f-4b39-9a51-0f0a8f1d2c33"

// fakeAPI checks the SEP-53 signature exactly as the control plane does (services/control-plane/src/auth/stellar.ts).
func fakeAPI(t *testing.T, pageviews int, slow time.Duration, fresh ...int) *httptest.Server {
	var account, message string
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := strings.Contains(r.Header.Get("Cookie"), "__Host-scf_session=tok")
		switch r.URL.Path {
		case "/v1/auth/stellar/challenge":
			if r.Header.Get("X-Scf-Request") != "1" || r.Header.Get("Origin") != "https://portal.test" {
				w.WriteHeader(403)
				return
			}
			var b struct{ Account string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			account, message = b.Account, "portal.test wants you to sign in with "+b.Account+" nonce 1"
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]string{"challenge_id": "c1", "method": "sep53", "message": message})
		case "/v1/auth/stellar/verify":
			var b struct{ ChallengeID, Signature string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			raw, _ := b32.DecodeString(account)
			sig, _ := base64.StdEncoding.DecodeString(b.Signature)
			h := sha256.Sum256([]byte("Stellar Signed Message:\n" + message))
			if len(raw) != 35 || !ed25519.Verify(raw[1:33], h[:], sig) {
				w.WriteHeader(401)
				return
			}
			http.SetCookie(w, &http.Cookie{Name: "__Host-scf_session", Value: "tok", Path: "/", Secure: true, HttpOnly: true})
			_, _ = w.Write([]byte(`{}`))
		case "/v1/me/tenants":
			if !auth {
				w.WriteHeader(401)
				return
			}
			_, _ = w.Write([]byte(`[{"tenant_id":"` + tenant + `","slug":"canary-a","name":"Canary A"}]`))
		case "/v1/tenants/" + tenant + "/sites/s1/web/stats":
			time.Sleep(slow)
			q := r.URL.Query()
			if auth && q.Get("range") == "custom" && len(fresh) > 0 {
				from, e1 := time.Parse(time.RFC3339, q.Get("start"))
				to, e2 := time.Parse(time.RFC3339, q.Get("end"))
				if e1 != nil || e2 != nil || to.Sub(from) != 15*time.Minute || time.Since(to) > time.Minute {
					w.WriteHeader(400)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"raw": map[string]int{"pageviews": fresh[0]}})
				return
			}
			if !auth || q.Get("range") != "24h" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"raw": map[string]int{"pageviews": pageviews}, "verified": map[string]int{"pageviews": pageviews}})
		case "/op/v1/me":
			if r.Header.Get("Authorization") != "Bearer scfa_op_x" {
				w.WriteHeader(401)
				return
			}
			_, _ = w.Write([]byte(`{"key_id":"x"}`))
		case "/v1/auth/logout":
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
}

func seed() string {
	s := make([]byte, 32)
	for i := range s {
		s[i] = byte(i)
	}
	return EncodeSeed(s)
}

func TestStrKeyRoundTrip(t *testing.T) {
	k, err := DecodeSeed(seed())
	if err != nil {
		t.Fatal(err)
	}
	g := AccountID(k.Public().(ed25519.PublicKey))
	if len(g) != 56 || g[0] != 'G' || seed()[0] != 'S' {
		t.Fatalf("%s", g)
	}
	bad := []byte(seed())
	bad[10] ^= 1
	if _, err := DecodeSeed(string(bad)); err == nil {
		t.Fatal("checksum not verified")
	}
	if _, err := DecodeSeed(g); err == nil {
		t.Fatal("account id accepted as seed")
	}
}

func TestJourney(t *testing.T) {
	cfg := func(url string) Config {
		return Config{API: url, PortalOrigin: "https://portal.test", Seed: seed(), TenantID: tenant, SiteID: "s1",
			OpKey: "scfa_op_x", RequireData: true, StepLimit: 500 * time.Millisecond}
	}
	ok := fakeAPI(t, 12, 0)
	defer ok.Close()
	if r := Run(context.Background(), cfg(ok.URL)); !r.OK {
		t.Fatalf("%+v", r)
	}
	empty := fakeAPI(t, 0, 0)
	defer empty.Close()
	if r := Run(context.Background(), cfg(empty.URL)); r.OK || r.Step != "web_overview" {
		t.Fatalf("empty data must fail: %+v", r)
	}
	slow := fakeAPI(t, 12, time.Second)
	defer slow.Close()
	if r := Run(context.Background(), cfg(slow.URL)); r.OK || r.Step != "web_overview" {
		t.Fatalf("slow step must fail: %+v", r)
	}
	c := cfg(ok.URL)
	c.TenantID = "00000000-0000-0000-0000-000000000000"
	if r := Run(context.Background(), c); r.OK || r.Step != "tenants" {
		t.Fatalf("wrong tenant must fail: %+v", r)
	}
}

func TestJourneyFreshness(t *testing.T) {
	cfg := func(url string) Config {
		return Config{API: url, PortalOrigin: "https://portal.test", Seed: seed(), TenantID: tenant, SiteID: "s1",
			RequireData: true, FreshWithin: 15 * time.Minute, StepLimit: 500 * time.Millisecond}
	}
	fresh := fakeAPI(t, 12, 0, 3)
	defer fresh.Close()
	if r := Run(context.Background(), cfg(fresh.URL)); !r.OK {
		t.Fatalf("fresh data must pass: %+v", r)
	}
	stale := fakeAPI(t, 12, 0, 0) // page views in the last 24 h, none in the last 15 minutes
	defer stale.Close()
	if r := Run(context.Background(), cfg(stale.URL)); r.OK || r.Step != "freshness" {
		t.Fatalf("stale data must fail at freshness: %+v", r)
	}
}
