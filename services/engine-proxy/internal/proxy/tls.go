// SPDX-License-Identifier: Apache-2.0

package proxy

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
)

// TLSFiles names the PEM files of the proxy's listener (C-60: per-node mutual TLS, private CA).
type TLSFiles struct {
	CertFile     string // server certificate chain
	KeyFile      string // server key
	ClientCAFile string // CA bundle that issued the node certificates
	CRLFile      string // optional certificate revocation list (PEM or DER) signed by that CA
}

// TLSReloader keeps the current server TLS configuration; Reload re-reads the files (on SIGHUP), so certificate
// rotation and revocation need no restart (and do not lose the visit-token memory).
//
// A reload takes effect for every caller at once (C-114):
//   - revocation is checked in VerifyConnection, which crypto/tls runs on full handshakes and on resumed sessions;
//   - every loaded configuration has fresh session-ticket keys, so tickets issued before the reload no longer
//     resume and every later connection goes through a full handshake against the new CA and CRL;
//   - connections opened before the reload are closed: idle ones at once, busy ones as soon as their current
//     request has been answered (ConnState must be installed as the http.Server's ConnState hook).
type TLSReloader struct {
	files TLSFiles
	cur   atomic.Pointer[tls.Config]

	mu    sync.Mutex
	conns map[net.Conn]*trackedConn
}

type trackedConn struct {
	state http.ConnState
	stale bool // opened before the latest reload: close when it next becomes idle
}

// NewTLSReloader loads the files once.
func NewTLSReloader(f TLSFiles) (*TLSReloader, error) {
	t := &TLSReloader{files: f, conns: map[net.Conn]*trackedConn{}}
	if err := t.Reload(); err != nil {
		return nil, err
	}
	return t, nil
}

func readCerts(file string) ([]*x509.Certificate, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var out []*x509.Certificate
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, errors.New("no certificate in CA file")
	}
	return out, nil
}

func readCRL(file string, cas []*x509.Certificate) (map[string]bool, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	if blk, _ := pem.Decode(b); blk != nil {
		b = blk.Bytes
	}
	crl, err := x509.ParseRevocationList(b)
	if err != nil {
		return nil, err
	}
	signed := false
	for _, ca := range cas {
		if crl.CheckSignatureFrom(ca) == nil {
			signed = true
			break
		}
	}
	if !signed {
		return nil, errors.New("CRL is not signed by the client CA")
	}
	revoked := make(map[string]bool, len(crl.RevokedCertificateEntries))
	for _, e := range crl.RevokedCertificateEntries {
		revoked[e.SerialNumber.String()] = true
	}
	return revoked, nil
}

// Reload re-reads certificate, key, CA bundle and CRL; on error the previous configuration stays in force.
func (t *TLSReloader) Reload() error {
	cert, err := tls.LoadX509KeyPair(t.files.CertFile, t.files.KeyFile)
	if err != nil {
		return fmt.Errorf("server certificate: %w", err)
	}
	cas, err := readCerts(t.files.ClientCAFile)
	if err != nil {
		return fmt.Errorf("client CA: %w", err)
	}
	pool := x509.NewCertPool()
	for _, c := range cas {
		pool.AddCert(c)
	}
	var revoked map[string]bool
	if t.files.CRLFile != "" {
		if revoked, err = readCRL(t.files.CRLFile, cas); err != nil {
			return fmt.Errorf("CRL: %w", err)
		}
	}
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		NextProtos:   []string{"h2", "http/1.1"},
		// VerifyConnection (not VerifyPeerCertificate) also runs when a session is resumed from a ticket, so a
		// revoked certificate cannot come back through resumption.
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no client certificate")
			}
			if revoked[serial(cs.PeerCertificates[0].SerialNumber)] {
				return errors.New("client certificate revoked")
			}
			return nil
		},
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return fmt.Errorf("session ticket key: %w", err)
	}
	// Explicit keys on the returned configuration take precedence over the listener's own automatic keys
	// (crypto/tls Config.ticketKeys), so tickets issued under an earlier configuration stop resuming.
	cfg.SetSessionTicketKeys([][32]byte{key})
	t.cur.Store(cfg)
	t.closeStale()
	return nil
}

// ConnState is the http.Server ConnState hook: it tracks the listener's connections so that Reload can close them.
func (t *TLSReloader) ConnState(c net.Conn, s http.ConnState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch s {
	case http.StateClosed, http.StateHijacked:
		delete(t.conns, c)
		return
	}
	tc := t.conns[c]
	if tc == nil {
		tc = &trackedConn{}
		t.conns[c] = tc
	}
	tc.state = s
	if s == http.StateIdle && tc.stale {
		_ = c.Close()
	}
}

// closeStale closes every connection that exists now: idle and not yet active ones immediately, busy ones when they
// next become idle (their current request is answered first).
func (t *TLSReloader) closeStale() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for c, tc := range t.conns {
		tc.stale = true
		if tc.state != http.StateActive {
			_ = c.Close()
		}
	}
}

func serial(n *big.Int) string { return n.String() }

// ServerConfig returns a tls.Config that always serves the latest loaded configuration.
func (t *TLSReloader) ServerConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			return t.cur.Load(), nil
		},
	}
}

// ClientConfig builds a mutual-TLS client configuration from PEM files (used by umami-bootstrap and tests).
func ClientConfig(certFile, keyFile, caFile, serverName string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("client certificate: %w", err)
	}
	cas, err := readCerts(caFile)
	if err != nil {
		return nil, fmt.Errorf("CA: %w", err)
	}
	pool := x509.NewCertPool()
	for _, c := range cas {
		pool.AddCert(c)
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		ServerName:   serverName,
	}, nil
}
