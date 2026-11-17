// SPDX-License-Identifier: Apache-2.0

// Package config reads the health controller's inventory: edge (and core) nodes, the hostnames whose A/AAAA record
// sets the controller owns (C-27: only the ingest and portal/API sets), and the DNS providers. JSON, so the
// controller needs no YAML dependency; the IaC renders it from the same inventory as the zone files.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"time"
)

// NodeNamePattern is the one node-name pattern used everywhere (C-114).
var NodeNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)

var hostnamePattern = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$|^[a-z0-9-]+\.(test|localhost|internal)$`)

// Node is one probed machine.
type Node struct {
	ID string `json:"id"`
	// IPv4 / IPv6 are the public addresses published in DNS (our infrastructure, not personal data).
	IPv4 string `json:"ipv4,omitempty"`
	IPv6 string `json:"ipv6,omitempty"`
	// HealthURL is the node's health endpoint over the mesh (gateway: GET /healthz on the metrics listener).
	HealthURL string `json:"health_url"`
	// IngestURL is the node's own public origin for the canary event (empty: health check only, e.g. core nodes).
	IngestURL string `json:"ingest_url,omitempty"`
}

// Hostname is one record set pair (A and AAAA) owned by the controller.
type Hostname struct {
	Name  string   `json:"name"`
	Zone  string   `json:"zone"`
	TTL   int      `json:"ttl"`
	Nodes []string `json:"nodes"`
}

// Canary configures the canary event (wire-formats §o) sent to each node.
type Canary struct {
	SiteKey        string `json:"site_key"`
	Origin         string `json:"origin"`
	TrackerVersion string `json:"tracker_version"`
}

// Provider names one DNS provider and how to reach it.
type Provider struct {
	Name string `json:"name"`
	// Kind: "azure" (Azure DNS, managed identity), "cloudflare" (Cloudflare DNS, API token), "http" (the reference
	// REST adapter, used by the fake provider), "memory" (tests). README "Provider adapters".
	Kind string `json:"kind"`
	// Endpoint: the API base URL (required for http; optional for azure and cloudflare, which default to the
	// provider's public API).
	Endpoint string `json:"endpoint,omitempty"`
	// TokenFile holds the provider's API credential (a file, never an environment value). Required for cloudflare;
	// azure takes its token from the instance metadata service (no credential on disk).
	TokenFile string `json:"token_file,omitempty"`
	// SubscriptionID and ResourceGroup locate the Azure DNS zones (kind azure).
	SubscriptionID string `json:"subscription_id,omitempty"`
	ResourceGroup  string `json:"resource_group,omitempty"`
	// IMDSEndpoint overrides the instance metadata service base URL (kind azure; tests only).
	IMDSEndpoint string `json:"imds_endpoint,omitempty"`
}

var (
	guidPattern          = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	resourceGroupPattern = regexp.MustCompile(`^[-\w._()]{1,90}$`)
)

func validURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// Config is the whole file.
type Config struct {
	Instance        string     `json:"instance"`
	Interval        Duration   `json:"interval"`
	ProbeTimeout    Duration   `json:"probe_timeout"`
	FailRounds      int        `json:"fail_rounds"`
	RecoverRounds   int        `json:"recover_rounds"`
	Nodes           []Node     `json:"nodes"`
	Hostnames       []Hostname `json:"hostnames"`
	Providers       []Provider `json:"providers"`
	Canary          *Canary    `json:"canary,omitempty"`
	Peers           []string   `json:"peers"`
	ProviderTimeout Duration   `json:"provider_timeout"`
}

// Duration is a time.Duration written as "30s" in JSON.
type Duration struct{ time.Duration }

// UnmarshalJSON parses "30s".
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	d.Duration = v
	return nil
}

// MarshalJSON writes "30s".
func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

// Load reads and validates a file.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(b)
}

// Parse validates and fills defaults: 30 s rounds, 3 failed rounds to remove, 5 good rounds to re-add (C-92).
func Parse(b []byte) (*Config, error) {
	var c Config
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	if c.Interval.Duration == 0 {
		c.Interval.Duration = 30 * time.Second
	}
	if c.ProbeTimeout.Duration == 0 {
		c.ProbeTimeout.Duration = 5 * time.Second
	}
	if c.ProviderTimeout.Duration == 0 {
		c.ProviderTimeout.Duration = 10 * time.Second
	}
	if c.FailRounds == 0 {
		c.FailRounds = 3
	}
	if c.RecoverRounds == 0 {
		c.RecoverRounds = 5
	}
	return &c, c.validate()
}

func (c *Config) validate() error {
	var errs []error
	if !NodeNamePattern.MatchString(c.Instance) {
		errs = append(errs, errors.New("instance: must match the node-name pattern"))
	}
	if c.Interval.Duration < 200*time.Millisecond || c.ProbeTimeout.Duration >= c.Interval.Duration {
		errs = append(errs, errors.New("interval must be ≥ 200ms and longer than probe_timeout"))
	}
	if c.FailRounds < 1 || c.RecoverRounds < 1 {
		errs = append(errs, errors.New("fail_rounds and recover_rounds must be ≥ 1"))
	}
	nodes := map[string]Node{}
	for _, n := range c.Nodes {
		if !NodeNamePattern.MatchString(n.ID) {
			errs = append(errs, fmt.Errorf("node %q: bad id", n.ID))
		}
		if _, dup := nodes[n.ID]; dup {
			errs = append(errs, fmt.Errorf("node %q: duplicate", n.ID))
		}
		nodes[n.ID] = n
		if n.IPv4 == "" && n.IPv6 == "" {
			errs = append(errs, fmt.Errorf("node %q: needs ipv4 or ipv6", n.ID))
		}
		if n.IPv4 != "" {
			if a, err := netip.ParseAddr(n.IPv4); err != nil || !a.Is4() {
				errs = append(errs, fmt.Errorf("node %q: bad ipv4", n.ID))
			}
		}
		if n.IPv6 != "" {
			if a, err := netip.ParseAddr(n.IPv6); err != nil || !a.Is6() || a.Is4In6() {
				errs = append(errs, fmt.Errorf("node %q: bad ipv6", n.ID))
			}
		}
		if u, err := url.Parse(n.HealthURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, fmt.Errorf("node %q: bad health_url", n.ID))
		}
		if n.IngestURL != "" {
			if u, err := url.Parse(n.IngestURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				errs = append(errs, fmt.Errorf("node %q: bad ingest_url", n.ID))
			}
		}
	}
	if len(c.Hostnames) == 0 {
		errs = append(errs, errors.New("hostnames: at least one"))
	}
	for _, h := range c.Hostnames {
		if !hostnamePattern.MatchString(h.Name) || h.Zone == "" {
			errs = append(errs, fmt.Errorf("hostname %q: bad name or zone", h.Name))
		}
		if h.TTL < 1 || h.TTL > 3600 {
			errs = append(errs, fmt.Errorf("hostname %q: ttl 1…3600", h.Name))
		}
		if len(h.Nodes) == 0 {
			errs = append(errs, fmt.Errorf("hostname %q: no nodes", h.Name))
		}
		for _, id := range h.Nodes {
			if _, ok := nodes[id]; !ok {
				errs = append(errs, fmt.Errorf("hostname %q: unknown node %q", h.Name, id))
			}
		}
	}
	if len(c.Providers) == 0 {
		errs = append(errs, errors.New("providers: at least one (two in production, C-27)"))
	}
	seen := map[string]bool{}
	for _, p := range c.Providers {
		if !NodeNamePattern.MatchString(p.Name) || seen[p.Name] {
			errs = append(errs, fmt.Errorf("provider %q: bad or duplicate name", p.Name))
		}
		seen[p.Name] = true
		switch p.Kind {
		case "http":
			if u, err := url.Parse(p.Endpoint); err != nil || u.Host == "" {
				errs = append(errs, fmt.Errorf("provider %q: bad endpoint", p.Name))
			}
		case "azure":
			if !guidPattern.MatchString(p.SubscriptionID) || !resourceGroupPattern.MatchString(p.ResourceGroup) {
				errs = append(errs, fmt.Errorf("provider %q: azure needs subscription_id (GUID) and resource_group", p.Name))
			}
			if (p.Endpoint != "" && !validURL(p.Endpoint)) || (p.IMDSEndpoint != "" && !validURL(p.IMDSEndpoint)) {
				errs = append(errs, fmt.Errorf("provider %q: bad endpoint", p.Name))
			}
			if p.TokenFile != "" {
				errs = append(errs, fmt.Errorf("provider %q: azure uses the managed identity, not token_file", p.Name))
			}
		case "cloudflare":
			if p.TokenFile == "" {
				errs = append(errs, fmt.Errorf("provider %q: cloudflare needs token_file", p.Name))
			}
			if p.Endpoint != "" && !validURL(p.Endpoint) {
				errs = append(errs, fmt.Errorf("provider %q: bad endpoint", p.Name))
			}
		case "memory":
		default:
			errs = append(errs, fmt.Errorf("provider %q: unknown kind %q", p.Name, p.Kind))
		}
	}
	if c.Canary != nil && (c.Canary.SiteKey == "" || c.Canary.Origin == "") {
		errs = append(errs, errors.New("canary: site_key and origin required"))
	}
	for _, p := range c.Peers {
		if u, err := url.Parse(p); err != nil || u.Host == "" {
			errs = append(errs, fmt.Errorf("peer %q: bad url", p))
		}
	}
	return errors.Join(errs...)
}

// Node returns a node by id.
func (c *Config) Node(id string) (Node, bool) {
	for _, n := range c.Nodes {
		if n.ID == id {
			return n, true
		}
	}
	return Node{}, false
}
