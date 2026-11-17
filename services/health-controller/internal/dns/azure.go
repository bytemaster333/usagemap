// SPDX-License-Identifier: Apache-2.0

package dns

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Azure DNS (Record Sets – Get / Create Or Update, api-version 2018-05-01; references/dns-provider-apis-2026-11-19.md):
//
//	GET|PUT {endpoint}/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Network/dnsZones/{zone}/{A|AAAA}/{relative}
//	  body {"properties":{"TTL":60,"ARecords":[{"ipv4Address":"…"}]}} (AAAA: AAAARecords[].ipv6Address)
//
// A PUT without If-Match replaces the whole record set atomically. The bearer token is the VM's managed identity,
// fetched from the instance metadata service (never through a proxy) and cached until shortly before it expires; no
// credential exists on disk. The identity needs Microsoft.Network/dnsZones/read and …/A/*, …/AAAA/* on the zones.

const (
	azureAPIVersion     = "2018-05-01"
	azureDefaultARM     = "https://management.azure.com"
	azureDefaultIMDS    = "http://169.254.169.254"
	azureTokenResource  = "https://management.azure.com/"
	azureTokenRefreshIn = 5 * time.Minute // refresh this long before expires_on
)

// AzureConfig configures the Azure DNS adapter.
type AzureConfig struct {
	Name           string
	SubscriptionID string
	ResourceGroup  string
	Endpoint       string // ARM base URL; default https://management.azure.com
	IMDSEndpoint   string // instance metadata base URL; default http://169.254.169.254
	Timeout        time.Duration
}

// Azure is the Azure DNS adapter.
type Azure struct {
	cfg  AzureConfig
	arm  *http.Client // through the egress proxy (C-10)
	imds *http.Client // never through a proxy
	now  func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

// NewAzure returns an Azure DNS adapter.
func NewAzure(c AzureConfig) *Azure {
	if c.Endpoint == "" {
		c.Endpoint = azureDefaultARM
	}
	if c.IMDSEndpoint == "" {
		c.IMDSEndpoint = azureDefaultIMDS
	}
	c.Endpoint = strings.TrimRight(c.Endpoint, "/")
	c.IMDSEndpoint = strings.TrimRight(c.IMDSEndpoint, "/")
	if c.Timeout == 0 {
		c.Timeout = 10 * time.Second
	}
	return &Azure{
		cfg:  c,
		arm:  &http.Client{Timeout: c.Timeout, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
		imds: &http.Client{Timeout: c.Timeout, Transport: &http.Transport{Proxy: nil}},
		now:  time.Now,
	}
}

// Name of the provider.
func (a *Azure) Name() string { return a.cfg.Name }

// relativeName is the record set's name inside the zone ("@" for the apex).
func relativeName(zone, name string) (string, error) {
	z := strings.ToLower(strings.TrimSuffix(zone, "."))
	n := strings.ToLower(strings.TrimSuffix(name, "."))
	if n == z {
		return "@", nil
	}
	if !strings.HasSuffix(n, "."+z) {
		return "", errors.New("name is not inside the zone")
	}
	return strings.TrimSuffix(n, "."+z), nil
}

func (a *Azure) url(zone, name string, t Type) (string, error) {
	rel, err := relativeName(zone, name)
	if err != nil {
		return "", fmt.Errorf("%s: zone %s: %w", a.cfg.Name, zone, err)
	}
	return fmt.Sprintf("%s/subscriptions/%s/resourceGroups/%s/providers/Microsoft.Network/dnsZones/%s/%s/%s?api-version=%s",
		a.cfg.Endpoint, url.PathEscape(a.cfg.SubscriptionID), url.PathEscape(a.cfg.ResourceGroup),
		url.PathEscape(strings.TrimSuffix(zone, ".")), t, url.PathEscape(rel), azureAPIVersion), nil
}

// imdsToken is the instance metadata service's answer (expires_on is a string of epoch seconds).
type imdsToken struct {
	AccessToken string `json:"access_token"`
	ExpiresOn   string `json:"expires_on"`
	ExpiresIn   string `json:"expires_in"`
}

func (a *Azure) bearer(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && a.now().Before(a.expires.Add(-azureTokenRefreshIn)) {
		return a.token, nil
	}
	u := a.cfg.IMDSEndpoint + "/metadata/identity/oauth2/token?api-version=2018-02-01&resource=" + url.QueryEscape(azureTokenResource)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Metadata", "true")
	resp, err := a.imds.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s: managed-identity token: %w", a.cfg.Name, redactErr(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return "", fmt.Errorf("%s: managed-identity token: metadata service answered %d", a.cfg.Name, resp.StatusCode)
	}
	var tok imdsToken
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tok); err != nil || tok.AccessToken == "" {
		return "", fmt.Errorf("%s: managed-identity token: unreadable answer", a.cfg.Name)
	}
	exp := a.now().Add(time.Minute) // conservative if neither field parses
	if s, err := strconv.ParseInt(tok.ExpiresOn, 10, 64); err == nil && s > 0 {
		exp = time.Unix(s, 0)
	} else if s, err := strconv.ParseInt(tok.ExpiresIn, 10, 64); err == nil && s > 0 {
		exp = a.now().Add(time.Duration(s) * time.Second)
	}
	a.token, a.expires = tok.AccessToken, exp
	return a.token, nil
}

type azureRecordSet struct {
	Properties azureProps `json:"properties"`
}

type azureProps struct {
	TTL         int         `json:"TTL"`
	ARecords    []azureA    `json:"ARecords,omitempty"`
	AAAARecords []azureAAAA `json:"AAAARecords,omitempty"`
}

type azureA struct {
	IPv4Address string `json:"ipv4Address"`
}

type azureAAAA struct {
	IPv6Address string `json:"ipv6Address"`
}

func (a *Azure) do(ctx context.Context, method, u string, body []byte) (*http.Response, error) {
	tok, err := a.bearer(ctx)
	if err != nil {
		return nil, err
	}
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := a.arm.Do(req)
	if err != nil {
		return nil, redactErr(err)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		a.mu.Lock()
		a.token = "" // a revoked or rotated token: fetch a new one next time
		a.mu.Unlock()
	}
	return resp, nil
}

// GetRecords reads one record set (404 = the set does not exist).
func (a *Azure) GetRecords(ctx context.Context, zone, name string, t Type) ([]netip.Addr, error) {
	if t != A && t != AAAA {
		return nil, fmt.Errorf("%s: unsupported type", a.cfg.Name)
	}
	u, err := a.url(zone, name, t)
	if err != nil {
		return nil, err
	}
	resp, err := a.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, fmt.Errorf("%s: GET %s %s answered %d", a.cfg.Name, name, t, resp.StatusCode)
	}
	var rs azureRecordSet
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rs); err != nil {
		return nil, fmt.Errorf("%s: GET %s %s: unreadable answer", a.cfg.Name, name, t)
	}
	var out []netip.Addr
	for _, r := range rs.Properties.ARecords {
		ad, err := netip.ParseAddr(r.IPv4Address)
		if err != nil || !ad.Is4() || t != A {
			return nil, fmt.Errorf("%s: %s %s: bad record", a.cfg.Name, name, t)
		}
		out = append(out, ad)
	}
	for _, r := range rs.Properties.AAAARecords {
		ad, err := netip.ParseAddr(r.IPv6Address)
		if err != nil || !ad.Is6() || t != AAAA {
			return nil, fmt.Errorf("%s: %s %s: bad record", a.cfg.Name, name, t)
		}
		out = append(out, ad)
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return Normalize(out), nil
}

// SetRecords replaces one record set with one PUT (never empty).
func (a *Azure) SetRecords(ctx context.Context, zone, name string, t Type, ttl int, addrs []netip.Addr) error {
	if len(addrs) == 0 {
		return fmt.Errorf("%s: refusing to write an empty record set", a.cfg.Name)
	}
	if err := checkFamily(t, addrs); err != nil {
		return fmt.Errorf("%s: %s %s: %w", a.cfg.Name, name, t, err)
	}
	rs := azureRecordSet{Properties: azureProps{TTL: ttl}}
	for _, ad := range Normalize(addrs) {
		if t == A {
			rs.Properties.ARecords = append(rs.Properties.ARecords, azureA{IPv4Address: ad.String()})
		} else {
			rs.Properties.AAAARecords = append(rs.Properties.AAAARecords, azureAAAA{IPv6Address: ad.String()})
		}
	}
	b, _ := json.Marshal(rs)
	u, err := a.url(zone, name, t)
	if err != nil {
		return err
	}
	resp, err := a.do(ctx, http.MethodPut, u, b)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("%s: PUT %s %s answered %d", a.cfg.Name, name, t, resp.StatusCode)
	}
	return nil
}

// checkFamily refuses an address of the wrong family for the record type.
func checkFamily(t Type, addrs []netip.Addr) error {
	for _, ad := range addrs {
		switch {
		case t == A && !ad.Is4(), t == AAAA && (!ad.Is6() || ad.Is4In6()):
			return errors.New("address family does not match the record type")
		case t != A && t != AAAA:
			return errors.New("unsupported type")
		}
	}
	return nil
}

// redactErr drops the URL from a transport error (it would carry query strings and hostnames into logs; the token
// is never part of a URL, but keep errors to provider, name, type and status).
func redactErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s request failed: %w", ue.Op, ue.Err)
	}
	return err
}
