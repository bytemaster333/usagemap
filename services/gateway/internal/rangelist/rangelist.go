// SPDX-License-Identifier: Apache-2.0

// Package rangelist fetches the cloud-provider, Private Relay, Tor-exit and VPN range lists from their publishers
// (C-38) and writes them, per network class, into the local volume the gateway reads (`<dir>/<class>.txt`). The
// lists have no clear redistribution licence: they are never baked into an image or committed. Every fetch logs the
// source's SHA-256; a failed fetch keeps that source's previous list.
package rangelist

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/gateway/internal/netclass"
)

// Source is one published list.
type Source struct {
	Name   string `json:"name"`   // file-name-safe id
	Class  string `json:"class"`  // datacenter | relay | tor | vpn | eyeball_mobile | eyeball_fixed
	URL    string `json:"url"`    // https only
	Format string `json:"format"` // lines | csv | aws-json | gcp-json
}

// Defaults are the publishers' URLs (verified 2026-11; change through the -config file).
var Defaults = []Source{
	{Name: "aws", Class: "datacenter", URL: "https://ip-ranges.amazonaws.com/ip-ranges.json", Format: "aws-json"},
	{Name: "gcp", Class: "datacenter", URL: "https://www.gstatic.com/ipranges/cloud.json", Format: "gcp-json"},
	{Name: "oracle", Class: "datacenter", URL: "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json", Format: "oracle-json"},
	{Name: "digitalocean", Class: "datacenter", URL: "https://digitalocean.com/geo/google.csv", Format: "csv"},
	{Name: "cloudflare-v4", Class: "datacenter", URL: "https://www.cloudflare.com/ips-v4", Format: "lines"},
	{Name: "cloudflare-v6", Class: "datacenter", URL: "https://www.cloudflare.com/ips-v6", Format: "lines"},
	{Name: "apple-private-relay", Class: "relay", URL: "https://mask-api.icloud.com/egress-ip-ranges.csv", Format: "csv"},
	{Name: "tor-exits", Class: "tor", URL: "https://check.torproject.org/torbulkexitlist", Format: "lines"},
}

var reName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Validate checks a source list.
func Validate(srcs []Source) error {
	classes := map[string]bool{}
	for _, c := range netclass.Classes {
		classes[c] = true
	}
	for _, s := range srcs {
		if !reName.MatchString(s.Name) || !classes[s.Class] || !strings.HasPrefix(s.URL, "https://") {
			return fmt.Errorf("invalid source %q", s.Name)
		}
		switch s.Format {
		case "lines", "csv", "aws-json", "gcp-json", "oracle-json":
		default:
			return fmt.Errorf("source %s: unknown format %q", s.Name, s.Format)
		}
	}
	return nil
}

// Parse extracts prefixes from a fetched body.
func Parse(format string, body []byte) ([]netip.Prefix, error) {
	var raw []string
	switch format {
	case "lines":
		sc := bufio.NewScanner(bytes.NewReader(body))
		sc.Buffer(make([]byte, 64<<10), 64<<10)
		for sc.Scan() {
			raw = append(raw, sc.Text())
		}
	case "csv":
		r := csv.NewReader(bytes.NewReader(body))
		r.FieldsPerRecord = -1
		r.Comment = '#'
		for {
			rec, err := r.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if len(rec) > 0 {
				raw = append(raw, rec[0])
			}
		}
	case "aws-json":
		var d struct {
			Prefixes []struct {
				IP string `json:"ip_prefix"`
			} `json:"prefixes"`
			IPv6 []struct {
				IP string `json:"ipv6_prefix"`
			} `json:"ipv6_prefixes"`
		}
		if err := json.Unmarshal(body, &d); err != nil {
			return nil, err
		}
		for _, p := range d.Prefixes {
			raw = append(raw, p.IP)
		}
		for _, p := range d.IPv6 {
			raw = append(raw, p.IP)
		}
	case "gcp-json":
		var d struct {
			Prefixes []struct {
				V4 string `json:"ipv4Prefix"`
				V6 string `json:"ipv6Prefix"`
			} `json:"prefixes"`
		}
		if err := json.Unmarshal(body, &d); err != nil {
			return nil, err
		}
		for _, p := range d.Prefixes {
			raw = append(raw, p.V4, p.V6)
		}
	case "oracle-json":
		var d struct {
			Regions []struct {
				CIDRs []struct {
					CIDR string `json:"cidr"`
				} `json:"cidrs"`
			} `json:"regions"`
		}
		if err := json.Unmarshal(body, &d); err != nil {
			return nil, err
		}
		for _, r := range d.Regions {
			for _, c := range r.CIDRs {
				raw = append(raw, c.CIDR)
			}
		}
	default:
		return nil, fmt.Errorf("unknown format %q", format)
	}
	var out []netip.Prefix
	for _, s := range raw {
		if p, ok := netclass.ParseLine(s); ok {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no ranges in the list")
	}
	return out, nil
}

// Updater writes the lists.
type Updater struct {
	Dir     string
	Sources []Source
	Client  *http.Client
	Log     *slog.Logger
	MaxBody int64
}

// Status of one source after a run.
type Status struct {
	Name, Class, SHA256 string
	Entries             int
	Error               string
	FetchedAt           time.Time
}

func writeAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(f.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// Run fetches every source once, stores per-source lists in <dir>/sources/, then merges them into the class files.
func (u *Updater) Run(ctx context.Context) []Status {
	if u.MaxBody == 0 {
		u.MaxBody = 64 << 20
	}
	srcDir := filepath.Join(u.Dir, "sources")
	_ = os.MkdirAll(srcDir, 0o755)
	var st []Status
	for _, s := range u.Sources {
		res := Status{Name: s.Name, Class: s.Class, FetchedAt: time.Now().UTC()}
		body, err := u.fetch(ctx, s.URL)
		if err == nil {
			sum := sha256.Sum256(body)
			res.SHA256 = hex.EncodeToString(sum[:])
			var ps []netip.Prefix
			if ps, err = Parse(s.Format, body); err == nil {
				var b strings.Builder
				fmt.Fprintf(&b, "# source %s %s sha256 %s fetched %s\n", s.Name, s.URL, res.SHA256, res.FetchedAt.Format(time.RFC3339))
				for _, p := range ps {
					b.WriteString(p.String() + "\n")
				}
				res.Entries = len(ps)
				err = writeAtomic(filepath.Join(srcDir, s.Class+"."+s.Name+".txt"), []byte(b.String()))
			}
		}
		if err != nil {
			res.Error = err.Error()
			u.Log.Warn("range list fetch failed; keeping the previous list", "source", s.Name, "class", s.Class, "error", res.Error)
		} else {
			u.Log.Info("range list fetched", "source", s.Name, "class", s.Class, "sha256", res.SHA256, "entries", res.Entries)
		}
		st = append(st, res)
	}
	if err := u.merge(srcDir); err != nil {
		u.Log.Error("merging range lists failed", "error", err.Error())
	}
	if b, err := json.MarshalIndent(st, "", " "); err == nil {
		_ = writeAtomic(filepath.Join(u.Dir, "sources.json"), b)
	}
	return st
}

func (u *Updater) fetch(ctx context.Context, url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "scf-rangelist-updater/1")
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, u.MaxBody+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > u.MaxBody {
		return nil, errors.New("list too large")
	}
	return b, nil
}

// merge concatenates the per-source files of configured sources into <dir>/<class>.txt.
func (u *Updater) merge(srcDir string) error {
	byClass := map[string][]string{}
	for _, s := range u.Sources {
		byClass[s.Class] = append(byClass[s.Class], filepath.Join(srcDir, s.Class+"."+s.Name+".txt"))
	}
	classes := make([]string, 0, len(byClass))
	for c := range byClass {
		classes = append(classes, c)
	}
	sort.Strings(classes)
	for _, c := range classes {
		var buf bytes.Buffer
		for _, f := range byClass[c] {
			b, err := os.ReadFile(f)
			if err == nil {
				buf.Write(b)
			}
		}
		if buf.Len() == 0 {
			continue
		}
		if err := writeAtomic(filepath.Join(u.Dir, c+".txt"), buf.Bytes()); err != nil {
			return err
		}
	}
	return nil
}
