// SPDX-License-Identifier: Apache-2.0

// Package testpki issues throwaway CAs, node certificates and CRLs for tests (never used in production; the dev
// PKI for Compose is infra/compose/scripts/dev-pki.sh, production certificates come from the IaC, C-60).
package testpki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

var serialCounter atomic.Int64

// CA is a test certificate authority.
type CA struct {
	Cert *x509.Certificate
	Key  crypto.Signer
	PEM  []byte
}

// Leaf is an issued certificate with its key.
type Leaf struct {
	Cert    *x509.Certificate
	CertPEM []byte
	KeyPEM  []byte
}

func key(t testing.TB) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func nextSerial() *big.Int { return big.NewInt(1000 + serialCounter.Add(1)) }

// NewCA returns a self-signed CA.
func NewCA(t testing.TB, name string) *CA {
	t.Helper()
	k := key(t)
	tmpl := &x509.Certificate{
		SerialNumber:          nextSerial(),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &CA{Cert: c, Key: k, PEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

func (ca *CA) issue(t testing.TB, tmpl *x509.Certificate) *Leaf {
	t.Helper()
	k := key(t)
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.Cert, &k.PublicKey, ca.Key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	kb, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return &Leaf{
		Cert:    c,
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}),
	}
}

// Client issues a node (client) certificate: CN = node name, OU = role.
func (ca *CA) Client(t testing.TB, node, role string) *Leaf {
	t.Helper()
	sub := pkix.Name{CommonName: node}
	if role != "" {
		sub.OrganizationalUnit = []string{role}
	}
	return ca.issue(t, &x509.Certificate{
		SerialNumber: nextSerial(),
		Subject:      sub,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	})
}

// Server issues a server certificate for the given DNS names (and 127.0.0.1).
func (ca *CA) Server(t testing.TB, names ...string) *Leaf {
	t.Helper()
	return ca.issue(t, &x509.Certificate{
		SerialNumber: nextSerial(),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
}

// CRL returns a PEM CRL revoking the given certificates.
func (ca *CA) CRL(t testing.TB, revoked ...*x509.Certificate) []byte {
	t.Helper()
	var entries []x509.RevocationListEntry
	for _, c := range revoked {
		entries = append(entries, x509.RevocationListEntry{SerialNumber: c.SerialNumber, RevocationTime: time.Now()})
	}
	der, err := x509.CreateRevocationList(rand.Reader, &x509.RevocationList{
		Number:                    nextSerial(),
		ThisUpdate:                time.Now().Add(-time.Minute),
		NextUpdate:                time.Now().Add(time.Hour),
		RevokedCertificateEntries: entries,
	}, ca.Cert, ca.Key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "X509 CRL", Bytes: der})
}

// Write stores b at dir/name and returns the path.
func Write(t testing.TB, dir, name string, b []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
