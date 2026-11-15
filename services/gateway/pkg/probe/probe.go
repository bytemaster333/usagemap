// SPDX-License-Identifier: Apache-2.0

// Package probe is the protocol-level probe client (C-78, wire-formats §o): it behaves like the pinned `standard`
// tracker — fetches a challenge, solves the PBKDF2 proof-of-work, sends one canary page view — and reports whether the
// event was answered 202. Used by `cmd/probe`, the health controller and the operations probes.
package probe

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultUA is a current desktop Chrome User-Agent (a canary must not look like a bot).
const DefaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

// Config of one canary.
type Config struct {
	Target         string // https://ingest-a.example (no trailing slash)
	SiteKey        string // canary site key (22 base62)
	Origin         string // https://<canary domain>, a declared domain of the canary site
	Path           string // /canary/<source>/round
	TrackerVersion string // e.g. 1.0.0
	UA             string
	Client         *http.Client
	// MaxWork refuses challenges above this many PBKDF2 iterations (the tracker's compiled ceiling, 2^24).
	MaxWork int
}

// Result of one canary.
type Result struct {
	Status  int           // status of POST /v1/e (0 when it was not sent)
	Elapsed time.Duration // whole round
	Solve   time.Duration // proof-of-work search
}

// OK reports a 202.
func (r Result) OK() bool { return r.Status == http.StatusAccepted }

func (c *Config) post(ctx context.Context, path string, body any) (int, []byte, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Target+path, bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	h := req.Header
	h.Set("Content-Type", "text/plain;charset=UTF-8")
	h.Set("Origin", c.Origin)
	h.Set("Referer", c.Origin+"/")
	h.Set("User-Agent", c.UA)
	h.Set("Accept", "*/*")
	h.Set("Accept-Language", "en-US,en;q=0.9")
	h.Set("Sec-Fetch-Mode", "cors")
	h.Set("Sec-Fetch-Site", "cross-site")
	h.Set("Sec-Fetch-Dest", "empty")
	resp, err := c.Client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	return resp.StatusCode, rb, nil
}

// Solve searches the counter c in [0, max) whose PBKDF2 key starts with pfx (§b.2).
func Solve(token string, cost, max int, pfxHex string) (uint32, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 92 {
		return 0, false
	}
	pfx, err := hex.DecodeString(pfxHex)
	if err != nil || len(pfx) != 4 {
		return 0, false
	}
	nonce := raw[27:43]
	pw := make([]byte, 0, 30)
	for i := 0; i < max; i++ {
		pw = append(pw[:0], "scf-pow-v1"...)
		pw = append(pw, nonce...)
		pw = binary.BigEndian.AppendUint32(pw, uint32(i))
		k, err := pbkdf2.Key(sha256.New, string(pw), nonce, cost, 32)
		if err == nil && hmac.Equal(k[:4], pfx) {
			return uint32(i), true
		}
	}
	return 0, false
}

func eventID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// Send runs one canary round against one host.
func Send(ctx context.Context, c Config) (Result, error) {
	start := time.Now()
	if c.UA == "" {
		c.UA = DefaultUA
	}
	if c.MaxWork == 0 {
		c.MaxWork = 1 << 24
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 5 * time.Second}
	}
	status, body, err := c.post(ctx, "/v1/c", map[string]any{"v": 1, "s": c.SiteKey, "p": "standard", "tv": c.TrackerVersion})
	if err != nil {
		return Result{Elapsed: time.Since(start)}, err
	}
	if status != http.StatusOK {
		return Result{Elapsed: time.Since(start)}, fmt.Errorf("challenge answered %d", status)
	}
	var ch struct {
		T   string `json:"t"`
		Pow struct {
			Alg  string `json:"alg"`
			Cost int    `json:"cost"`
			Max  int    `json:"max"`
			Pfx  string `json:"pfx"`
		} `json:"pow"`
	}
	if err := json.Unmarshal(body, &ch); err != nil || ch.Pow.Alg != "pbkdf2-sha256" {
		return Result{Elapsed: time.Since(start)}, errors.New("malformed challenge")
	}
	ev := map[string]any{"v": 1, "s": c.SiteKey, "p": "standard", "tv": c.TrackerVersion, "t": ch.T,
		"sg": map[string]any{"wd": 0, "vis": "v", "act": 1},
		"e":  []any{map[string]any{"id": eventID(), "k": "pv", "u": c.Path}}}
	t0 := time.Now()
	if ch.Pow.Cost*ch.Pow.Max <= c.MaxWork {
		if n, ok := Solve(ch.T, ch.Pow.Cost, ch.Pow.Max, ch.Pow.Pfx); ok {
			ev["c"] = n
		}
	}
	solve := time.Since(t0)
	status, _, err = c.post(ctx, "/v1/e", ev)
	return Result{Status: status, Elapsed: time.Since(start), Solve: solve}, err
}

// Round runs the availability round of §o: host A, then host B on failure (one retry), good when a 202 arrives within
// the deadline (2 s).
func Round(ctx context.Context, c Config, hosts []string, deadline time.Duration) (Result, string, bool) {
	ctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	var last Result
	for _, h := range hosts {
		c.Target = strings.TrimRight(h, "/")
		r, err := Send(ctx, c)
		last = r
		if err == nil && r.OK() {
			return r, h, true
		}
	}
	return last, "", false
}
