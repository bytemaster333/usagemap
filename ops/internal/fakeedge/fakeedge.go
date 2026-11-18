// SPDX-License-Identifier: Apache-2.0

// Package fakeedge (copy of services/health-controller/internal/fakeedge) is a stand-in edge node for tests: GET /healthz, and the tracker protocol's challenge (/v1/c) and
// event (/v1/e) endpoints with a real PBKDF2 proof-of-work, so the gateway's probe client runs unmodified against it.
// It can be switched off (connection refused is simulated by closing the listener in the caller) or made unhealthy.
package fakeedge

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"sync/atomic"
)

// Edge is the handler.
type Edge struct {
	Unhealthy  atomic.Bool // /healthz answers 503
	RejectAll  atomic.Bool // /v1/e answers 503
	Events     atomic.Int64
	Challenges atomic.Int64
}

const cost = 2

// ServeHTTP implements the endpoints.
func (e *Edge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/healthz":
		if e.Unhealthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodPost && r.URL.Path == "/v1/c":
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 8<<10))
		var raw [92]byte
		_, _ = rand.Read(raw[:])
		nonce := raw[27:43]
		// The prefix of counter 0, so the solver finds it at once.
		pw := append([]byte("scf-pow-v1"), nonce...)
		pw = binary.BigEndian.AppendUint32(pw, 0)
		k, _ := pbkdf2.Key(sha256.New, string(pw), nonce, cost, 32)
		e.Challenges.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"t":   base64.RawURLEncoding.EncodeToString(raw[:]),
			"pow": map[string]any{"alg": "pbkdf2-sha256", "cost": cost, "max": 4, "pfx": hex.EncodeToString(k[:4])},
		})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/e":
		var ev struct {
			C *uint32 `json:"c"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&ev); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if e.RejectAll.Load() || ev.C == nil || *ev.C != 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		e.Events.Add(1)
		w.WriteHeader(http.StatusAccepted)
	default:
		http.NotFound(w, r)
	}
}
