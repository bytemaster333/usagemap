// SPDX-License-Identifier: Apache-2.0
// dialtest shows what Go's resolver and dialer do with a name that has two
// addresses in /etc/hosts (item 5B diagnostics). Run inside a container.
package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	host := os.Args[1] // e.g. writers:4319
	h, _, _ := net.SplitHostPort(host)
	addrs, err := net.DefaultResolver.LookupHost(context.Background(), h)
	fmt.Println("LookupHost:", addrs, err)
	c := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < 3; i++ {
		t := time.Now()
		resp, err := c.Get("http://" + host + "/healthz")
		if err != nil {
			fmt.Printf("GET %d after %v: %v\n", i, time.Since(t).Round(time.Millisecond), err)
			continue
		}
		resp.Body.Close()
		fmt.Printf("GET %d after %v: %s\n", i, time.Since(t).Round(time.Millisecond), resp.Status)
	}
	d := net.Dialer{}
	for _, a := range addrs {
		t := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(a, "4319"))
		cancel()
		if err == nil {
			conn.Close()
		}
		fmt.Printf("dial %s after %v: err=%v\n", a, time.Since(t).Round(time.Millisecond), err)
	}
}
