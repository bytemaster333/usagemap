// SPDX-License-Identifier: Apache-2.0

// Command fake-dns-provider serves the reference DNS provider API from memory (tests and the Compose overlay; never
// production). POST /admin/down and /admin/up simulate a provider API outage.
//
//	fake-dns-provider -listen :8053 [-token-file /run/secrets/dns_token] [-seed zone|name|A|60|192.0.2.1,192.0.2.2]…
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/bytemaster333/usagemap/services/health-controller/internal/dns"
)

type seeds []string

func (s *seeds) String() string     { return strings.Join(*s, " ") }
func (s *seeds) Set(v string) error { *s = append(*s, v); return nil }

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		c := &http.Client{Timeout: 2 * time.Second}
		addr := "http://127.0.0.1:8053/healthz"
		if len(os.Args) > 2 {
			addr = os.Args[2]
		}
		resp, err := c.Get(addr)
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}
	listen := flag.String("listen", ":8053", "listen address")
	tokenFile := flag.String("token-file", "", "bearer token file (optional)")
	var sd seeds
	flag.Var(&sd, "seed", "zone|name|type|ttl|addr,addr (repeatable)")
	flag.Parse()
	token := ""
	if *tokenFile != "" {
		b, err := os.ReadFile(*tokenFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		token = strings.TrimSpace(string(b))
	}
	f := dns.NewFakeServer(token)
	for _, s := range sd {
		p := strings.Split(s, "|")
		if len(p) != 5 {
			fmt.Fprintln(os.Stderr, "bad -seed", s)
			os.Exit(2)
		}
		ttl, _ := strconv.Atoi(p[3])
		f.Seed(p[0], p[1], dns.Type(p[2]), ttl, strings.Split(p[4], ",")...)
	}
	slog.Info("fake dns provider listening", "addr", *listen)
	srv := &http.Server{Addr: *listen, Handler: f, ReadHeaderTimeout: 5 * time.Second}
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
