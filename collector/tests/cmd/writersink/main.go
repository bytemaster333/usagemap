// SPDX-License-Identifier: Apache-2.0
// Command writersink runs the test sink as a stand-alone mutual-TLS writer for
// the Compose tests (two instances behind one DNS name).
//
//	writersink -listen :4319 -admin :8080 -ca ca.crt -cert writer.crt -key writer.key
package main

import (
	"crypto/tls"
	"crypto/x509"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/bytemaster333/usagemap/collector/tests/internal/sink"
)

func main() {
	listen := flag.String("listen", ":4319", "OTLP/HTTP listen address")
	admin := flag.String("admin", ":8080", "admin listen address (GET /records, POST /reset)")
	caFile := flag.String("ca", "", "CA certificate that client certificates must chain to")
	certFile := flag.String("cert", "", "server certificate")
	keyFile := flag.String("key", "", "server key")
	flag.Parse()

	pair, err := tls.LoadX509KeyPair(*certFile, *keyFile)
	if err != nil {
		log.Fatal(err)
	}
	caPEM, err := os.ReadFile(*caFile)
	if err != nil {
		log.Fatal(err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		log.Fatal("no CA certificate")
	}
	s := sink.New(&tls.Config{
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS13,
	})
	go func() {
		srv := &http.Server{Addr: *admin, Handler: s.AdminHandler(), ReadHeaderTimeout: 5 * time.Second}
		log.Fatal(srv.ListenAndServe())
	}()
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("writersink listening on %s (mTLS), admin on %s", *listen, *admin)
	log.Fatal(s.Serve(l))
}
