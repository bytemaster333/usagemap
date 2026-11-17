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
	"sync"
	"time"
)

// Cloudflare DNS (references/dns-provider-apis-2026-11-19.md): Cloudflare has no "replace RRset" call, so a set is
// read with GET /zones/{id}/dns_records?type=…&name.exact=… and replaced with ONE
// POST /zones/{id}/dns_records/batch (deletes → patches → puts → posts, applied in one database transaction: all or
// nothing). The zone id is looked up by name once (GET /zones?name=…) and cached. Records are always written with
// proxied=false: DNS only, no visitor traffic passes through Cloudflare (C-27, C-123). The API token (DNS Write +
// Zone Read on the zones) is read from a file; requests go through the egress proxy (HTTPS_PROXY, C-10).

const cloudflareDefaultAPI = "https://api.cloudflare.com/client/v4"

// CloudflareConfig configures the Cloudflare adapter.
type CloudflareConfig struct {
	Name     string
	Endpoint string // API base URL; default https://api.cloudflare.com/client/v4
	Token    string
	Timeout  time.Duration
}

// Cloudflare is the Cloudflare DNS adapter.
type Cloudflare struct {
	cfg    CloudflareConfig
	client *http.Client

	mu    sync.Mutex
	zones map[string]string // zone name → zone id
}

// NewCloudflare returns a Cloudflare DNS adapter.
func NewCloudflare(c CloudflareConfig) *Cloudflare {
	if c.Endpoint == "" {
		c.Endpoint = cloudflareDefaultAPI
	}
	c.Endpoint = strings.TrimRight(c.Endpoint, "/")
	if c.Timeout == 0 {
		c.Timeout = 10 * time.Second
	}
	return &Cloudflare{
		cfg:    c,
		client: &http.Client{Timeout: c.Timeout, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
		zones:  map[string]string{},
	}
}

// Name of the provider.
func (c *Cloudflare) Name() string { return c.cfg.Name }

type cfMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type cfEnvelope struct {
	Success    bool            `json:"success"`
	Errors     []cfMessage     `json:"errors"`
	Result     json.RawMessage `json:"result"`
	ResultInfo *struct {
		Page       int `json:"page"`
		TotalPages int `json:"total_pages"`
		TotalCount int `json:"total_count"`
	} `json:"result_info"`
}

// CFRecord is a Cloudflare DNS record (the fields the adapter uses).
type CFRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

// CFRecordID names a record to delete in a batch.
type CFRecordID struct {
	ID string `json:"id"`
}

// CFBatch is the body of POST /zones/{id}/dns_records/batch.
type CFBatch struct {
	Deletes []CFRecordID `json:"deletes,omitempty"`
	Patches []CFRecord   `json:"patches,omitempty"`
	Puts    []CFRecord   `json:"puts,omitempty"`
	Posts   []CFRecord   `json:"posts,omitempty"`
}

// call does one request and decodes the envelope; errors name the operation and status only (never the token, never
// record contents — Cloudflare's own error messages may echo record contents, so they are not passed on).
func (c *Cloudflare) call(ctx context.Context, method, path string, body any, op string) (*cfEnvelope, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.Endpoint+path, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %s: %w", c.cfg.Name, op, redactErr(err))
	}
	defer resp.Body.Close()
	var env cfEnvelope
	decErr := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&env)
	if resp.StatusCode/100 != 2 || decErr != nil || !env.Success {
		codes := make([]string, 0, len(env.Errors))
		for _, e := range env.Errors {
			codes = append(codes, fmt.Sprint(e.Code))
		}
		return nil, fmt.Errorf("%s: %s answered %d (error codes %s)", c.cfg.Name, op, resp.StatusCode, strings.Join(codes, ","))
	}
	return &env, nil
}

func (c *Cloudflare) zoneID(ctx context.Context, zone string) (string, error) {
	z := strings.ToLower(strings.TrimSuffix(zone, "."))
	c.mu.Lock()
	id, ok := c.zones[z]
	c.mu.Unlock()
	if ok {
		return id, nil
	}
	env, err := c.call(ctx, http.MethodGet, "/zones?name="+url.QueryEscape(z), nil, "zone lookup "+z)
	if err != nil {
		return "", err
	}
	var zs []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(env.Result, &zs); err != nil {
		return "", fmt.Errorf("%s: zone lookup %s: unreadable answer", c.cfg.Name, z)
	}
	for _, x := range zs {
		if strings.EqualFold(x.Name, z) && x.ID != "" {
			c.mu.Lock()
			c.zones[z] = x.ID
			c.mu.Unlock()
			return x.ID, nil
		}
	}
	return "", fmt.Errorf("%s: zone %s not found for this token", c.cfg.Name, z)
}

func (c *Cloudflare) list(ctx context.Context, zoneID, name string, t Type) ([]CFRecord, error) {
	q := url.Values{"type": {string(t)}, "name.exact": {strings.TrimSuffix(name, ".")}, "per_page": {"100"}}
	env, err := c.call(ctx, http.MethodGet, "/zones/"+url.PathEscape(zoneID)+"/dns_records?"+q.Encode(), nil,
		fmt.Sprintf("list %s %s", name, t))
	if err != nil {
		return nil, err
	}
	if env.ResultInfo != nil && env.ResultInfo.TotalPages > 1 {
		return nil, fmt.Errorf("%s: list %s %s: more than one page of records; refusing to act on a partial set", c.cfg.Name, name, t)
	}
	var recs []CFRecord
	if err := json.Unmarshal(env.Result, &recs); err != nil {
		return nil, fmt.Errorf("%s: list %s %s: unreadable answer", c.cfg.Name, name, t)
	}
	return recs, nil
}

// GetRecords reads one record set (none = ErrNotFound).
func (c *Cloudflare) GetRecords(ctx context.Context, zone, name string, t Type) ([]netip.Addr, error) {
	if t != A && t != AAAA {
		return nil, fmt.Errorf("%s: unsupported type", c.cfg.Name)
	}
	zid, err := c.zoneID(ctx, zone)
	if err != nil {
		return nil, err
	}
	recs, err := c.list(ctx, zid, name, t)
	if err != nil {
		return nil, err
	}
	out := make([]netip.Addr, 0, len(recs))
	for _, r := range recs {
		ad, err := netip.ParseAddr(r.Content)
		if err != nil || checkFamily(t, []netip.Addr{ad}) != nil {
			return nil, fmt.Errorf("%s: %s %s: bad record", c.cfg.Name, name, t)
		}
		out = append(out, ad)
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return Normalize(out), nil
}

// SetRecords replaces one record set with one atomic batch: delete what is not wanted (and any record with the wrong
// TTL or proxied on), post what is missing. Nothing is sent when the set already matches.
func (c *Cloudflare) SetRecords(ctx context.Context, zone, name string, t Type, ttl int, addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return fmt.Errorf("%s: refusing to write an empty record set", c.cfg.Name)
	}
	if err := checkFamily(t, addrs); err != nil {
		return fmt.Errorf("%s: %s %s: %w", c.cfg.Name, name, t, err)
	}
	zid, err := c.zoneID(ctx, zone)
	if err != nil {
		return err
	}
	recs, err := c.list(ctx, zid, name, t)
	if err != nil {
		return err
	}
	want := map[netip.Addr]bool{}
	for _, ad := range Normalize(addrs) {
		want[ad] = true
	}
	var batch CFBatch
	kept := map[netip.Addr]bool{}
	for _, r := range recs {
		ad, perr := netip.ParseAddr(r.Content)
		if perr == nil && want[ad] && !kept[ad] && r.TTL == ttl && !r.Proxied {
			kept[ad] = true
			continue
		}
		batch.Deletes = append(batch.Deletes, CFRecordID{ID: r.ID})
	}
	fqdn := strings.TrimSuffix(name, ".")
	for _, ad := range Normalize(addrs) {
		if !kept[ad] {
			batch.Posts = append(batch.Posts, CFRecord{Type: string(t), Name: fqdn, Content: ad.String(), TTL: ttl, Proxied: false})
		}
	}
	if len(batch.Deletes) == 0 && len(batch.Posts) == 0 {
		return nil
	}
	_, err = c.call(ctx, http.MethodPost, "/zones/"+url.PathEscape(zid)+"/dns_records/batch", batch,
		fmt.Sprintf("batch %s %s", name, t))
	return err
}
