// SPDX-License-Identifier: Apache-2.0

package transport

import (
	"context"
	"crypto/tls"
	"net"
	"sync"
)

// State is the fingerprint state of one connection. Safe for concurrent use.
type State struct {
	mu      sync.Mutex
	hello   *Hello
	alpn    string // negotiated protocol
	h2      *H2
	h2Done  bool
	capture []byte
}

// Snapshot is a consistent copy of a connection's fingerprints.
type Snapshot struct {
	Hello *Hello // nil when the connection did not complete a TLS handshake through this listener
	ALPN  string // negotiated application protocol ("h2", "http/1.1" or "")
	H2    *H2    // nil unless HTTP/2 and the first HEADERS frame was parsed
}

// Snapshot returns the current fingerprints.
func (s *State) Snapshot() Snapshot {
	if s == nil {
		return Snapshot{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return Snapshot{Hello: s.hello, ALPN: s.alpn, H2: s.h2}
}

func (s *State) setHello(h Hello) {
	s.mu.Lock()
	if s.hello == nil {
		s.hello = &h
	}
	s.mu.Unlock()
}

// record appends plaintext read from the TLS connection until the first HEADERS frame is parsed.
func (s *State) record(p []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.h2Done || len(p) == 0 {
		return
	}
	room := MaxCapture - len(s.capture)
	if room > len(p) {
		room = len(p)
	}
	s.capture = append(s.capture, p[:room]...)
	h, done, ok := ParseH2(s.capture)
	if done || len(s.capture) >= MaxCapture {
		s.h2Done = true
		if ok && done {
			s.h2 = &h
		}
		clear(s.capture)
		s.capture = nil
	}
}

type ctxKey struct{}

// FromContext returns the connection state stored by ConnContext (nil when absent, e.g. plaintext listener).
func FromContext(ctx context.Context) *State {
	s, _ := ctx.Value(ctxKey{}).(*State)
	return s
}

// ConnContext is an http.Server ConnContext hook: it makes the connection's State reachable from requests.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	if tc, ok := c.(*Conn); ok {
		return context.WithValue(ctx, ctxKey{}, tc.state)
	}
	return ctx
}

// rawConn carries the state pointer into GetConfigForClient (ClientHelloInfo.Conn is the conn given to tls.Server).
type rawConn struct {
	net.Conn
	state *State
}

// Conn is a server-side TLS connection whose first plaintext bytes are inspected for the HTTP/2 preface. It is
// deliberately not a *tls.Conn: net/http then serves it as a cleartext connection (HTTP/1.1, or HTTP/2 with prior
// knowledge after the preface — enable Protocols.SetUnencryptedHTTP2), while TLS and ALPN are handled here.
type Conn struct {
	*tls.Conn
	state *State
	once  sync.Once
}

// Read reads plaintext and feeds the HTTP/2 preface parser until it is done.
func (c *Conn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.once.Do(func() {
		c.state.mu.Lock()
		c.state.alpn = c.Conn.ConnectionState().NegotiatedProtocol
		if c.state.alpn != "h2" {
			c.state.h2Done = true
		}
		c.state.mu.Unlock()
	})
	if n > 0 {
		c.state.record(p[:n])
	}
	return n, err
}

// State returns the connection's fingerprint state.
func (c *Conn) State() *State { return c.state }

// NetConn returns the underlying TLS connection (for callers that need the TLS state).
func (c *Conn) NetConn() net.Conn { return c.Conn }

// Listener terminates TLS itself so that the ClientHello and the HTTP/2 preface can be fingerprinted.
type Listener struct {
	net.Listener
	config *tls.Config
}

// NewListener wraps inner. base must carry certificates (Certificates or GetCertificate); its GetConfigForClient is
// replaced, NextProtos defaults to h2 and http/1.1.
func NewListener(inner net.Listener, base *tls.Config) *Listener {
	cfg := base.Clone()
	if len(cfg.NextProtos) == 0 {
		cfg.NextProtos = []string{"h2", "http/1.1"}
	}
	cfg.GetConfigForClient = func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
		if rc, ok := chi.Conn.(*rawConn); ok {
			rc.state.setHello(FromClientHello(chi))
		}
		return nil, nil
	}
	return &Listener{Listener: inner, config: cfg}
}

// Accept returns a *Conn; the handshake runs on the first Read (in the connection's own goroutine).
func (l *Listener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	st := &State{}
	return &Conn{Conn: tls.Server(&rawConn{Conn: c, state: st}, l.config), state: st}, nil
}

// ContextWith returns ctx carrying a fixed fingerprint state (other listeners in front of the handler, and tests).
func ContextWith(ctx context.Context, s Snapshot) context.Context {
	st := &State{hello: s.Hello, alpn: s.ALPN, h2: s.H2, h2Done: true}
	return context.WithValue(ctx, ctxKey{}, st)
}
