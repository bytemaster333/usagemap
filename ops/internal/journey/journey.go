// SPDX-License-Identifier: Apache-2.0

// Package journey is the synthetic signed-in dashboard journey (ADR-0031 SLO-4, C-93): a dedicated synthetic tenant
// member — never a real user — signs in with its own Stellar keypair by SEP-53 (an unfunded account: master key,
// weight 1), loads its tenant list, the canary site's web overview and, when configured, the canary service's API
// overview and the SCF-operator metrics API with a probe-scoped `op` key. Every step must answer 200 within the step
// limit (3 s) with non-empty, correct-tenant data. The secret seed is read from a file, held only in memory and never
// logged; nothing about the responses is stored except the outcome.
package journey

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Config of the journey.
type Config struct {
	API          string // control-plane public origin, e.g. https://api.domain-a
	PortalOrigin string // the Origin the CSRF check expects (SCF_PORTAL_ORIGIN)
	Seed         string // S… secret seed of the synthetic member (from a secret file)
	TenantID     string
	SiteID       string
	ServiceID    string // optional
	OpKey        string // optional scfa_op_… key, scope web:read
	RequireData  bool   // the site must show page views (the canary traffic) in the last 24 h
	// FreshWithin > 0: the site must also show page views inside the last FreshWithin (custom range ending now) —
	// the canary events of this round trip reached the dashboard, i.e. data freshness end to end (C-93, SLO-4).
	FreshWithin time.Duration
	StepLimit   time.Duration
	Client      *http.Client
}

// Result of one journey. Step names the first failing step (closed list) and Status its HTTP status.
type Result struct {
	OK      bool
	Step    string
	Status  int
	Elapsed time.Duration
}

const (
	versionAccount = 6 << 3
	versionSeed    = 18 << 3
	sep53Prefix    = "Stellar Signed Message:\n"
)

func crc16(b []byte) uint16 {
	var crc uint16
	for _, x := range b {
		crc ^= uint16(x) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// DecodeSeed returns the Ed25519 private key of an `S…` StrKey (SEP-23).
func DecodeSeed(s string) (ed25519.PrivateKey, error) {
	raw, err := b32.DecodeString(strings.TrimSpace(s))
	if err != nil || len(raw) != 35 || raw[0] != versionSeed {
		return nil, errors.New("not a secret seed")
	}
	if c := crc16(raw[:33]); raw[33] != byte(c) || raw[34] != byte(c>>8) {
		return nil, errors.New("seed checksum")
	}
	return ed25519.NewKeyFromSeed(raw[1:33]), nil
}

// AccountID encodes a public key as a `G…` StrKey.
func AccountID(pub ed25519.PublicKey) string {
	raw := append([]byte{versionAccount}, pub...)
	c := crc16(raw)
	raw = append(raw, byte(c), byte(c>>8))
	return b32.EncodeToString(raw)
}

// EncodeSeed encodes a 32-byte seed as an `S…` StrKey (tests and key generation).
func EncodeSeed(seed []byte) string {
	raw := append([]byte{versionSeed}, seed...)
	c := crc16(raw)
	raw = append(raw, byte(c), byte(c>>8))
	return b32.EncodeToString(raw)
}

// SignSEP53 signs a message: Ed25519 over SHA-256("Stellar Signed Message:\n" ‖ message).
func SignSEP53(key ed25519.PrivateKey, message string) string {
	h := sha256.Sum256([]byte(sep53Prefix + message))
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, h[:]))
}

type session struct {
	c      *Config
	cookie string
}

func (s *session) do(ctx context.Context, method, path string, body any, auth string) (int, []byte, error) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, s.c.StepLimit)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.c.API, "/")+path, r)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Scf-Request", "1")
		req.Header.Set("Origin", s.c.PortalOrigin)
	}
	if s.cookie != "" {
		req.Header.Set("Cookie", s.cookie)
	}
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	resp, err := s.c.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	for _, sc := range resp.Cookies() {
		if sc.Name == "__Host-scf_session" && sc.Value != "" {
			s.cookie = sc.Name + "=" + sc.Value
		}
	}
	return resp.StatusCode, b, err
}

// Run executes one journey.
func Run(ctx context.Context, c Config) Result {
	start := time.Now()
	if c.StepLimit == 0 {
		c.StepLimit = 3 * time.Second
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: c.StepLimit}
	}
	fail := func(step string, status int) Result {
		return Result{Step: step, Status: status, Elapsed: time.Since(start)}
	}
	key, err := DecodeSeed(c.Seed)
	if err != nil {
		return fail("config", 0)
	}
	s := &session{c: &c}
	account := AccountID(key.Public().(ed25519.PublicKey))

	st, b, err := s.do(ctx, http.MethodPost, "/v1/auth/stellar/challenge", map[string]string{"account": account, "method": "sep53"}, "")
	if err != nil || st != http.StatusCreated {
		return fail("challenge", st)
	}
	var ch struct {
		ChallengeID string `json:"challenge_id"`
		Message     string `json:"message"`
	}
	if json.Unmarshal(b, &ch) != nil || ch.ChallengeID == "" || ch.Message == "" {
		return fail("challenge", st)
	}
	st, _, err = s.do(ctx, http.MethodPost, "/v1/auth/stellar/verify",
		map[string]string{"challenge_id": ch.ChallengeID, "signature": SignSEP53(key, ch.Message)}, "")
	if err != nil || st != http.StatusOK || s.cookie == "" {
		return fail("sign_in", st)
	}

	st, b, err = s.do(ctx, http.MethodGet, "/v1/me/tenants", nil, "")
	if err != nil || st != http.StatusOK {
		return fail("tenants", st)
	}
	var ts []struct {
		TenantID string `json:"tenant_id"`
	}
	var wrapped struct {
		Items []struct {
			TenantID string `json:"tenant_id"`
		} `json:"items"`
	}
	if json.Unmarshal(b, &ts) != nil {
		if json.Unmarshal(b, &wrapped) != nil {
			return fail("tenants", st)
		}
		for _, i := range wrapped.Items {
			ts = append(ts, struct {
				TenantID string `json:"tenant_id"`
			}{i.TenantID})
		}
	}
	found := false
	for _, t := range ts {
		found = found || t.TenantID == c.TenantID
	}
	if !found || len(ts) != 1 { // the synthetic member belongs to its canary tenant only
		return fail("tenants", st)
	}

	if c.SiteID != "" {
		p := fmt.Sprintf("/v1/tenants/%s/sites/%s/web/stats?range=24h", url.PathEscape(c.TenantID), url.PathEscape(c.SiteID))
		st, b, err = s.do(ctx, http.MethodGet, p, nil, "")
		if err != nil || st != http.StatusOK {
			return fail("web_overview", st)
		}
		var ws struct {
			Raw *struct {
				Pageviews *int64 `json:"pageviews"`
			} `json:"raw"`
		}
		if json.Unmarshal(b, &ws) != nil || ws.Raw == nil || ws.Raw.Pageviews == nil || (c.RequireData && *ws.Raw.Pageviews == 0) {
			return fail("web_overview", st)
		}
		if c.FreshWithin > 0 {
			now := time.Now().UTC().Truncate(time.Second)
			q := url.Values{"range": {"custom"}, "start": {now.Add(-c.FreshWithin).Format(time.RFC3339)}, "end": {now.Format(time.RFC3339)}}
			p := fmt.Sprintf("/v1/tenants/%s/sites/%s/web/stats?%s", url.PathEscape(c.TenantID), url.PathEscape(c.SiteID), q.Encode())
			st, b, err = s.do(ctx, http.MethodGet, p, nil, "")
			ws.Raw = nil
			if err != nil || st != http.StatusOK || json.Unmarshal(b, &ws) != nil || ws.Raw == nil || ws.Raw.Pageviews == nil || *ws.Raw.Pageviews == 0 {
				return fail("freshness", st)
			}
		}
	}
	if c.ServiceID != "" {
		p := fmt.Sprintf("/v1/tenants/%s/services/%s/api/summary?range=24h", url.PathEscape(c.TenantID), url.PathEscape(c.ServiceID))
		st, b, err = s.do(ctx, http.MethodGet, p, nil, "")
		if err != nil || st != http.StatusOK || !json.Valid(b) {
			return fail("api_overview", st)
		}
	}
	if c.OpKey != "" {
		op := &session{c: &c}
		st, b, err = op.do(ctx, http.MethodGet, "/op/v1/me", nil, c.OpKey)
		if err != nil || st != http.StatusOK || !json.Valid(b) {
			return fail("operator_api", st)
		}
	}
	_, _, _ = s.do(ctx, http.MethodPost, "/v1/auth/logout", map[string]string{}, "")
	return Result{OK: true, Step: "done", Status: http.StatusOK, Elapsed: time.Since(start)}
}
