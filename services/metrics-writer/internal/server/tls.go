// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"slices"
	"sync/atomic"
)

// TLSFiles names the PEM files of the OTLP listener (C-60 private CA, per-node mutual TLS; C-107: both writer
// certificates carry the shared name writers.<mesh> in their SAN next to the node name).
type TLSFiles struct {
	CertFile     string   // server certificate chain
	KeyFile      string   // server key
	ClientCAFile string   // CA bundle that issued the node certificates
	CRLFile      string   // optional revocation list (PEM or DER) signed by that CA
	AllowedOUs   []string // accepted client roles (the single OU of a node certificate, C-113); default ["edge"]
}

// TLSReloader holds the current server configuration; Reload re-reads the files (SIGHUP) without a restart.
type TLSReloader struct {
	files TLSFiles
	cur   atomic.Pointer[tls.Config]
}

// NewTLSReloader loads the files once.
func NewTLSReloader(f TLSFiles) (*TLSReloader, error) {
	if len(f.AllowedOUs) == 0 {
		f.AllowedOUs = []string{"edge"}
	}
	t := &TLSReloader{files: f}
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
	allowed := slices.Clone(t.files.AllowedOUs)
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		NextProtos:   []string{"h2", "http/1.1"},
		// VerifyConnection also runs on resumed sessions, so a revoked certificate cannot return through a ticket.
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no client certificate")
			}
			leaf := cs.PeerCertificates[0]
			if revoked[leaf.SerialNumber.String()] {
				return errors.New("client certificate revoked")
			}
			if len(leaf.Subject.OrganizationalUnit) != 1 || !slices.Contains(allowed, leaf.Subject.OrganizationalUnit[0]) {
				return errors.New("client role not allowed")
			}
			return nil
		},
	}
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return fmt.Errorf("session ticket key: %w", err)
	}
	cfg.SetSessionTicketKeys([][32]byte{key}) // tickets of an earlier configuration stop resuming
	t.cur.Store(cfg)
	return nil
}

// ServerConfig returns a tls.Config that always serves the latest loaded configuration.
func (t *TLSReloader) ServerConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		NextProtos: []string{"h2", "http/1.1"},
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			return t.cur.Load(), nil
		},
	}
}
