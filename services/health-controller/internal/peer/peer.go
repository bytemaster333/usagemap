// SPDX-License-Identifier: Apache-2.0

// Package peer exchanges round results between the two controller instances (C-92). The API is internal (mesh,
// mutual TLS in production): GET /internal/v1/rounds/{round} → 200 {"instance":"…","round":N,"results":[…]} | 404.
// Results hold node ids, a boolean and a closed reason word — nothing else.
package peer

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/prober"
)

// Payload is the response body.
type Payload struct {
	Instance string          `json:"instance"`
	Round    int64           `json:"round"`
	Results  []prober.Result `json:"results"`
}

// Handler serves this instance's results.
func Handler(instance string, get func(round int64) ([]prober.Result, bool)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		round, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/internal/v1/rounds/"), 10, 64)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		res, ok := get(round)
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Payload{Instance: instance, Round: round, Results: res})
	})
}

// Client fetches a peer's results.
type Client struct {
	Base   string // https://hc-core-b:9470
	Client *http.Client
}

// Name is the peer's base URL host.
func (c *Client) Name() string {
	s := strings.TrimPrefix(strings.TrimPrefix(c.Base, "https://"), "http://")
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	return s
}

// Fetch returns the peer's results for a round.
func (c *Client) Fetch(ctx context.Context, round int64) ([]prober.Result, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.Base, "/")+"/internal/v1/rounds/"+strconv.FormatInt(round, 10), nil)
	if err != nil {
		return nil, false
	}
	resp, err := c.Client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, false
	}
	var p Payload
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&p); err != nil || p.Round != round {
		return nil, false
	}
	return p.Results, true
}
