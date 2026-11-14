// SPDX-License-Identifier: Apache-2.0
// Package pki issues a throw-away private CA, writer server certificates and
// node client certificates for the Collector → writer mutual-TLS tests (C-60).
package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// CA is an in-memory certificate authority.
type CA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	PEM  []byte
}

// NewCA creates a CA valid for one day.
func NewCA(name string) (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &CA{cert: cert, key: key, PEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}, nil
}

func serial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	return n
}

// Leaf is an issued certificate with its key, PEM-encoded.
type Leaf struct {
	CertPEM, KeyPEM []byte
}

// Issue creates a leaf certificate. server selects ExtKeyUsageServerAuth
// (else ClientAuth); names are DNS names or IP literals for the SAN.
func (ca *CA) Issue(cn string, server bool, names ...string) (*Leaf, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	if server {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, n)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	return &Leaf{
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}),
	}, nil
}

// ServerTLS is the writer side: present srv, require a client certificate
// issued by the CA.
func (ca *CA) ServerTLS(srv *Leaf) (*tls.Config, error) {
	pair, err := tls.X509KeyPair(srv.CertPEM, srv.KeyPEM)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	return &tls.Config{
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// Files are the paths written by WriteFiles.
type Files struct {
	CA, ServerCert, ServerKey, ClientCert, ClientKey string
}

// WriteFiles writes the CA, a writer certificate for serverNames and a node
// client certificate into dir (keys 0600, readable by any uid in tests when
// world is true — containers run as another user).
func (ca *CA) WriteFiles(dir string, world bool, serverNames ...string) (Files, *Leaf, error) {
	srv, err := ca.Issue("writer", true, serverNames...)
	if err != nil {
		return Files{}, nil, err
	}
	cli, err := ca.Issue("edge-node", false)
	if err != nil {
		return Files{}, nil, err
	}
	f := Files{
		CA: filepath.Join(dir, "ca.crt"), ServerCert: filepath.Join(dir, "writer.crt"), ServerKey: filepath.Join(dir, "writer.key"),
		ClientCert: filepath.Join(dir, "node.crt"), ClientKey: filepath.Join(dir, "node.key"),
	}
	keyMode := os.FileMode(0o600)
	if world {
		keyMode = 0o644
	}
	for path, b := range map[string][]byte{f.CA: ca.PEM, f.ServerCert: srv.CertPEM, f.ClientCert: cli.CertPEM} {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			return Files{}, nil, err
		}
	}
	for path, b := range map[string][]byte{f.ServerKey: srv.KeyPEM, f.ClientKey: cli.KeyPEM} {
		if err := os.WriteFile(path, b, keyMode); err != nil {
			return Files{}, nil, err
		}
		if err := os.Chmod(path, keyMode); err != nil {
			return Files{}, nil, fmt.Errorf("chmod %s: %w", path, err)
		}
	}
	return f, srv, nil
}
