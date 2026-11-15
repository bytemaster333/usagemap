// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"
)

// Umami's seeded default administrator (public, documented upstream defaults; not secrets). Bootstrap B1 logs in with
// them; B5 asserts that they no longer work (wire-formats §j.2).
const (
	SeedUsername = "admin"
	SeedPassword = "umami"
)

// Gate is the bootstrap gate of wire-formats §c.5 (C-112(7)): after every start the proxy refuses every caller except
// the provisioning worker until a B5 check — POST /api/auth/login with the seed admin's original credentials — has
// been answered 401 by Umami. The gate opens when it sees such a 401, either on the worker's forwarded B5 call or on
// the proxy's own B5 probe (run at start and periodically, so a proxy restart re-checks without waiting for the
// worker). A later 200 for the seed credentials closes it again (for example after a restore of an unbootstrapped
// database).
//
// The proxy's own probe is stricter than the worker's B5 (C-114): the seed credentials are already refused after B2,
// before the provisioning admin exists (B3) and the seed admin is deleted (B4). So the probe opens the gate only
// when the seed login is refused AND the provisioning identity (Provisioner) can sign in. Without Provisioner the
// probe can only close the gate; opening it is then left to the worker's forwarded B5.
type Gate struct {
	// Provisioner is the provisioning identity of §j.1 (B3/P1); nil: the probe never opens the gate.
	Provisioner *Credentials

	open      atomic.Bool
	opened    atomic.Int64 // times opened
	closed    atomic.Int64 // times closed after having been open
	probes    atomic.Int64
	probeErrs atomic.Int64
	lastProbe atomic.Int64 // HTTP status of the last probe (0: transport error)
	lastProv  atomic.Int64 // status of the probe's last provisioning login (0: none yet or transport error; -1: no credentials)
}

// Credentials is a Umami username and password. Never logged.
type Credentials struct {
	Username string
	Password string
}

// IsOpen reports whether non-provisioning callers are let through.
func (g *Gate) IsOpen() bool { return g.open.Load() }

// Observe records Umami's answer to a seed-admin login (B5): 401 opens the gate, 200 closes it, anything else
// changes nothing.
func (g *Gate) Observe(status int) {
	switch status {
	case http.StatusUnauthorized:
		if !g.open.Swap(true) {
			g.opened.Add(1)
		}
	case http.StatusOK:
		if g.open.Swap(false) {
			g.closed.Add(1)
		}
	}
}

// isSeedLogin reports whether a login body carries exactly the seed admin's original credentials.
func isSeedLogin(body []byte) bool {
	var c struct {
		Username *string `json:"username"`
		Password *string `json:"password"`
	}
	if json.Unmarshal(body, &c) != nil || c.Username == nil || c.Password == nil {
		return false
	}
	return *c.Username == SeedUsername && *c.Password == SeedPassword
}

// Probe runs the proxy's own bootstrap check directly against Umami and returns Umami's status for the seed login,
// or 0 on a transport error. A 200 for the seed login closes the gate. A 401 opens it only if the provisioning
// identity then signs in (200); any other outcome leaves the gate as it is. Session tokens in the answers are
// discarded unread.
func (g *Gate) Probe(ctx context.Context, client *http.Client, umami *url.URL) int {
	g.probes.Add(1)
	st := login(ctx, client, umami, SeedUsername, SeedPassword)
	g.lastProbe.Store(int64(st))
	if st == 0 {
		g.probeErrs.Add(1)
		return 0
	}
	switch st {
	case http.StatusOK:
		g.Observe(http.StatusOK)
	case http.StatusUnauthorized:
		if g.IsOpen() {
			break
		}
		p := g.Provisioner
		if p == nil {
			g.lastProv.Store(-1)
			break
		}
		ps := login(ctx, client, umami, p.Username, p.Password)
		g.lastProv.Store(int64(ps))
		if ps == 0 {
			g.probeErrs.Add(1)
		}
		if ps == http.StatusOK {
			g.Observe(http.StatusUnauthorized)
		}
	}
	return st
}

// login posts one /api/auth/login and returns the status (0 on a transport error); the body is drained unread.
func login(ctx context.Context, client *http.Client, umami *url.URL, user, password string) int {
	body, _ := json.Marshal(map[string]string{"username": user, "password": password})
	u := *umami
	u.Path = "/api/auth/login"
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return 0
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", upstreamUA)
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp.StatusCode
}

// Run probes every closedEvery while the gate is closed and every openEvery while it is open, until ctx ends.
func (g *Gate) Run(ctx context.Context, client *http.Client, umami *url.URL, closedEvery, openEvery time.Duration) {
	for {
		g.Probe(ctx, client, umami)
		d := closedEvery
		if g.IsOpen() {
			d = openEvery
		}
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}
