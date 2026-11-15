// SPDX-License-Identifier: Apache-2.0

// Package testpki issues throwaway certificates for tests: a CA and node certificates with one OU (the role) and
// the node name as CN, like infra/compose/scripts/dev-pki.sh.
package testpki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// CA is a test certificate authority.
type CA struct {
	Cert *x509.Certificate
	Key  *ecdsa.PrivateKey
	PEM  []byte
	Pool *x509.CertPool
}

// NewCA creates a CA.
func NewCA() *CA {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	cert, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	return &CA{Cert: cert, Key: key, PEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), Pool: pool}
}

// Issued is a node certificate.
type Issued struct {
	TLS     tls.Certificate
	CertPEM []byte
	KeyPEM  []byte
}

// Issue creates a certificate with OU=role (omitted when empty), CN=name and the given DNS/IP SANs, usable for
// both client and server authentication.
func (ca *CA) Issue(role, name string, sans ...string) Issued {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 100))
	subj := pkix.Name{CommonName: name}
	if role != "" {
		subj.OrganizationalUnit = []string{role}
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      subj,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	for _, s := range sans {
		if ip := net.ParseIP(s); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else {
			tpl.DNSNames = append(tpl.DNSNames, s)
		}
	}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, ca.Cert, &key.PublicKey, ca.Key)
	kb, _ := x509.MarshalPKCS8PrivateKey(key)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb})
	c, _ := tls.X509KeyPair(certPEM, keyPEM)
	return Issued{TLS: c, CertPEM: certPEM, KeyPEM: keyPEM}
}

// WriteFiles writes cert and key PEMs to dir/<base>.pem and dir/<base>-key.pem and returns the paths.
func (i Issued) WriteFiles(dir, base string) (string, string) {
	c, k := filepath.Join(dir, base+".pem"), filepath.Join(dir, base+"-key.pem")
	_ = os.WriteFile(c, i.CertPEM, 0o644)
	_ = os.WriteFile(k, i.KeyPEM, 0o600)
	return c, k
}
