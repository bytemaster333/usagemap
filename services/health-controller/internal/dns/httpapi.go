// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// The reference provider API (served by cmd/fake-dns-provider; a real provider adapter maps the same calls onto its
// own API):
//
//	GET  /v1/zones/{zone}/rrsets/{name}/{type}  → 200 {"ttl":60,"records":["192.0.2.1", …]} | 404
//	PUT  /v1/zones/{zone}/rrsets/{name}/{type}  ← {"ttl":60,"records":[…]} → 204
//
// Requests carry "Authorization: Bearer <token>" when a token is configured.

// RRSet is the JSON body of the reference API.
type RRSet struct {
	TTL     int      `json:"ttl"`
	Records []string `json:"records"`
}

// HTTP is the reference REST adapter.
type HTTP struct {
	name     string
	endpoint string
	token    string
	client   *http.Client
}

// NewHTTP returns an adapter for endpoint (no trailing slash needed).
func NewHTTP(name, endpoint, token string, client *http.Client) *HTTP {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &HTTP{name: name, endpoint: strings.TrimRight(endpoint, "/"), token: token, client: client}
}

// Name of the provider.
func (h *HTTP) Name() string { return h.name }

func (h *HTTP) path(zone, name string, t Type) string {
	return fmt.Sprintf("%s/v1/zones/%s/rrsets/%s/%s", h.endpoint, url.PathEscape(zone), url.PathEscape(name), t)
}

func (h *HTTP) do(req *http.Request) (*http.Response, error) {
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	return h.client.Do(req)
}

// GetRecords reads one record set.
func (h *HTTP) GetRecords(ctx context.Context, zone, name string, t Type) ([]netip.Addr, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.path(zone, name, t), nil)
	if err != nil {
		return nil, err
	}
	resp, err := h.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: GET answered %d", h.name, resp.StatusCode)
	}
	var rr RRSet
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rr); err != nil {
		return nil, fmt.Errorf("%s: %w", h.name, err)
	}
	out := make([]netip.Addr, 0, len(rr.Records))
	for _, s := range rr.Records {
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, fmt.Errorf("%s: bad record", h.name)
		}
		out = append(out, a)
	}
	return Normalize(out), nil
}

// SetRecords replaces one record set.
func (h *HTTP) SetRecords(ctx context.Context, zone, name string, t Type, ttl int, addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return fmt.Errorf("%s: refusing to write an empty record set", h.name)
	}
	rr := RRSet{TTL: ttl}
	for _, a := range Normalize(addrs) {
		rr.Records = append(rr.Records, a.String())
	}
	b, _ := json.Marshal(rr)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, h.path(zone, name, t), bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: PUT answered %d", h.name, resp.StatusCode)
	}
	return nil
}
